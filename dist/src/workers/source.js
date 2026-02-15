var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import net from 'node:net';
import os from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, workerData as rawWorkerData, Worker } from 'node:worker_threads';
import * as utils from "../utils.js";
const __filename = fileURLToPath(import.meta.url);
/**
 * Main thread - Source Worker Manager
 * Spawns and manages a pool of micro-workers for handling source API tasks
 */
if (isMainThread) {
    const resolveRootConfigUrl = (fileName) => pathToFileURL(resolvePath(process.cwd(), fileName)).href;
    /**
     * Loads NodeLink configuration
     * @returns Configuration object
     * @internal
     */
    async function loadConfig() {
        try {
            return (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.js')))).default;
        }
        catch {
            return (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.default.js')))).default;
        }
    }
    const config = await loadConfig();
    const specConfig = 
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    config['cluster']?.[
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    'specializedSourceWorker'] || {};
    utils.initLogger(config);
    const nodelink = {
        options: config,
        logger: utils.logger
    };
    const maxThreadCount = Math.max(1, specConfig.microWorkers ?? Math.min(2, os.cpus().length));
    const initialThreadCount = 1;
    const TASKS_PER_WORKER = specConfig.tasksPerWorker ?? 32;
    const SCALE_UP_THRESHOLD = specConfig.scaleUpThreshold ?? 30;
    const SCALE_UP_COOLDOWN_MS = specConfig.scaleCooldownMs ?? 1000;
    const workerPool = [];
    const taskQueue = [];
    let lastScaleUpAt = 0;
    nodelink.logger('info', 'SourceWorker', `Starting ${initialThreadCount}/${maxThreadCount} micro-worker(s) for API tasks...`);
    const createMicroWorker = (threadNumber) => {
        const worker = new Worker(__filename, {
            workerData: {
                config,
                silentLogs: specConfig.silentLogs ?? false,
                threadId: threadNumber
            }
        });
        worker.ready = false;
        worker.load = 0;
        worker.on('message', (msg) => {
            if (msg.type === 'ready') {
                worker.ready = true;
                nodelink.logger('info', 'SourceWorker', `Micro-worker ${threadNumber} is ready.`);
                processNextTask();
            }
            else if (msg.type === 'result') {
                const { socketPath, id, result, error } = msg;
                finishTask(socketPath, id, result, error);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
            else if (msg.type === 'stream') {
                sendStreamChunk(msg.socketPath, msg.id, msg.chunk);
            }
            else if (msg.type === 'chatAction') {
                sendChatAction(msg.socketPath, msg.id, msg.data);
            }
            else if (msg.type === 'end') {
                sendStreamEnd(msg.socketPath, msg.id);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
            else if (msg.type === 'error') {
                sendStreamError(msg.socketPath, msg.id, msg.error);
                worker.load = Math.max(0, worker.load - 1);
                processNextTask();
            }
        });
        worker.on('exit', (code) => {
            const idx = workerPool.indexOf(worker);
            if (idx !== -1)
                workerPool.splice(idx, 1);
            nodelink.logger('warn', 'SourceWorker', `Micro-worker ${threadNumber} exited with code ${code}`);
        });
        workerPool.push(worker);
    };
    const getTotalLoad = () => {
        let total = 0;
        for (const worker of workerPool)
            total += worker.load || 0;
        return total;
    };
    const maybeScaleUpMicroWorkers = () => {
        if (workerPool.length >= maxThreadCount)
            return;
        const now = Date.now();
        if (now - lastScaleUpAt < SCALE_UP_COOLDOWN_MS)
            return;
        const totalLoad = getTotalLoad() + taskQueue.length;
        const threshold = workerPool.length * SCALE_UP_THRESHOLD;
        if (totalLoad <= threshold)
            return;
        const nextThreadNumber = workerPool.length + 1;
        createMicroWorker(nextThreadNumber);
        lastScaleUpAt = now;
        nodelink.logger('info', 'SourceWorker', `Scaling micro-workers: ${workerPool.length}/${maxThreadCount} (load=${totalLoad}, threshold=${threshold})`);
    };
    for (let i = 0; i < initialThreadCount; i++) {
        createMicroWorker(i + 1);
    }
    const sockets = new Map();
    /**
     * Gets or creates a Unix socket connection to the specified path
     * @param path - Unix socket path
     * @returns Promise resolving to connected socket
     * @internal
     */
    async function getSocket(path) {
        const existing = sockets.get(path);
        if (existing)
            return existing;
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(path, () => {
                sockets.set(path, socket);
                resolve(socket);
            });
            socket.on('error', reject);
            socket.on('close', () => sockets.delete(path));
        });
    }
    /**
     * Executes handler with socket, creating connection if needed
     * @param path - Unix socket path
     * @param handler - Function to execute with socket
     * @internal
     */
    function withSocket(path, handler) {
        const socket = sockets.get(path);
        if (socket) {
            handler(socket);
            return;
        }
        getSocket(path)
            .then(handler)
            .catch((e) => {
            utils.logger('error', 'SourceWorker', `Failed to send data back: ${e.message}`);
        });
    }
    /**
     * Sends task completion result or error back through socket
     * @param socketPath - Unix socket path
     * @param id - Task identifier
     * @param result - Result data (JSON string)
     * @param error - Error message if task failed
     * @internal
     */
    function finishTask(socketPath, id, result, error) {
        getSocket(socketPath)
            .then((socket) => {
            if (error) {
                sendFrame(socket, id, 2, Buffer.from(error, 'utf8'));
            }
            else if (result) {
                sendFrame(socket, id, 0, Buffer.from(result, 'utf8'));
                sendFrame(socket, id, 1, Buffer.alloc(0));
            }
        })
            .catch((e) => {
            utils.logger('error', 'SourceWorker', `Failed to send result back: ${e.message}`);
        });
    }
    /**
     * Sends a stream data chunk through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @param chunk - Data chunk (Buffer or string)
     * @internal
     */
    function sendStreamChunk(socketPath, id, chunk) {
        const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        withSocket(socketPath, (socket) => sendFrame(socket, id, 0, payload));
    }
    /**
     * Sends live chat action data through socket
     * @param socketPath - Unix socket path
     * @param id - Chat session identifier
     * @param data - Chat action data
     * @internal
     */
    function sendChatAction(socketPath, id, data) {
        const payload = Buffer.from(JSON.stringify(data), 'utf8');
        withSocket(socketPath, (socket) => sendFrame(socket, id, 3, payload));
    }
    /**
     * Sends stream end signal through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @internal
     */
    function sendStreamEnd(socketPath, id) {
        withSocket(socketPath, (socket) => sendFrame(socket, id, 1, Buffer.alloc(0)));
    }
    /**
     * Sends stream error through socket
     * @param socketPath - Unix socket path
     * @param id - Stream identifier
     * @param error - Error message
     * @internal
     */
    function sendStreamError(socketPath, id, error) {
        const errorBuf = Buffer.from(String(error || 'Unknown error'), 'utf8');
        withSocket(socketPath, (socket) => sendFrame(socket, id, 2, errorBuf));
    }
    /**
     * Sends a framed message through socket
     *
     * Frame format:
     * - Byte 0: ID length (1 byte)
     * - Byte 1: Frame type (1 byte) - 0=data, 1=end, 2=error, 3=chat
     * - Bytes 2-5: Payload length (4 bytes, big-endian)
     * - Following bytes: ID string (variable length)
     * - Following bytes: Payload data (variable length)
     *
     * @param socket - Connected socket
     * @param id - Message/stream identifier
     * @param type - Frame type (0=data, 1=end, 2=error, 3=chat)
     * @param payloadBuf - Payload buffer
     * @internal
     */
    function sendFrame(socket, id, type, payloadBuf) {
        const idBuf = Buffer.from(id, 'utf8');
        const header = Buffer.alloc(6);
        header.writeUInt8(idBuf.length, 0);
        header.writeUInt8(type, 1);
        header.writeUInt32BE(payloadBuf.length, 2);
        socket.write(Buffer.concat([header, idBuf, payloadBuf]));
    }
    /**
     * Processes next task in queue by assigning to least-loaded worker
     * @internal
     */
    function processNextTask() {
        if (taskQueue.length === 0)
            return;
        maybeScaleUpMicroWorkers();
        let bestWorker = null;
        let minLoad = Number.POSITIVE_INFINITY;
        for (const worker of workerPool) {
            if (worker.ready &&
                worker.load < TASKS_PER_WORKER &&
                worker.load < minLoad) {
                bestWorker = worker;
                minLoad = worker.load;
            }
        }
        if (bestWorker) {
            const task = taskQueue.shift();
            if (task) {
                bestWorker.load++;
                bestWorker.postMessage(task);
                if (taskQueue.length > 0)
                    setImmediate(processNextTask);
            }
        }
    }
    /**
     * Handles incoming IPC messages from parent process
     */
    process.on('message', (msg) => {
        if (msg.type !== 'sourceTask')
            return;
        if (msg.payload) {
            taskQueue.push(msg.payload);
            maybeScaleUpMicroWorkers();
            processNextTask();
        }
    });
    /**
     * Notify parent that worker is ready
     */
    try {
        process.send?.({ type: 'ready', pid: process.pid });
    }
    catch {
        // Ignore send failures (e.g., when not forked)
    }
}
else {
    /**
     * Worker thread - Micro-worker for executing source API tasks
     * Each micro-worker initializes its own source managers and processes tasks
     */
    const workerData = rawWorkerData;
    const { config, silentLogs } = workerData;
    if (silentLogs) {
        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
        config['logging'] = {
            // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
            ...config['logging'],
            level: 'warn'
        };
    }
    utils.initLogger(config);
    const nodelink = {
        options: config,
        logger: utils.logger
    };
    /**
     * Dynamically imports and initializes all required managers
     * @internal
     */
    const [{ createPCMStream, createSeekeableAudioResource }, { default: SourceManager }, { default: LyricsManager }, { default: MeaningManager }, { default: CredentialManager }, { default: TrackCacheManager }, { default: RoutePlannerManager }, { default: StatsManager }] = await Promise.all([
        import("../playback/processing/streamProcessor.js"),
        import("../managers/sourceManager.js"),
        import('../managers/lyricsManager.js'),
        import('../managers/meaningManager.js'),
        import("../managers/credentialManager.js"),
        import("../managers/trackCacheManager.js"),
        import('../managers/routePlannerManager.js'),
        import("../managers/statsManager.js")
    ]);
    nodelink.statsManager = new StatsManager(nodelink);
    nodelink.credentialManager = new CredentialManager(nodelink);
    nodelink.trackCacheManager = new TrackCacheManager(nodelink);
    nodelink.routePlanner = new RoutePlannerManager(nodelink);
    nodelink.sources = new SourceManager(nodelink);
    nodelink.lyrics = new LyricsManager(nodelink);
    nodelink.meanings = new MeaningManager(nodelink);
    await nodelink.credentialManager.load();
    await nodelink.trackCacheManager.load();
    await nodelink.sources.loadFolder();
    await nodelink.lyrics.loadFolder();
    await nodelink.meanings.loadFolder();
    /**
     * Active live chat sessions (session ID -> active flag)
     * @internal
     */
    const activeChats = new Map();
    parentPort.postMessage({ type: 'ready' });
    /**
     * Sends stream data chunk to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @param chunk - Data chunk
     * @internal
     */
    const sendStreamChunkFromWorker = (id, socketPath, chunk) => {
        ;
        parentPort.postMessage({
            type: 'stream',
            id,
            socketPath,
            chunk
        });
    };
    /**
     * Sends stream end signal to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @internal
     */
    const sendStreamEndFromWorker = (id, socketPath) => {
        ;
        parentPort.postMessage({
            type: 'end',
            id,
            socketPath
        });
    };
    /**
     * Sends stream error to parent thread
     * @param id - Stream identifier
     * @param socketPath - Unix socket path
     * @param error - Error message or object
     * @internal
     */
    const sendStreamErrorFromWorker = (id, socketPath, error) => {
        ;
        parentPort.postMessage({
            type: 'error',
            id,
            socketPath,
            error: String(error || 'Unknown error')
        });
    };
    /**
     * Handles YouTube live chat streaming task
     *
     * Continuously polls for new chat messages and sends them back
     * to the parent thread until the chat is cancelled or an error occurs.
     *
     * @param id - Chat session identifier
     * @param socketPath - Unix socket path for responses
     * @param payload - Live chat task payload
     * @internal
     */
    const handleLiveChat = async (id, socketPath, payload) => {
        const videoId = payload.videoId;
        const yt = nodelink.sources?.getSource('youtube');
        if (!yt || !yt.liveChat)
            throw new Error('YouTube source or live chat not available in worker');
        activeChats.set(id, true);
        try {
            const chat = await yt.liveChat.getLiveChat(videoId);
            if (!chat)
                throw new Error('Could not initialize live chat');
            const pollLoop = async () => {
                while (activeChats.has(id)) {
                    try {
                        const result = await chat.poll();
                        if (!result)
                            break;
                        const { actions, timeoutMs } = result;
                        if (actions.length > 0 && activeChats.has(id)) {
                            utils.logger('debug', 'SourceWorker', `[${id}] Sending ${actions.length} actions for ${videoId}`);
                            parentPort.postMessage({
                                type: 'chatAction',
                                id,
                                socketPath,
                                data: { op: 'actions', actions }
                            });
                        }
                        await new Promise((resolve) => setTimeout(resolve, timeoutMs || 5000));
                    }
                    catch (e) {
                        const err = e;
                        utils.logger('error', 'SourceWorker', `[${id}] Polling exception for ${videoId}: ${err.message}`);
                        break;
                    }
                }
            };
            await pollLoop();
            parentPort.postMessage({ type: 'end', id, socketPath });
        }
        catch (e) {
            const err = e;
            sendStreamErrorFromWorker(id, socketPath, err.message);
        }
        finally {
            activeChats.delete(id);
        }
    };
    /**
     * Handles track stream loading and PCM conversion
     *
     * Resolves track URL, fetches the stream, converts to PCM audio,
     * and streams chunks back to the parent thread.
     *
     * @param id - Stream identifier
     * @param socketPath - Unix socket path for streaming
     * @param payload - Load stream task payload
     * @internal
     */
    const handleLoadStream = async (id, socketPath, payload) => {
        let fetched = null;
        let pcmStream = null;
        let finished = false;
        const cleanup = () => {
            if (pcmStream && !pcmStream.destroyed)
                pcmStream.destroy();
            if (fetched?.stream && !fetched.stream.destroyed)
                fetched.stream.destroy();
        };
        const finish = (err) => {
            if (finished)
                return;
            finished = true;
            if (err) {
                const errMsg = typeof err === 'string' ? err : err.message;
                sendStreamErrorFromWorker(id, socketPath, errMsg);
            }
            else {
                sendStreamEndFromWorker(id, socketPath);
            }
            cleanup();
        };
        try {
            const trackInfo = payload?.decodedTrackInfo;
            if (!trackInfo) {
                throw new Error('Invalid encoded track');
            }
            const urlResult = await nodelink.sources?.getTrackUrl(trackInfo);
            if (!urlResult || urlResult.exception) {
                throw new Error(urlResult?.exception?.message || 'Failed to get track URL');
            }
            const sourceName = urlResult.newTrack?.info?.sourceName || trackInfo.sourceName;
            const isHls = urlResult.protocol === 'hls';
            const isSabr = urlResult.protocol === 'sabr';
            const isLocal = sourceName === 'local';
            if (urlResult.url && !isHls && !isLocal && !isSabr) {
                const resource = await createSeekeableAudioResource(urlResult.url, payload?.position || 0, undefined, nodelink, {}, {
                    streamInfo: urlResult,
                    loudnessNormalizer: nodelink.options.audio?.loudnessNormalizer
                }, (payload?.volume ?? 100) / 100, null, true);
                if ('exception' in resource) {
                    throw new Error(resource.exception.message);
                }
                pcmStream = resource.stream;
            }
            else {
                const additionalData = {
                    ...(urlResult.additionalData || {}),
                    startTime: payload?.position || 0
                };
                fetched =
                    (await nodelink.sources?.getTrackStream(urlResult.newTrack?.info || trackInfo, urlResult.url, urlResult.protocol, additionalData)) || null;
                if (!fetched || fetched.exception) {
                    throw new Error(fetched?.exception?.message || 'Failed to load stream');
                }
                pcmStream = createPCMStream(fetched.stream, fetched.type || urlResult.format || 'unknown', nodelink, (payload?.volume ?? 100) / 100, payload?.filters || {});
            }
            pcmStream.on('data', (chunk) => {
                if (!finished)
                    sendStreamChunkFromWorker(id, socketPath, chunk);
            });
            pcmStream.once('end', () => finish());
            pcmStream.once('error', (err) => finish(err));
            pcmStream.once('close', () => finish());
        }
        catch (err) {
            finish(err);
        }
    };
    parentPort.on('message', async (taskData) => {
        const { id, task, payload, socketPath } = taskData;
        if (task === 'loadStream') {
            try {
                await handleLoadStream(id, socketPath, payload);
            }
            catch (e) {
                const err = e;
                sendStreamErrorFromWorker(id, socketPath, err.message || err);
            }
            return;
        }
        if (task === 'loadLiveChat') {
            try {
                await handleLiveChat(id, socketPath, payload);
            }
            catch (e) {
                const err = e;
                sendStreamErrorFromWorker(id, socketPath, err.message || err);
            }
            return;
        }
        if (task === 'cancelLiveChat') {
            activeChats.delete(payload.id);
            return;
        }
        try {
            let result;
            switch (task) {
                case 'resolve':
                    result = await nodelink.sources?.resolve(payload.url);
                    break;
                case 'search':
                    result = await nodelink.sources?.search(payload.source, payload.query);
                    break;
                case 'unifiedSearch':
                    result = await nodelink.sources?.unifiedSearch(payload.query);
                    break;
                case 'loadLyrics':
                    result = await nodelink.lyrics?.loadLyrics({
                        info: payload
                            .decodedTrackInfo
                    }, payload.language);
                    break;
                case 'loadMeaning':
                    result = await nodelink.meanings?.loadMeaning({
                        info: payload
                            .decodedTrackInfo
                    }, payload.language);
                    break;
                case 'loadChapters':
                    result = await nodelink.sources?.getChapters({
                        info: payload.decodedTrackInfo
                    });
                    break;
            }
            ;
            parentPort.postMessage({
                type: 'result',
                id,
                socketPath,
                result: JSON.stringify(result)
            });
        }
        catch (e) {
            const err = e;
            parentPort.postMessage({
                type: 'result',
                id,
                socketPath,
                error: err.message
            });
        }
    });
}
