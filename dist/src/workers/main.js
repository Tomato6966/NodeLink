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
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { GatewayEvents } from "../constants.js";
import ConnectionManager from "../managers/connectionManager.js";
import CredentialManager from "../managers/credentialManager.js";
import LyricsManager from '../managers/lyricsManager.js';
import MeaningManager from '../managers/meaningManager.js';
import PluginManager from '../managers/pluginManager.js';
import RoutePlannerManager from '../managers/routePlannerManager.js';
import SourceManager from "../managers/sourceManager.js";
import StatsManager from "../managers/statsManager.js";
import TrackCacheManager from "../managers/trackCacheManager.js";
import { bufferPool } from "../playback/structs/BufferPool.js";
import { cleanupHttpAgents, initLogger, logger } from "../utils.js";
import { createVoiceRelay } from "../voice/voiceRelay.js";
let playerClassPromise = null;
let createPCMStreamPromise = null;
const getPlayerClass = async () => {
    if (!playerClassPromise) {
        playerClassPromise = import("../playback/player.js").then((module) => module.Player);
    }
    return playerClassPromise;
};
const getCreatePCMStream = async () => {
    if (!createPCMStreamPromise) {
        createPCMStreamPromise = import("../playback/processing/streamProcessor.js").then((module) => module.createPCMStream);
    }
    return createPCMStreamPromise;
};
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let lastActivityTime = Date.now();
let isHibernating = false;
let playerUpdateTimer = null;
let statsUpdateTimer = null;
const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);
const hndl = monitorEventLoopDelay({ resolution: 10 });
hndl.enable();
try {
    os.setPriority(os.constants.priority.PRIORITY_HIGH);
}
catch (_e) {
    // Ignore errors
}
let config;
const resolveRootConfigUrl = (fileName) => pathToFileURL(resolvePath(process.cwd(), fileName)).href;
try {
    config = (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.js'))))
        .default;
}
catch {
    config = (await import(__rewriteRelativeImportExtension(resolveRootConfigUrl('config.default.js'))))
        .default;
}
const HIBERNATION_ENABLED = config.cluster?.hibernation?.enabled !== false;
const HIBERNATION_TIMEOUT = config.cluster?.hibernation?.timeoutMs || 20 * 60 * 1000;
initLogger(config);
const players = new Map();
const guildQueues = new Map(); // guildId -> { queue: [], processing: false }
const activeStreams = new Map();
const PARALLEL_COMMANDS = new Set([
    'loadTracks',
    'loadLyrics',
    'loadMeaning',
    'loadChapters',
    'getSources',
    'getTrackUrl',
    'loadStream',
    'cancelStream',
    'updateYoutubeConfig'
]);
const sendProcessMessage = (payload, onError) => {
    if (typeof process.send !== 'function')
        return false;
    try {
        return process.send(payload) ?? false;
    }
    catch (error) {
        onError?.(error);
        return false;
    }
};
const { EVENT_SOCKET_PATH, COMMAND_SOCKET_PATH, NODE_UNIQUE_ID } = process.env;
let eventSocket = null;
const eventSocketPath = EVENT_SOCKET_PATH;
if (eventSocketPath) {
    const connect = () => {
        const socket = net.createConnection(eventSocketPath, () => {
            eventSocket = socket;
            logger('info', 'Worker', 'Connected to Master event socket');
        });
        socket.on('error', () => {
            eventSocket = null;
            setTimeout(connect, 1000);
        });
        socket.on('close', () => {
            eventSocket = null;
            setTimeout(connect, 1000);
        });
    };
    connect();
}
let commandSocket = null;
const commandSocketPath = COMMAND_SOCKET_PATH;
if (commandSocketPath) {
    const connect = () => {
        const socket = net.createConnection(commandSocketPath, () => {
            commandSocket = socket;
            sendCommandHello();
            logger('info', 'Worker', 'Connected to Master command socket');
        });
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 6) {
                const idSize = buffer.readUInt8(0);
                const type = buffer.readUInt8(1);
                const payloadSize = buffer.readUInt32BE(2);
                const totalSize = 6 + idSize + payloadSize;
                if (buffer.length < totalSize)
                    break;
                const id = buffer.toString('utf8', 6, 6 + idSize);
                const payload = buffer.subarray(6 + idSize, totalSize);
                buffer = buffer.subarray(totalSize);
                if (type === 1) {
                    try {
                        const data = v8.deserialize(payload);
                        enqueueCommand(data?.type, id, data?.payload);
                    }
                    catch (e) {
                        logger('error', 'Worker', `Command socket parse error: ${getErrorMessage(e)}`);
                    }
                }
            }
        });
        socket.on('error', () => {
            commandSocket = null;
            setTimeout(connect, 1000);
        });
        socket.on('close', () => {
            commandSocket = null;
            setTimeout(connect, 1000);
        });
    };
    connect();
}
/**
 * Send a JSON-encoded event frame to the master process.
 */
function sendEventFrame(type, data) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const payload = JSON.stringify(data);
    const payloadBuf = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt8(0, 0); // No ID needed for these events
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    return eventSocket.write(Buffer.concat([header, payloadBuf]));
}
/**
 * Send a binary event frame to the master process.
 */
function sendEventBinaryFrame(type, payloadBuf) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const header = Buffer.alloc(6);
    header.writeUInt8(0, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    return eventSocket.write(Buffer.concat([header, payloadBuf]));
}
/**
 * Send a stream-scoped frame to the master process.
 */
function sendStreamFrame(streamId, type, payloadBuf) {
    if (!eventSocket || eventSocket.destroyed)
        return false;
    const idBuf = Buffer.from(streamId, 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt8(idBuf.length, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    return eventSocket.write(Buffer.concat([header, idBuf, payloadBuf]));
}
/**
 * Send a PCM chunk over the stream socket.
 */
function sendStreamChunk(streamId, chunk) {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sendStreamFrame(streamId, 5, payload);
}
function sendStreamEnd(streamId) {
    sendStreamFrame(streamId, 6, Buffer.alloc(0));
}
function sendStreamError(streamId, error) {
    const payload = Buffer.from(String(error || 'Unknown error'), 'utf8');
    sendStreamFrame(streamId, 7, payload);
}
/**
 * Send a binary command frame to the master process.
 */
function sendCommandFrame(type, requestId, payloadBuf) {
    if (!commandSocket || commandSocket.destroyed)
        return false;
    const idBuf = Buffer.from(requestId || '', 'utf8');
    const header = Buffer.alloc(6);
    header.writeUInt8(idBuf.length, 0);
    header.writeUInt8(type, 1);
    header.writeUInt32BE(payloadBuf.length, 2);
    return commandSocket.write(Buffer.concat([header, idBuf, payloadBuf]));
}
function sendCommandHello() {
    if (!commandSocket || commandSocket.destroyed)
        return false;
    const payload = Buffer.from(JSON.stringify({ pid: process.pid }), 'utf8');
    return sendCommandFrame(0, '', payload);
}
function sendCommandResult(requestId, payload) {
    const payloadBuf = v8.serialize(payload);
    if (sendCommandFrame(2, requestId, payloadBuf))
        return true;
    if (process.connected) {
        const sent = sendProcessMessage({ type: 'commandResult', requestId, payload }, (e) => {
            logger('error', 'Worker-IPC', `Failed to send commandResult for ${requestId}: ${getErrorMessage(e)}`);
        });
        if (sent)
            return true;
    }
    return false;
}
function sendCommandError(requestId, error) {
    const payloadBuf = v8.serialize(String(error || 'Unknown error'));
    if (sendCommandFrame(3, requestId, payloadBuf))
        return true;
    if (process.connected) {
        const sent = sendProcessMessage({ type: 'commandResult', requestId, error: String(error) }, (e) => {
            logger('error', 'Worker-IPC', `Failed to send commandResult (error) for ${requestId}: ${getErrorMessage(e)}`);
        });
        if (sent)
            return true;
    }
    return false;
}
const nodelink = {
    options: config,
    logger,
    voiceRelay: undefined,
    statsManager: null,
    credentialManager: null,
    trackCacheManager: null,
    sources: null,
    lyrics: null,
    meanings: null,
    routePlanner: null,
    connectionManager: null,
    pluginManager: null,
    extensions: {
        workerInterceptors: [],
        audioInterceptors: []
    },
    registerWorkerInterceptor: (fn) => {
        nodelink.extensions.workerInterceptors.push(fn);
        logger('info', 'Worker', 'Registered worker command interceptor');
    },
    registerSource: (name, source) => {
        if (!nodelink.sources) {
            logger('warn', 'Worker', 'Cannot register source (sources manager not ready).');
            return;
        }
        nodelink.sources.sources.set(name, source);
        logger('info', 'Worker', `Registered custom source: ${name}`);
    },
    registerFilter: (name, filter) => {
        if (!nodelink.extensions.filters)
            nodelink.extensions.filters = new Map();
        nodelink.extensions.filters.set(name, filter);
        logger('info', 'Worker', `Registered custom filter: ${name}`);
    },
    registerAudioInterceptor: (interceptor) => {
        if (!nodelink.extensions.audioInterceptors)
            nodelink.extensions.audioInterceptors = [];
        nodelink.extensions.audioInterceptors.push(interceptor);
        logger('info', 'Worker', 'Registered custom audio interceptor');
    }
};
const createdVoiceRelay = createVoiceRelay({
    enabled: config.voiceReceive?.enabled,
    format: config.voiceReceive?.format,
    sendFrame: (frame) => sendEventBinaryFrame(8, frame),
    logger
});
if (createdVoiceRelay) {
    nodelink.voiceRelay = createdVoiceRelay;
}
nodelink.statsManager = new StatsManager(nodelink);
nodelink.credentialManager = new CredentialManager(nodelink);
nodelink.trackCacheManager = new TrackCacheManager(nodelink);
await nodelink.trackCacheManager.load();
nodelink.sources = new SourceManager(nodelink);
nodelink.lyrics = new LyricsManager(nodelink);
nodelink.meanings = new MeaningManager(nodelink);
nodelink.routePlanner = new RoutePlannerManager(nodelink);
nodelink.connectionManager = new ConnectionManager(nodelink);
nodelink.pluginManager = new PluginManager(nodelink);
function setEfficiencyMode(enabled) {
    try {
        os.setPriority(process.pid, enabled
            ? os.constants.priority.PRIORITY_LOW
            : os.constants.priority.PRIORITY_HIGH);
        if (enabled) {
            v8.setFlagsFromString('--optimize-for-size');
        }
        else {
            v8.setFlagsFromString('--no-optimize-for-size');
        }
    }
    catch (_e) { }
}
function startTimers(hibernating = false) {
    if (playerUpdateTimer)
        clearInterval(playerUpdateTimer);
    if (statsUpdateTimer)
        clearInterval(statsUpdateTimer);
    const updateInterval = hibernating
        ? 60000
        : (config?.playerUpdateInterval ?? 5000);
    const statsInterval = hibernating
        ? 120000
        : config?.metrics?.enabled
            ? 5000
            : (config?.statsUpdateInterval ?? 30000);
    const zombieThreshold = config?.zombieThresholdMs ?? 60000;
    playerUpdateTimer = setInterval(() => {
        if (!process.connected)
            return;
        for (const player of players.values()) {
            if (player?.track && !player.isPaused && player.connection) {
                if (player._lastStreamDataTime &&
                    player._lastStreamDataTime > 0 &&
                    Date.now() - player._lastStreamDataTime >= zombieThreshold) {
                    logger('warn', 'Player', `Player for guild ${player.guildId} detected as zombie (no stream data).`);
                    player.emitEvent(GatewayEvents.TRACK_STUCK, {
                        guildId: player.guildId,
                        track: player.track,
                        reason: 'no_stream_data',
                        thresholdMs: zombieThreshold
                    });
                }
                try {
                    player._sendUpdate();
                }
                catch (updateError) {
                    logger('error', 'Worker', `Error during player update for guild ${player.guildId}: ${getErrorMessage(updateError)}`, updateError);
                }
            }
        }
    }, updateInterval);
    statsUpdateTimer = setInterval(() => {
        if (!process.connected)
            return;
        let localPlayers = 0;
        let localPlayingPlayers = 0;
        const localFrameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 };
        for (const player of players.values()) {
            localPlayers++;
            if (!player.isPaused && player.track) {
                localPlayingPlayers++;
            }
            if (player?.track && !player.isPaused && player.connection) {
                if (player.connection.statistics) {
                    const stats = player.connection.statistics;
                    localFrameStats.sent += stats?.packetsSent ?? 0;
                    localFrameStats.nulled += stats?.packetsLost ?? 0;
                    localFrameStats.expected += stats?.packetsExpected ?? 0;
                }
            }
        }
        localFrameStats.deficit += Math.max(0, localFrameStats.expected - localFrameStats.sent);
        if (localPlayers === 0 && HIBERNATION_ENABLED) {
            if (!isHibernating &&
                Date.now() - lastActivityTime > HIBERNATION_TIMEOUT) {
                logger('info', 'Worker', 'Worker entering hibernation mode (Efficiency Mode).');
                isHibernating = true;
                bufferPool.clear();
                cleanupHttpAgents();
                nodelink.connectionManager.stop();
                setEfficiencyMode(true);
                startTimers(true);
                const gcFn = global.gc;
                if (gcFn) {
                    let cycles = 0;
                    const aggressiveGC = setInterval(() => {
                        try {
                            gcFn();
                            cycles++;
                            if (cycles >= 3)
                                clearInterval(aggressiveGC);
                        }
                        catch (_e) {
                            clearInterval(aggressiveGC);
                        }
                    }, 1000);
                }
            }
        }
        else {
            lastActivityTime = Date.now();
            if (isHibernating) {
                isHibernating = false;
                setEfficiencyMode(false);
                nodelink.connectionManager.start();
                startTimers(false);
            }
        }
        try {
            const now = Date.now();
            const elapsedMs = now - lastCpuTime;
            const cpuUsage = process.cpuUsage(lastCpuUsage);
            lastCpuTime = now;
            lastCpuUsage = process.cpuUsage();
            const nodelinkLoad = elapsedMs > 0 ? (cpuUsage.user + cpuUsage.system) / 1000 / elapsedMs : 0;
            const mem = process.memoryUsage();
            const workerIdEnv = NODE_UNIQUE_ID;
            const stats = {
                workerId: parseInt(workerIdEnv ?? '0', 10) + 1,
                isHibernating,
                players: localPlayers,
                playingPlayers: localPlayingPlayers,
                commandQueueLength: Array.from(guildQueues.values()).reduce((acc, curr) => acc + curr.queue.length, 0),
                cpu: { nodelinkLoad },
                eventLoopLag: hndl.mean / 1e6,
                memory: {
                    used: mem.heapUsed,
                    allocated: mem.heapTotal
                },
                frameStats: localFrameStats
            };
            if (eventSocket && !eventSocket.destroyed) {
                sendEventFrame(4, stats);
            }
            else if (process.connected) {
                const success = sendProcessMessage({
                    type: 'workerStats',
                    pid: process.pid,
                    stats
                });
                if (!success) {
                    logger('warn', 'Worker-IPC', 'IPC channel saturated, skipping non-critical workerStats update.');
                }
            }
        }
        catch (e) {
            if (process.connected) {
                logger('error', 'Worker-IPC', `Failed to send workerStats: ${getErrorMessage(e)}`);
            }
        }
    }, statsInterval);
}
async function initialize() {
    await nodelink.credentialManager.load();
    await nodelink.sources.loadFolder();
    await nodelink.lyrics.loadFolder();
    await nodelink.meanings.loadFolder();
    await nodelink.statsManager.initialize();
    await nodelink.pluginManager.load('worker');
    lastActivityTime = Date.now();
    logger('info', 'Worker', `Worker process ${process.pid} started and initialized.`);
}
initialize();
startTimers(false);
process.on('uncaughtException', (err) => {
    const error = err;
    const isStreamAbort = error.message === 'aborted' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ERR_STREAM_PREMATURE_CLOSE';
    if (isStreamAbort) {
        logger('debug', 'Worker', `Stream disconnected: ${error.message}`);
        return;
    }
    logger('error', 'Worker–Crash', `Uncaught Exception: ${error.stack || error.message}`);
    process.stderr.write('', () => process.exit(1));
});
process.on('unhandledRejection', (reason, promise) => {
    logger('error', 'Worker-Crash', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
/**
 * Dispose of an active PCM stream entry and remove it from the registry.
 */
function cleanupActiveStream(streamId, entry) {
    const current = entry || activeStreams.get(streamId);
    if (!current)
        return;
    if (current.pcmStream && !current.pcmStream.destroyed) {
        current.pcmStream.destroy();
    }
    if (current.fetched?.stream && !current.fetched.stream.destroyed) {
        current.fetched.stream.destroy();
    }
    activeStreams.delete(streamId);
}
/**
 * Resolve and fetch a PCM stream, forwarding chunks through the event socket.
 */
async function startLoadStream(streamId, payload) {
    if (!eventSocket || eventSocket.destroyed) {
        throw new Error('Event socket unavailable');
    }
    const trackInfo = payload?.decodedTrackInfo;
    if (!trackInfo) {
        throw new Error('Invalid encoded track');
    }
    const urlResult = (await nodelink.sources.getTrackUrl(trackInfo));
    if (urlResult.exception) {
        throw new Error(urlResult.exception.message || 'Failed to get track URL');
    }
    const additionalData = {
        ...(urlResult.additionalData || {}),
        startTime: payload?.position || 0
    };
    const fetched = (await nodelink.sources.getTrackStream(urlResult.newTrack?.info || trackInfo, urlResult.url, urlResult.protocol, additionalData));
    if (fetched.exception) {
        throw new Error(fetched.exception.message || 'Failed to load stream');
    }
    const createPCMStream = await getCreatePCMStream();
    const pcmStream = createPCMStream(fetched.stream, fetched.type || urlResult.format || 'unknown', nodelink, (payload?.volume ?? 100) / 100, payload?.filters || {});
    const entry = { pcmStream, fetched, cancelled: false };
    activeStreams.set(streamId, entry);
    const finish = (err) => {
        if (entry.cancelled) {
            cleanupActiveStream(streamId, entry);
            return;
        }
        if (err)
            sendStreamError(streamId, getErrorMessage(err));
        else
            sendStreamEnd(streamId);
        cleanupActiveStream(streamId, entry);
    };
    pcmStream.on('data', (chunk) => {
        if (!entry.cancelled)
            sendStreamChunk(streamId, chunk);
    });
    pcmStream.once('end', () => finish());
    pcmStream.once('error', (err) => finish(err));
    pcmStream.once('close', () => finish());
}
function cancelStream(streamId) {
    const entry = activeStreams.get(streamId);
    if (!entry)
        return false;
    entry.cancelled = true;
    cleanupActiveStream(streamId, entry);
    return true;
}
/**
 * Process queued commands for a guild key sequentially.
 */
async function processQueue(queueKey) {
    const queueEntry = guildQueues.get(queueKey);
    if (!queueEntry || queueEntry.queue.length === 0) {
        if (queueEntry) {
            queueEntry.processing = false;
            if (queueEntry.queue.length === 0)
                guildQueues.delete(queueKey);
        }
        return;
    }
    queueEntry.processing = true;
    const queued = queueEntry.queue.shift();
    if (!queued) {
        queueEntry.processing = false;
        return;
    }
    const { type, requestId, payload } = queued;
    lastActivityTime = Date.now();
    if (isHibernating) {
        logger('info', 'Worker', 'Worker waking up from hibernation.');
        isHibernating = false;
        setEfficiencyMode(false);
        nodelink.connectionManager.start();
        startTimers(false);
    }
    // Execute Worker Interceptors
    const interceptors = nodelink.extensions.workerInterceptors;
    if (interceptors && interceptors.length > 0) {
        for (const interceptor of interceptors) {
            try {
                const shouldBlock = await interceptor(type, payload);
                if (shouldBlock === true) {
                    if (requestId)
                        sendCommandResult(requestId, { intercepted: true });
                    setImmediate(() => processQueue(queueKey));
                    return;
                }
            }
            catch (e) {
                logger('error', 'Worker', `Interceptor error: ${getErrorMessage(e)}`);
            }
        }
    }
    try {
        let result;
        switch (type) {
            case 'createPlayer': {
                const createPayload = payload;
                const { sessionId, guildId, userId, voice } = createPayload;
                if (!sessionId || !guildId || !userId) {
                    result = { created: false, reason: 'Invalid createPlayer payload' };
                    break;
                }
                const playerKey = `${sessionId}:${guildId}`;
                if (players.has(playerKey)) {
                    result = { created: false, reason: 'Player already exists' };
                    break;
                }
                const mockSession = {
                    id: sessionId,
                    userId,
                    isPaused: false,
                    eventQueue: [],
                    socket: {
                        send: (data) => {
                            if (eventSocket && !eventSocket.destroyed) {
                                sendEventFrame(3, { sessionId, guildId, data });
                            }
                            else if (process.connected) {
                                sendProcessMessage({
                                    type: 'playerEvent',
                                    payload: { sessionId, guildId, data }
                                }, (e) => {
                                    logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${getErrorMessage(e)}`);
                                });
                            }
                        }
                    }
                };
                const PlayerClass = await getPlayerClass();
                const player = new PlayerClass({
                    nodelink,
                    session: mockSession,
                    guildId
                });
                players.set(playerKey, player);
                if (voice)
                    player.updateVoice(voice);
                result = { created: true };
                break;
            }
            case 'destroyPlayer': {
                const { sessionId, guildId } = (payload ?? {});
                const playerKey = `${sessionId}:${guildId}`;
                const player = players.get(playerKey);
                if (player) {
                    player.destroy(false);
                    players.delete(playerKey);
                    if (process.connected) {
                        sendProcessMessage({
                            type: 'playerDestroyed',
                            payload: {
                                guildId,
                                userId: player.session?.userId,
                                sessionId
                            }
                        }, (e) => {
                            logger('error', 'Worker-IPC', `Failed to send playerDestroyed for guild ${guildId}: ${getErrorMessage(e)}`);
                        });
                    }
                    result = { destroyed: true };
                }
                else {
                    result = { destroyed: false, reason: 'Player not found in worker' };
                }
                break;
            }
            case 'restorePlayer': {
                const { snapshot } = (payload ?? {});
                if (!snapshot) {
                    result = { restored: false, reason: 'Missing snapshot payload' };
                    break;
                }
                const { guildId, sessionId, userId, track, position, isPaused, volume, filters, voice } = snapshot;
                const playerKey = `${sessionId}:${guildId}`;
                logger('info', 'Worker', `Restoring player for guild ${guildId} (session: ${sessionId}) (position: ${position}ms, paused: ${isPaused})`);
                const mockSession = {
                    id: sessionId,
                    userId,
                    isPaused: false,
                    eventQueue: [],
                    socket: {
                        send: (data) => {
                            if (eventSocket && !eventSocket.destroyed) {
                                sendEventFrame(3, { sessionId, guildId, data });
                            }
                            else if (process.connected) {
                                sendProcessMessage({
                                    type: 'playerEvent',
                                    payload: { sessionId, guildId, data }
                                }, (e) => {
                                    logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${getErrorMessage(e)}`);
                                });
                            }
                        }
                    }
                };
                const PlayerClass = await getPlayerClass();
                const player = new PlayerClass({
                    nodelink,
                    session: mockSession,
                    guildId
                });
                player._isRestoring = true;
                players.set(playerKey, player);
                if (voice)
                    player.updateVoice(voice);
                if (volume)
                    player.volume(volume);
                if (filters && Object.keys(filters).length > 0)
                    player.setFilters(filters);
                if (track) {
                    await player.play({ ...track, startTime: position });
                    if (isPaused) {
                        player.pause(true);
                    }
                }
                player._isRestoring = false;
                result = { restored: true };
                break;
            }
            case 'playerCommand': {
                const { sessionId, guildId, command, args } = (payload ?? {});
                const playerKey = `${sessionId}:${guildId}`;
                const player = players.get(playerKey);
                const target = player;
                const callable = target?.[command];
                if (player && typeof callable === 'function') {
                    result = await callable.apply(player, args ?? []);
                }
                else if (command === 'forceUpdate' &&
                    player &&
                    typeof player._sendUpdate === 'function') {
                    ;
                    player._sendUpdate();
                    result = { updated: true };
                }
                else {
                    result = {
                        error: `Player or command '${command}' not found for guild ${guildId} (session: ${sessionId})`,
                        playerNotFound: true
                    };
                }
                break;
            }
            case 'loadTracks': {
                const { identifier } = (payload ?? {});
                const re = /^(?:(?<url>(?:https?|ftts):\/\/\S+)|(?<source>[A-Za-z0-9]+):(?<query>[^/\s].*))$/i;
                const match = re.exec(identifier);
                if (!match)
                    throw new Error('Invalid identifier');
                const { url, source, query } = (match.groups ?? {});
                if (url)
                    result = await nodelink.sources.resolve(url);
                else if (source === 'search') {
                    if (!query)
                        throw new Error('Missing search query');
                    result = await nodelink.sources.unifiedSearch(query);
                }
                else {
                    if (!source || !query)
                        throw new Error('Missing source or query');
                    result = await nodelink.sources.search(source, query);
                }
                break;
            }
            case 'loadLyrics': {
                const { decodedTrackInfo, language } = (payload ?? {});
                const trackInfo = {
                    ...decodedTrackInfo,
                    artworkUrl: decodedTrackInfo.artworkUrl ?? null,
                    isrc: decodedTrackInfo.isrc ?? null,
                    uri: decodedTrackInfo.uri
                };
                result = await nodelink.lyrics.loadLyrics({ info: trackInfo }, language);
                break;
            }
            case 'loadMeaning': {
                const { decodedTrackInfo, language } = (payload ?? {});
                const trackInfo = {
                    ...decodedTrackInfo,
                    artworkUrl: decodedTrackInfo.artworkUrl ?? null,
                    isrc: decodedTrackInfo.isrc ?? null,
                    uri: decodedTrackInfo.uri
                };
                result = await nodelink.meanings.loadMeaning({ info: trackInfo }, language);
                break;
            }
            case 'loadChapters': {
                const { decodedTrackInfo } = (payload ?? {});
                result = await nodelink.sources.getChapters({ info: decodedTrackInfo });
                break;
            }
            case 'getSources': {
                result = nodelink.sources.getEnabledSourceNames();
                break;
            }
            case 'getTrackUrl': {
                const { decodedTrackInfo, itag } = (payload ?? {});
                result = await nodelink.sources.getTrackUrl(decodedTrackInfo, itag);
                break;
            }
            case 'loadStream': {
                const streamId = (payload ?? {})?.streamId || requestId;
                try {
                    await startLoadStream(streamId, payload);
                    result = { streaming: true, streamId };
                }
                catch (e) {
                    const errorMessage = getErrorMessage(e);
                    sendStreamError(streamId, errorMessage);
                    result = { streaming: false, error: errorMessage };
                }
                break;
            }
            case 'cancelStream': {
                const streamId = (payload ?? {})?.streamId || requestId;
                result = { cancelled: cancelStream(streamId) };
                break;
            }
            case 'updateYoutubeConfig': {
                try {
                    const { refreshToken, visitorData } = (payload ?? {});
                    const youtube = nodelink.sources.sources.get('youtube');
                    if (!youtube) {
                        result = {
                            success: false,
                            reason: 'YouTube source not loaded on this worker'
                        };
                        break;
                    }
                    if (refreshToken) {
                        if (youtube.oauth) {
                            youtube.oauth.refreshToken = refreshToken;
                            youtube.oauth.accessToken = null;
                            youtube.oauth.tokenExpiry = 0;
                            logger('info', 'Worker', 'YouTube OAuth refresh token updated via API.');
                        }
                        else {
                            logger('warn', 'Worker', 'Cannot update refreshToken: youtube.oauth is undefined.');
                        }
                    }
                    if (visitorData) {
                        if (youtube.ytContext?.client) {
                            youtube.ytContext.client.visitorData = visitorData;
                            logger('info', 'Worker', 'YouTube visitorData updated via API.');
                        }
                        else {
                            logger('warn', 'Worker', 'Cannot update visitorData: youtube.ytContext.client is undefined.');
                        }
                    }
                    result = { success: true };
                }
                catch (err) {
                    logger('error', 'Worker', `Error updating YouTube config: ${getErrorMessage(err)}`);
                    result = { success: false, error: getErrorMessage(err) };
                }
                break;
            }
            default:
                throw new Error(`Unknown command type: ${type}`);
        }
        if (requestId)
            sendCommandResult(requestId, result);
    }
    catch (e) {
        if (requestId)
            sendCommandError(requestId, getErrorMessage(e));
    }
    finally {
        const queueEntry = guildQueues.get(queueKey);
        if (queueEntry && queueEntry.queue.length > 0) {
            setImmediate(() => processQueue(queueKey));
        }
        else {
            if (queueEntry) {
                queueEntry.processing = false;
                if (queueEntry.queue.length === 0)
                    guildQueues.delete(queueKey);
            }
        }
    }
}
/**
 * Add a command to a guild queue and trigger processing.
 */
function enqueueCommand(type, requestId, payload) {
    if (!type || !requestId)
        return;
    const guildIdFromPayload = payload && typeof payload === 'object' && 'guildId' in payload
        ? payload.guildId || 'global'
        : 'global';
    const queueKey = PARALLEL_COMMANDS.has(type)
        ? `parallel:${requestId}`
        : guildIdFromPayload;
    if (!guildQueues.has(queueKey)) {
        guildQueues.set(queueKey, {
            queue: [],
            processing: false
        });
    }
    const queueEntry = guildQueues.get(queueKey);
    queueEntry?.queue.push({ type, requestId, payload });
    if (!queueEntry?.processing)
        setImmediate(() => processQueue(queueKey));
}
process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object')
        return;
    const message = msg;
    if (message.type === 'ping') {
        if (process.connected) {
            try {
                sendProcessMessage({ type: 'pong', timestamp: message.timestamp });
            }
            catch (e) {
                logger('error', 'Worker-IPC', `Failed to send pong: ${getErrorMessage(e)}`);
            }
        }
        return;
    }
    if (!message.type || !message.requestId)
        return;
    enqueueCommand(message.type, message.requestId, message.payload);
});
setTimeout(() => {
    if (process.connected) {
        try {
            sendProcessMessage({ type: 'ready', pid: process.pid });
        }
        catch (e) {
            logger('error', 'Worker-IPC', `Failed to send ready: ${getErrorMessage(e)}`);
        }
    }
}, 1000);
