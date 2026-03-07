import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
import { validator } from "../validators.js";
const filtersSchema = { type: 'any', optional: true };
const voiceStateSchema = {
    type: 'object',
    props: {
        token: { type: 'string', empty: false },
        endpoint: { type: 'string', empty: false },
        sessionId: { type: 'string', empty: false },
        channelId: { type: 'string', optional: true }
    },
    $$strict: false
};
const updatePlayerTrackSchema = {
    type: 'object',
    props: {
        encoded: { type: 'string', nullable: true, optional: true },
        identifier: { type: 'string', optional: true },
        userData: { type: 'any', optional: true }
    },
    $$strict: false
};
const updatePlayerSchema = validator.compile({
    track: { ...updatePlayerTrackSchema, optional: true },
    nextTrack: { ...updatePlayerTrackSchema, optional: true, nullable: true },
    encodedTrack: { type: 'string', nullable: true, optional: true },
    position: { type: 'number', min: 0, optional: true },
    endTime: { type: 'number', min: 0, nullable: true, optional: true },
    volume: { type: 'number', min: 0, max: 1000, optional: true },
    paused: { type: 'boolean', optional: true },
    loudnessNormalizer: { type: 'boolean', optional: true },
    filters: filtersSchema,
    fading: { type: 'any', optional: true },
    crossfade: { type: 'any', optional: true },
    voice: { ...voiceStateSchema, optional: true },
    guildId: { type: 'string', optional: true },
    $$strict: false
});
const queryParamsSchema = validator.compile({
    noReplace: { type: 'string', nullable: true, optional: true },
    $$strict: false
});
const pathSchema = validator.compile({
    sessionId: { type: 'string', empty: false },
    guildId: {
        type: 'string',
        pattern: /^\d{17,20}$/,
        optional: true,
        messages: { stringPattern: 'guildId must be 17-20 digits' }
    }
});
const sanitizeFadingConfig = (raw) => {
    const safe = {
        enabled: false,
        trackStart: { duration: 0, curve: 'linear', type: 'volume' },
        trackEnd: { duration: 0, curve: 'linear', type: 'volume' },
        trackStop: { duration: 0, curve: 'linear', type: 'volume' },
        seek: { duration: 0, curve: 'linear', type: 'volume' },
        pause: { duration: 0, curve: 'linear', type: 'volume' },
        resume: { duration: 0, curve: 'linear', type: 'volume' },
        ducking: {
            enabled: false,
            duration: 0,
            targetVolume: 0.3,
            curve: 'linear'
        }
    };
    if (!raw || typeof raw !== 'object')
        return safe;
    safe.enabled = raw.enabled === true;
    const updateSection = (key) => {
        const section = raw[key];
        if (!section || typeof section !== 'object')
            return;
        if (Number.isFinite(section.duration)) {
            safe[key].duration = Math.max(0, section.duration);
        }
        if (typeof section.curve === 'string') {
            safe[key].curve = section.curve;
        }
        if (['volume', 'tape', 'scratch', 'both'].includes(section.type)) {
            safe[key].type = section.type;
        }
    };
    updateSection('trackStart');
    updateSection('trackEnd');
    updateSection('trackStop');
    updateSection('seek');
    updateSection('pause');
    updateSection('resume');
    if (raw.ducking && typeof raw.ducking === 'object') {
        safe.ducking.enabled = raw.ducking.enabled === true;
        if (Number.isFinite(raw.ducking.duration)) {
            safe.ducking.duration = Math.max(0, raw.ducking.duration);
        }
        if (Number.isFinite(raw.ducking.targetVolume)) {
            safe.ducking.targetVolume = Math.max(0, Math.min(1, raw.ducking.targetVolume));
        }
        if (typeof raw.ducking.curve === 'string') {
            safe.ducking.curve = raw.ducking.curve;
        }
    }
    return safe;
};
const sanitizeCrossfadeConfig = (raw) => {
    const safe = {
        enabled: false,
        duration: 0,
        curve: 'sinusoidal',
        mode: 'preload',
        minBufferMs: 250,
        bufferMs: 0
    };
    if (!raw || typeof raw !== 'object')
        return safe;
    safe.enabled = raw.enabled === true;
    if (Number.isFinite(raw.duration)) {
        safe.duration = Math.max(0, raw.duration);
    }
    if (typeof raw.curve === 'string') {
        safe.curve = raw.curve;
    }
    if (raw.mode === 'stream' || raw.mode === 'preload') {
        safe.mode = raw.mode;
    }
    if (Number.isFinite(raw.minBufferMs)) {
        safe.minBufferMs = Math.max(0, raw.minBufferMs);
    }
    if (Number.isFinite(raw.bufferMs)) {
        safe.bufferMs = Math.max(0, raw.bufferMs);
    }
    safe.triggerNow = raw.triggerNow === true;
    return safe;
};
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const parts = parsedUrl.pathname.split('/');
    const pathParams = {
        sessionId: parts[3],
        guildId: parts[5]
    };
    const validation = pathSchema(pathParams);
    if (validation !== true) {
        const errorMessage = validation?.[0]?.message || 'Invalid path parameters';
        logger('warn', 'PlayerUpdate', `Invalid path parameters: ${errorMessage}`);
        return sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
    }
    const { sessionId, guildId } = pathParams;
    const session = nodelink.sessions.get(sessionId);
    if (!session) {
        return sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", parsedUrl.pathname);
    }
    if (!guildId && parsedUrl.pathname === `/v4/sessions/${sessionId}/players`) {
        if (req.method === 'GET') {
            if (nodelink.workerManager) {
                const playerKeys = Array.from(nodelink.workerManager.guildToWorker.keys());
                const sessionPlayerKeys = playerKeys.filter((key) => key.startsWith(`${session.id}:`));
                const guildIds = sessionPlayerKeys.map((key) => key.split(':')[1]);
                const players = await Promise.all(guildIds.map((gid) => session.players.toJSON(gid).catch((err) => {
                    logger('error', 'PlayerList', `Failed to get player JSON for guild ${gid}: ${err.message}`);
                    return null;
                })));
                return sendResponse(req, res, players.filter((p) => p !== null), 200);
            }
            const players = await Promise.all(Array.from(session.players.players.values()).map((player) => session.players.toJSON(player.guildId)));
            return sendResponse(req, res, players, 200);
        }
    }
    if (guildId) {
        try {
            if (req.method === 'GET') {
                await session.players.create(guildId);
                const playerJson = await session.players.toJSON(guildId);
                return sendResponse(req, res, playerJson, 200);
            }
            if (req.method === 'DELETE') {
                await session.players.destroy(guildId);
                return sendResponse(req, res, null, 204);
            }
            if (req.method === 'PATCH') {
                const bodyValidation = updatePlayerSchema(req.body);
                if (bodyValidation !== true) {
                    const errorMessage = bodyValidation?.[0]?.message || 'Invalid payload';
                    logger('warn', 'PlayerUpdate', `Invalid payload for guild ${guildId}: ${errorMessage}`);
                    return sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
                }
                const payload = req.body;
                const queryValidation = queryParamsSchema({
                    noReplace: parsedUrl.searchParams.get('noReplace')
                });
                if (queryValidation !== true) {
                    return sendErrorResponse(req, res, 400, 'Bad Request', queryValidation?.[0]?.message || 'Invalid query parameters', parsedUrl.pathname);
                }
                const noReplace = parsedUrl.searchParams.get('noReplace') === 'true';
                await session.players.create(guildId);
                if (payload.voice) {
                    await session.players.updateVoice(guildId, payload.voice);
                }
                let trackToPlay = null;
                let stopPlayer = false;
                const userData = payload.track?.userData;
                const trackPayload = payload.track;
                const nextTrackPayload = payload.nextTrack;
                const legacyEncodedTrack = payload.encodedTrack;
                if (legacyEncodedTrack) {
                    return sendErrorResponse(req, res, 400, 'Bad Request', 'The `encodedTrack` field is deprecated. Use `track.encoded` instead.', parsedUrl.pathname);
                }
                if (trackPayload) {
                    if (trackPayload.encoded !== undefined) {
                        if (trackPayload.encoded === null) {
                            stopPlayer = true;
                        }
                        else {
                            const decodedTrack = decodeTrack(trackPayload.encoded);
                            if (!decodedTrack) {
                                return sendErrorResponse(req, res, 400, 'Bad Request', 'The provided track is invalid.', parsedUrl.pathname);
                            }
                            trackToPlay = {
                                encoded: trackPayload.encoded,
                                info: decodedTrack.info,
                                audioTrackId: trackPayload.language || trackPayload.audioTrackId || null
                            };
                        }
                    }
                    else if (trackPayload.identifier) {
                        if (!nodelink.loadTrack) {
                            return sendErrorResponse(req, res, 500, 'Internal Server Error', 'Track identifier loading is not supported.', parsedUrl.pathname);
                        }
                        const loadResult = await nodelink.loadTrack(trackPayload.identifier);
                        if (loadResult.loadType === 'track') {
                            trackToPlay = {
                                encoded: loadResult.data.encoded,
                                info: loadResult.data.info,
                                audioTrackId: trackPayload.language || trackPayload.audioTrackId || null
                            };
                        }
                        else {
                            const message = loadResult.loadType === 'empty'
                                ? 'Track identifier resolved to no tracks.'
                                : `Track identifier resolved to ${loadResult.loadType}, expected 'track'.`;
                            return sendErrorResponse(req, res, 400, 'Bad Request', message, parsedUrl.pathname);
                        }
                    }
                }
                const shouldClearNextTrack = nextTrackPayload === null || nextTrackPayload?.encoded === null;
                if (shouldClearNextTrack) {
                    await session.players.clearNextTrack(guildId);
                }
                else if (nextTrackPayload) {
                    let trackToPreload = null;
                    if (nextTrackPayload.encoded !== undefined) {
                        const decodedTrack = decodeTrack(nextTrackPayload.encoded);
                        if (decodedTrack) {
                            trackToPreload = {
                                encoded: nextTrackPayload.encoded,
                                info: decodedTrack.info,
                                audioTrackId: nextTrackPayload.language ||
                                    nextTrackPayload.audioTrackId ||
                                    null,
                                userData: nextTrackPayload.userData
                            };
                        }
                    }
                    else if (nextTrackPayload.identifier && nodelink.loadTrack) {
                        const loadResult = await nodelink.loadTrack(nextTrackPayload.identifier);
                        if (loadResult.loadType === 'track') {
                            trackToPreload = {
                                encoded: loadResult.data.encoded,
                                info: loadResult.data.info,
                                audioTrackId: nextTrackPayload.language ||
                                    nextTrackPayload.audioTrackId ||
                                    null,
                                userData: nextTrackPayload.userData
                            };
                        }
                    }
                    if (trackToPreload) {
                        await session.players.preload(guildId, trackToPreload);
                    }
                }
                if (stopPlayer) {
                    await session.players.stop(guildId);
                }
                if (trackToPlay) {
                    await session.players.play(guildId, {
                        ...trackToPlay,
                        userData,
                        noReplace,
                        startTime: payload.position,
                        endTime: payload.endTime || undefined
                    });
                }
                if (payload.volume !== undefined) {
                    await session.players.volume(guildId, payload.volume);
                }
                if (payload.paused !== undefined) {
                    await session.players.pause(guildId, payload.paused);
                }
                if (payload.position !== undefined && !trackToPlay) {
                    await session.players.seek(guildId, payload.position);
                }
                if (payload.endTime !== undefined) {
                    const playerState = await session.players.toJSON(guildId);
                    await session.players.seek(guildId, playerState.state.position, payload.endTime);
                }
                if (payload.filters !== undefined) {
                    await session.players.setFilters(guildId, payload);
                }
                if (payload.fading !== undefined) {
                    await session.players.setFading(guildId, sanitizeFadingConfig(payload.fading));
                }
                if (payload.crossfade !== undefined) {
                    const sanitizedCrossfade = sanitizeCrossfadeConfig(payload.crossfade);
                    await session.players.setCrossfade(guildId, sanitizedCrossfade);
                    if (sanitizedCrossfade.triggerNow) {
                        const player = session.players.get(guildId);
                        if (player) {
                            const duration = Number.isFinite(payload.crossfade.duration)
                                ? payload.crossfade.duration
                                : undefined;
                            await player.triggerCrossfade(duration);
                        }
                    }
                }
                if (payload.loudnessNormalizer !== undefined) {
                    await session.players.setLoudnessNormalizer(guildId, payload.loudnessNormalizer);
                }
                const playerJson = await session.players.toJSON(guildId);
                return sendResponse(req, res, playerJson, 200);
            }
        }
        catch (error) {
            if (error.message.toLowerCase().includes('player not found') ||
                error.message.toLowerCase().includes('player not assigned')) {
                return sendErrorResponse(req, res, 404, 'Not Found', error.message, parsedUrl.pathname);
            }
            logger('error', 'PlayerUpdate', `Unhandled error: ${error.message}`, error);
            return sendErrorResponse(req, res, 500, 'Internal Server Error', error.message, parsedUrl.pathname, true);
        }
    }
}
export default {
    handler,
    methods: ['GET', 'DELETE', 'PATCH']
};
