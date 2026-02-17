import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import inspector from 'node:inspector';
import os from 'node:os';
import v8 from 'node:v8';
import { sendErrorResponse, sendResponse } from "../utils.js";
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const profilerBaseDir = process.env['NODELINK_PROFILER_DIR'] || '.profiles';
let activeMasterCpu = null;
let activeMasterHeapSampling = null;
function getEndpointConfig(nodelink) {
    const endpoint = nodelink.options?.cluster?.endpoint || {};
    const code = typeof endpoint.code === 'string' && endpoint.code.length > 0
        ? endpoint.code
        : 'CAPYBARA';
    return {
        patchEnabled: endpoint.patchEnabled === true,
        allowExternalPatch: endpoint.allowExternalPatch === true,
        code
    };
}
function normalizeNumber(value) {
    if (typeof value === 'number' && Number.isInteger(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isInteger(parsed))
            return parsed;
    }
    return null;
}
function resolveWorkerId(manager, payload) {
    const clusterId = normalizeNumber(payload.clusterId ?? payload.workerId);
    if (clusterId !== null && manager.workersById.has(clusterId)) {
        return clusterId;
    }
    const uniqueId = normalizeNumber(payload.id);
    if (uniqueId !== null) {
        for (const [id, workerUniqueId] of manager.workerUniqueId.entries()) {
            if (workerUniqueId === uniqueId)
                return id;
        }
    }
    const pid = normalizeNumber(payload.pid);
    if (pid !== null) {
        const worker = manager.workers.find((entry) => entry?.process?.pid === pid);
        if (worker)
            return worker.id;
    }
    return null;
}
function getTimeoutForAction(action) {
    switch (action) {
        case 'heapSnapshot':
            return 5 * 60 * 1000;
        case 'heapSamplingStop':
            return 2 * 60 * 1000;
        case 'cpuStop':
            return 2 * 60 * 1000;
        case 'cpuStart':
        case 'openInspector':
        case 'closeInspector':
        case 'forceGc':
        case 'status':
            return 10 * 1000;
        default:
            return 30 * 1000;
    }
}
function summarizeHeapSamplingProfile(profile, limit = null) {
    const head = profile?.head;
    if (!head)
        return [];
    const aggregates = new Map();
    const visit = (node) => {
        const frame = node?.callFrame || {};
        const functionName = frame.functionName || '(anonymous)';
        const url = frame.url || '(internal)';
        const line = Number(frame.lineNumber || 0) + 1;
        const column = Number(frame.columnNumber || 0) + 1;
        const selfSize = Number(node?.selfSize || 0);
        if (selfSize > 0) {
            const key = `${functionName}|${url}|${line}|${column}`;
            const current = aggregates.get(key);
            if (current) {
                current.bytes += selfSize;
                current.hits++;
            }
            else {
                aggregates.set(key, {
                    functionName,
                    url,
                    line,
                    column,
                    bytes: selfSize,
                    hits: 1
                });
            }
        }
        const children = Array.isArray(node?.children) ? node.children : [];
        for (const child of children)
            visit(child);
    };
    visit(head);
    const entries = Array.from(aggregates.values()).sort((a, b) => b.bytes - a.bytes);
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        return entries.slice(0, limit);
    }
    return entries;
}
function validateAccess(nodelink, req, suppliedCode) {
    const endpointConfig = getEndpointConfig(nodelink);
    if (!endpointConfig.patchEnabled) {
        return { ok: false, error: 'Profiler endpoint is disabled.' };
    }
    const remoteAddress = req.socket?.remoteAddress || '';
    if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
        return { ok: false, error: 'External access to profiler endpoint is blocked.' };
    }
    if (suppliedCode !== endpointConfig.code) {
        return { ok: false, error: 'Invalid profiler code.' };
    }
    return { ok: true };
}
function sanitizeProfileName(value) {
    if (!value)
        return '';
    return String(value)
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
function bytesToMB(value) {
    return Math.round((Number(value || 0) / 1024 / 1024) * 100) / 100;
}
function parseScope(payload) {
    const scope = typeof payload.scope === 'string' ? payload.scope : 'all';
    return {
        scope,
        includeMaster: scope === 'all' || scope === 'master',
        includeWorkers: scope === 'all' || scope === 'workers',
        includeSourceWorkers: scope === 'all' || scope === 'sourceWorkers'
    };
}
function getMasterActiveResources() {
    const list = typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo()
        : [];
    const counters = {};
    for (const item of list)
        counters[item] = (counters[item] || 0) + 1;
    return counters;
}
function getMasterActiveHandles() {
    const getter = process;
    if (typeof getter._getActiveHandles !== 'function')
        return {};
    const handles = getter._getActiveHandles();
    const counters = {};
    for (const handle of handles) {
        const name = handle?.constructor?.name || 'UnknownHandle';
        counters[name] = (counters[name] || 0) + 1;
    }
    return counters;
}
function getMasterHeapSpaces() {
    return v8.getHeapSpaceStatistics().map((space) => ({
        spaceName: space.space_name,
        spaceSize: space.space_size,
        spaceUsedSize: space.space_used_size,
        spaceAvailableSize: space.space_available_size,
        physicalSpaceSize: space.physical_space_size
    }));
}
function getMasterRuntimeContext(nodelink) {
    const traceStore = globalThis.__nodelinkTraceStore || {
        requests: [],
        events: []
    };
    const traceRequests = Array.isArray(traceStore.requests)
        ? traceStore.requests.slice(-200)
        : [];
    const traceEvents = Array.isArray(traceStore.events)
        ? traceStore.events.slice(-200)
        : [];
    const statsSnapshot = nodelink?.statsManager && typeof nodelink.statsManager.getSnapshot === 'function'
        ? nodelink.statsManager.getSnapshot()
        : null;
    const workerMetrics = nodelink?.workerManager &&
        typeof nodelink.workerManager.getWorkerMetrics === 'function'
        ? nodelink.workerManager.getWorkerMetrics()
        : null;
    const sourceManager = nodelink?.sourceWorkerManager;
    const workerManager = nodelink?.workerManager;
    const connectionManager = nodelink?.connectionManager;
    const connectionContext = connectionManager
        ? {
            status: typeof connectionManager.status === 'string'
                ? connectionManager.status
                : 'unknown',
            metrics: connectionManager.metrics && typeof connectionManager.metrics === 'object'
                ? connectionManager.metrics
                : null
        }
        : null;
    const sourceContext = sourceManager
        ? {
            workers: Array.isArray(sourceManager.workers)
                ? sourceManager.workers
                    .filter((w) => w?.isConnected?.())
                    .map((w) => ({ id: w.id, pid: w.process?.pid || null }))
                : [],
            pendingRequests: sourceManager.requests instanceof Map
                ? sourceManager.requests.size
                : null,
            workerLoads: sourceManager.workerLoads instanceof Map
                ? Object.fromEntries(sourceManager.workerLoads.entries())
                : null
        }
        : null;
    const masterMapSizes = {
        sessionsActive: nodelink?.sessions?.activeSessions instanceof Map
            ? nodelink.sessions.activeSessions.size
            : null,
        sessionsResumable: nodelink?.sessions?.resumableSessions instanceof Map
            ? nodelink.sessions.resumableSessions.size
            : null,
        workerPendingRequests: workerManager?.pendingRequests instanceof Map
            ? workerManager.pendingRequests.size
            : null,
        workerStreamRequests: workerManager?.streamRequests instanceof Map
            ? workerManager.streamRequests.size
            : null,
        workerGuildMap: workerManager?.guildToWorker instanceof Map
            ? workerManager.guildToWorker.size
            : null,
        sourceRequests: sourceManager?.requests instanceof Map ? sourceManager.requests.size : null
    };
    return {
        activeResources: getMasterActiveResources(),
        activeHandles: getMasterActiveHandles(),
        heapSpaces: getMasterHeapSpaces(),
        hostMemory: {
            free: os.freemem(),
            total: os.totalmem()
        },
        trace: {
            requests: traceRequests,
            events: traceEvents
        },
        statsSnapshot,
        workerMetrics,
        connection: connectionContext,
        sourceContext,
        mapSizes: masterMapSizes
    };
}
async function buildProfilerFilePath(kind, extension, label) {
    await fsPromises.mkdir(profilerBaseDir, { recursive: true });
    const safeLabel = sanitizeProfileName(label);
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '');
    const suffix = safeLabel ? `-${safeLabel}` : '';
    return `${profilerBaseDir}/master-${process.pid}-${kind}-${stamp}${suffix}.${extension}`;
}
function inspectorPost(session, method, params) {
    return new Promise((resolve, reject) => {
        session.post(method, params ?? {}, (error, result) => {
            if (error)
                reject(error);
            else
                resolve(result ?? {});
        });
    });
}
async function runMasterProfilerCommand(action, payload) {
    if (action === 'status') {
        return {
            success: true,
            pid: process.pid,
            inspectorUrl: inspector.url() || null,
            cpuProfiling: !!activeMasterCpu,
            cpuStartedAt: activeMasterCpu?.startedAt || null,
            heapSamplingActive: !!activeMasterHeapSampling,
            heapSamplingStartedAt: activeMasterHeapSampling?.startedAt || null,
            profileDir: profilerBaseDir,
            memory: process.memoryUsage(),
            heapSpaces: getMasterHeapSpaces(),
            uptimeSec: Math.floor(process.uptime())
        };
    }
    if (action === 'openInspector') {
        const host = typeof payload.host === 'string' ? payload.host : '127.0.0.1';
        const port = typeof payload.port === 'number' && Number.isInteger(payload.port)
            ? payload.port
            : 0;
        inspector.open(port, host, payload.exposeWait === true);
        return { success: true, pid: process.pid, inspectorUrl: inspector.url() || null };
    }
    if (action === 'closeInspector') {
        inspector.close();
        return { success: true, pid: process.pid, inspectorUrl: null };
    }
    if (action === 'forceGc') {
        const gcFn = global.gc;
        if (typeof gcFn !== 'function') {
            return {
                success: false,
                error: 'GC not exposed. Start NodeLink with --expose-gc to enable forceGc.'
            };
        }
        gcFn();
        gcFn();
        return { success: true, pid: process.pid, memory: process.memoryUsage() };
    }
    if (action === 'cpuStart') {
        if (activeMasterCpu) {
            return {
                success: true,
                alreadyActive: true,
                pid: process.pid,
                startedAt: activeMasterCpu.startedAt
            };
        }
        const session = new inspector.Session();
        session.connect();
        await inspectorPost(session, 'Profiler.enable');
        await inspectorPost(session, 'Profiler.start');
        activeMasterCpu = {
            session,
            startedAt: Date.now(),
            name: sanitizeProfileName(payload.name) || null
        };
        return { success: true, pid: process.pid, startedAt: activeMasterCpu.startedAt };
    }
    if (action === 'cpuStop') {
        if (!activeMasterCpu) {
            return { success: false, error: 'CPU profiler is not active' };
        }
        const { session, startedAt, name } = activeMasterCpu;
        const result = await inspectorPost(session, 'Profiler.stop');
        const outputPath = await buildProfilerFilePath('cpu', 'cpuprofile', sanitizeProfileName(payload.name) || name || undefined);
        await fsPromises.writeFile(outputPath, JSON.stringify(result['profile']));
        try {
            session.disconnect();
        }
        catch { }
        activeMasterCpu = null;
        return { success: true, pid: process.pid, startedAt, endedAt: Date.now(), outputPath };
    }
    if (action === 'heapSnapshot') {
        const outputPath = await buildProfilerFilePath('heap', 'heapsnapshot', payload.name);
        const session = new inspector.Session();
        let fd = null;
        try {
            fd = fs.openSync(outputPath, 'w');
            session.connect();
            session.on('HeapProfiler.addHeapSnapshotChunk', (message) => {
                const chunk = message?.params?.chunk;
                if (typeof chunk === 'string' && fd !== null) {
                    fs.writeSync(fd, chunk);
                }
            });
            await inspectorPost(session, 'HeapProfiler.enable');
            await inspectorPost(session, 'HeapProfiler.takeHeapSnapshot', {
                reportProgress: false
            });
            return { success: true, pid: process.pid, outputPath };
        }
        finally {
            try {
                session.disconnect();
            }
            catch { }
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                }
                catch { }
            }
        }
    }
    if (action === 'heapSamplingStart') {
        if (activeMasterHeapSampling) {
            return {
                success: true,
                alreadyActive: true,
                pid: process.pid,
                startedAt: activeMasterHeapSampling.startedAt
            };
        }
        const samplingInterval = typeof payload.samplingInterval === 'number' &&
            Number.isFinite(payload.samplingInterval) &&
            payload.samplingInterval > 0
            ? Math.floor(payload.samplingInterval)
            : 32768;
        const session = new inspector.Session();
        session.connect();
        await inspectorPost(session, 'HeapProfiler.enable');
        await inspectorPost(session, 'HeapProfiler.startSampling', {
            samplingInterval
        });
        activeMasterHeapSampling = {
            session,
            startedAt: Date.now(),
            name: sanitizeProfileName(payload.name) || null,
            samplingInterval
        };
        return {
            success: true,
            pid: process.pid,
            startedAt: activeMasterHeapSampling.startedAt,
            samplingInterval
        };
    }
    if (action === 'heapSamplingStop') {
        if (!activeMasterHeapSampling) {
            return { success: false, error: 'Heap sampling is not active' };
        }
        const { session, startedAt, name } = activeMasterHeapSampling;
        const result = await inspectorPost(session, 'HeapProfiler.stopSampling');
        const outputPath = await buildProfilerFilePath('heap-sampling', 'heapsampling.json', sanitizeProfileName(payload.name) || name || undefined);
        await fsPromises.writeFile(outputPath, JSON.stringify(result));
        try {
            session.disconnect();
        }
        catch { }
        activeMasterHeapSampling = null;
        const profile = result?.profile || {};
        const topSites = summarizeHeapSamplingProfile(profile);
        return {
            success: true,
            pid: process.pid,
            startedAt,
            endedAt: Date.now(),
            outputPath,
            topSites
        };
    }
    return { success: false, error: `Unsupported profiler action: ${action}` };
}
async function runWorkerProfilerCommand(manager, workers, action, payload) {
    const timeoutMs = getTimeoutForAction(action);
    const commandPayload = {
        action,
        ...(payload ?? {})
    };
    const settled = await Promise.allSettled(workers.map(async (worker) => {
        const response = await manager.execute(worker, 'profilerCommand', commandPayload, { timeoutMs });
        return {
            clusterId: worker.id,
            uniqueId: manager.workerUniqueId.get(worker.id) || worker.id,
            pid: worker.process?.pid || null,
            response
        };
    }));
    return settled.map((item, index) => {
        const worker = workers[index];
        const identity = {
            clusterId: worker.id,
            uniqueId: manager.workerUniqueId.get(worker.id) || worker.id,
            pid: worker.process?.pid || null
        };
        if (item.status === 'fulfilled')
            return item.value;
        return {
            ...identity,
            error: item.reason instanceof Error ? item.reason.message : String(item.reason)
        };
    });
}
async function collectActionSnapshot(nodelink, action, payload) {
    const { scope, includeMaster, includeWorkers, includeSourceWorkers } = parseScope(payload);
    const output = {
        action,
        scope,
        timestamp: Date.now()
    };
    if (includeMaster) {
        output.master = await runMasterProfilerCommand(action, payload);
        if (action === 'status' && output.master?.success) {
            output.master.runtime = getMasterRuntimeContext(nodelink);
        }
    }
    if (includeWorkers) {
        const manager = nodelink.workerManager;
        if (!manager) {
            output.workers = [];
            output.workersError = 'Cluster workers are not enabled.';
        }
        else {
            const requestedWorkerId = resolveWorkerId(manager, payload || {});
            const workers = requestedWorkerId === null
                ? manager.workers.filter((worker) => worker?.isConnected?.())
                : manager.workers.filter((worker) => worker?.id === requestedWorkerId);
            output.workers =
                workers.length > 0
                    ? await runWorkerProfilerCommand(manager, workers, action, payload)
                    : [];
        }
    }
    if (includeSourceWorkers) {
        const sourceManager = nodelink.sourceWorkerManager;
        if (!sourceManager || typeof sourceManager.executeAll !== 'function') {
            output.sourceWorkers = [];
            output.sourceWorkersError =
                'Specialized source workers are not enabled or do not support profiling.';
        }
        else {
            output.sourceWorkers = await sourceManager.executeAll('profilerCommand', { action, ...(payload ?? {}) }, { timeoutMs: getTimeoutForAction(action), parseJson: true });
        }
    }
    return output;
}
async function collectAllSequence(nodelink, payload) {
    const before = await collectActionSnapshot(nodelink, 'status', payload);
    const gc = await collectActionSnapshot(nodelink, 'forceGc', payload);
    const afterGc = await collectActionSnapshot(nodelink, 'status', payload);
    const heapSnapshot = await collectActionSnapshot(nodelink, 'heapSnapshot', payload);
    return {
        action: 'all',
        scope: parseScope(payload).scope,
        startedAt: before.timestamp,
        finishedAt: Date.now(),
        steps: {
            before,
            gc,
            afterGc,
            heapSnapshot
        }
    };
}
async function collectAllocationTopSites(nodelink, payload) {
    const durationMs = typeof payload.durationMs === 'number' &&
        Number.isFinite(payload.durationMs) &&
        payload.durationMs > 0
        ? Math.min(120000, Math.max(1000, Math.floor(payload.durationMs)))
        : 10000;
    const started = await collectActionSnapshot(nodelink, 'heapSamplingStart', payload);
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const stopped = await collectActionSnapshot(nodelink, 'heapSamplingStop', payload);
    return {
        action: 'allocTop',
        scope: parseScope(payload).scope,
        startedAt: started.timestamp,
        finishedAt: Date.now(),
        durationMs,
        steps: {
            started,
            stopped
        }
    };
}
function extractProcesses(snapshot) {
    const all = [];
    if (snapshot?.master?.memory) {
        all.push({
            kind: 'master',
            id: `master:${snapshot.master.pid}`,
            pid: snapshot.master.pid,
            memory: snapshot.master.memory,
            heapSpaces: snapshot.master.heapSpaces || snapshot.master.runtime?.heapSpaces || []
        });
    }
    for (const item of snapshot?.workers || []) {
        const mem = item?.response?.memory;
        if (!mem)
            continue;
        all.push({
            kind: 'worker',
            id: `worker:${item.pid}`,
            pid: item.pid,
            memory: mem,
            clusterId: item.clusterId,
            heapSpaces: item?.response?.heapSpaces || [],
            playersCount: item?.response?.workersContext?.playersCount || 0
        });
    }
    for (const item of snapshot?.sourceWorkers || []) {
        const mem = item?.response?.memory;
        if (!mem)
            continue;
        all.push({
            kind: 'sourceWorker',
            id: `source:${item.pid}`,
            pid: item.pid,
            memory: mem,
            clusterId: item.clusterId,
            heapSpaces: item?.response?.heapSpaces || []
        });
    }
    return all;
}
function detectAnomalies(snapshot, prevById) {
    const warnings = [];
    const now = Date.now();
    const current = extractProcesses(snapshot);
    for (const proc of current) {
        const { id, pid, kind, memory } = proc;
        const heapUsed = Number(memory.heapUsed || 0);
        const heapTotal = Number(memory.heapTotal || 0);
        const rss = Number(memory.rss || 0);
        const oldSpace = Array.isArray(proc.heapSpaces)
            ? proc.heapSpaces.find((s) => s.spaceName === 'old_space')
            : null;
        const oldUsed = Number(oldSpace?.spaceUsedSize || 0);
        const playersCount = Number(proc.playersCount || 0);
        if (heapTotal > 0) {
            const ratio = heapUsed / heapTotal;
            if (ratio >= 0.92) {
                warnings.push({
                    level: 'warn',
                    type: 'heap_pressure',
                    pid,
                    kind,
                    message: `${kind} pid ${pid} heapUsed/heaptotal ${(ratio * 100).toFixed(1)}%`
                });
            }
        }
        const prev = prevById.get(id);
        if (prev) {
            const dtSec = Math.max(1, (now - prev.time) / 1000);
            const deltaHeapMB = bytesToMB(heapUsed - prev.heapUsed);
            const deltaRssMB = bytesToMB(rss - prev.rss);
            const deltaOldMB = bytesToMB(oldUsed - (prev.oldUsed || 0));
            const playersDelta = playersCount - (prev.playersCount || 0);
            if (deltaHeapMB > 15 && dtSec < 15) {
                warnings.push({
                    level: 'warn',
                    type: 'heap_growth_spike',
                    pid,
                    kind,
                    message: `${kind} pid ${pid} heap +${deltaHeapMB}MB em ${dtSec.toFixed(1)}s`
                });
            }
            if (deltaRssMB > 25 && dtSec < 15) {
                warnings.push({
                    level: 'warn',
                    type: 'rss_growth_spike',
                    pid,
                    kind,
                    message: `${kind} pid ${pid} rss +${deltaRssMB}MB em ${dtSec.toFixed(1)}s`
                });
            }
            // Leak heuristic: old_space rises while player count is stable.
            if (deltaOldMB > 8 &&
                Math.abs(playersDelta) === 0 &&
                dtSec >= 5) {
                warnings.push({
                    level: 'warn',
                    type: 'old_space_growth_suspect',
                    pid,
                    kind,
                    message: `${kind} pid ${pid} old_space +${deltaOldMB}MB em ${dtSec.toFixed(1)}s com players estável (${playersCount})`
                });
            }
        }
        prevById.set(id, {
            time: now,
            heapUsed,
            rss,
            oldUsed,
            playersCount
        });
    }
    return warnings;
}
function getRequestPayload(req, parsedUrl) {
    const bodyPayload = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = { ...bodyPayload };
    const scope = parsedUrl.searchParams.get('scope');
    if (scope && !payload.scope)
        payload.scope = scope;
    const name = parsedUrl.searchParams.get('name');
    if (name && !payload.name)
        payload.name = name;
    const workerId = parsedUrl.searchParams.get('workerId');
    if (workerId && !payload.workerId)
        payload.workerId = workerId;
    const clusterId = parsedUrl.searchParams.get('clusterId');
    if (clusterId && !payload.clusterId)
        payload.clusterId = clusterId;
    const pid = parsedUrl.searchParams.get('pid');
    if (pid && !payload.pid)
        payload.pid = pid;
    return payload;
}
export { collectActionSnapshot, detectAnomalies, collectAllocationTopSites };
async function handleSseStream(nodelink, req, res, parsedUrl, payload) {
    const intervalMs = Math.min(15000, Math.max(700, Number(parsedUrl.searchParams.get('intervalMs') || 2000)));
    const allocDurationMs = Math.min(15000, Math.max(1000, Number(parsedUrl.searchParams.get('allocDurationMs') || 3000)));
    const allocEveryRaw = Number(parsedUrl.searchParams.get('allocEveryMs') || 0);
    const allocEveryMs = Number.isFinite(allocEveryRaw) && allocEveryRaw > 0
        ? Math.min(120000, Math.max(5000, Math.floor(allocEveryRaw)))
        : 0;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    const prevById = new Map();
    let allocInFlight = false;
    let lastAllocAt = 0;
    let lastAllocReport = null;
    const refreshAllocTop = async () => {
        const now = Date.now();
        if (allocInFlight)
            return;
        if (lastAllocReport && now - lastAllocAt < allocEveryMs)
            return;
        allocInFlight = true;
        try {
            lastAllocReport = await collectAllocationTopSites(nodelink, {
                ...payload,
                durationMs: allocDurationMs,
                name: typeof payload?.name === 'string' && payload.name.length > 0
                    ? payload.name
                    : 'stream-alloc'
            });
            lastAllocAt = Date.now();
        }
        catch (error) {
            lastAllocReport = {
                action: 'allocTop',
                failed: true,
                error: error instanceof Error ? error.message : String(error),
                timestamp: Date.now()
            };
            lastAllocAt = Date.now();
        }
        finally {
            allocInFlight = false;
        }
    };
    const pushSnapshot = async () => {
        try {
            const snapshot = await collectActionSnapshot(nodelink, 'status', payload);
            const warnings = detectAnomalies(snapshot, prevById);
            const event = {
                timestamp: Date.now(),
                snapshot,
                warnings,
                allocTop: lastAllocReport
            };
            res.write(`event: snapshot\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ message: msg, timestamp: Date.now() })}\n\n`);
        }
    };
    if (allocEveryMs > 0)
        refreshAllocTop().catch(() => { });
    await pushSnapshot();
    const timer = setInterval(pushSnapshot, intervalMs);
    const allocTimer = allocEveryMs > 0
        ? setInterval(() => {
            refreshAllocTop().catch(() => { });
        }, allocEveryMs)
        : null;
    req.on('close', () => {
        clearInterval(timer);
        if (allocTimer)
            clearInterval(allocTimer);
    });
}
async function handleRequest(nodelink, req, res, parsedUrl, action, payload) {
    if (action === 'all') {
        const report = await collectAllSequence(nodelink, payload);
        return sendResponse(req, res, report, 200);
    }
    if (action === 'allocTop') {
        const report = await collectAllocationTopSites(nodelink, payload);
        return sendResponse(req, res, report, 200);
    }
    const snapshot = await collectActionSnapshot(nodelink, action, payload);
    return sendResponse(req, res, snapshot, 200);
}
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const bodyPayload = getRequestPayload(req, parsedUrl);
    const queryCode = parsedUrl.searchParams.get('code');
    const headerCode = req.headers?.['x-nodelink-code'] || req.headers?.['x-worker-code'];
    const suppliedCode = bodyPayload.code ||
        queryCode ||
        (Array.isArray(headerCode) ? headerCode[0] : headerCode);
    const access = validateAccess(nodelink, req, suppliedCode);
    if (!access.ok) {
        return sendErrorResponse(req, res, 403, 'Forbidden', access.error, parsedUrl.pathname);
    }
    if (req.method === 'GET') {
        const stream = parsedUrl.searchParams.get('stream') === 'true';
        if (stream) {
            return handleSseStream(nodelink, req, res, parsedUrl, bodyPayload);
        }
        const action = parsedUrl.searchParams.get('action') || 'status';
        return handleRequest(nodelink, req, res, parsedUrl, action, bodyPayload);
    }
    if (req.method === 'POST') {
        const action = bodyPayload.action;
        if (typeof action !== 'string' || action.length === 0) {
            return sendErrorResponse(req, res, 400, 'Bad Request', 'Profiler action is required.', parsedUrl.pathname);
        }
        return handleRequest(nodelink, req, res, parsedUrl, action, bodyPayload);
    }
    return sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method must be GET or POST.', parsedUrl.pathname);
}
export default {
    handler,
    methods: ['GET', 'POST']
};
