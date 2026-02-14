import Validator from 'fastest-validator';
import { logger, sendErrorResponse } from "../utils.js";
const v = new Validator({ haltOnFirstError: true });
const updateMixSchema = v.compile({
    volume: { type: 'number', min: 0, max: 1, optional: false },
    $$strict: false
});
const pathSchema = v.compile({
    sessionId: { type: 'string', empty: false },
    guildId: { type: 'string', pattern: /^\d{17,20}$/, messages: { stringPattern: 'guildId must be 17-20 digits' } },
    mixId: { type: 'string', empty: false }
});
async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
    const method = req.method;
    const pathParts = parsedUrl.pathname.split('/');
    const sessionId = pathParts[3];
    const guildId = pathParts[5];
    const mixId = pathParts[7];
    const validation = pathSchema({ sessionId, guildId, mixId });
    if (validation !== true) {
        return sendErrorResponse(req, res, 400, validation?.[0]?.message || 'Invalid path parameters');
    }
    if (method === 'PATCH') {
        return handleUpdateMix(req, res, sessionId, guildId, mixId, nodelink);
    }
    if (method === 'DELETE') {
        return handleDeleteMix(req, res, sessionId, guildId, mixId, nodelink);
    }
    return sendErrorResponse(req, res, 405, 'Method Not Allowed');
}
async function handleUpdateMix(req, res, sessionId, guildId, mixId, nodelink) {
    try {
        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            }
            catch {
                return sendErrorResponse(req, res, 400, 'Invalid JSON body');
            }
        }
        const bodyValidation = updateMixSchema(body);
        if (bodyValidation !== true) {
            return sendErrorResponse(req, res, 400, bodyValidation?.[0]?.message || 'Invalid parameters');
        }
        const session = nodelink.sessions.get(sessionId);
        if (!session) {
            return sendErrorResponse(req, res, 404, 'Session not found');
        }
        if (!session.players) {
            return sendErrorResponse(req, res, 500, 'Player manager not initialized');
        }
        const updated = await session.players.updateMix(guildId, mixId, body.volume);
        if (!updated) {
            return sendErrorResponse(req, res, 404, 'Mix not found');
        }
        logger('debug', 'MixAPI', `Updated mix ${mixId} volume to ${body.volume} for guild ${guildId}`);
        res.writeHead(204);
        res.end();
    }
    catch (error) {
        logger('error', 'MixAPI', `Error updating mix: ${error.message}`);
        return sendErrorResponse(req, res, 500, error.message);
    }
}
async function handleDeleteMix(req, res, sessionId, guildId, mixId, nodelink) {
    try {
        const session = nodelink.sessions.get(sessionId);
        if (!session) {
            return sendErrorResponse(req, res, 404, 'Session not found');
        }
        if (!session.players) {
            return sendErrorResponse(req, res, 500, 'Player manager not initialized');
        }
        const removed = await session.players.removeMix(guildId, mixId);
        if (!removed) {
            return sendErrorResponse(req, res, 404, 'Mix not found');
        }
        logger('debug', 'MixAPI', `Removed mix ${mixId} for guild ${guildId}`);
        res.writeHead(204);
        res.end();
    }
    catch (error) {
        logger('error', 'MixAPI', `Error removing mix: ${error.message}`);
        return sendErrorResponse(req, res, 500, error.message);
    }
}
export default {
    handler,
    methods: ['PATCH', 'DELETE']
};
