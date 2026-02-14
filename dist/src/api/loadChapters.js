import Validator from 'fastest-validator';
import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
const v = new Validator({ haltOnFirstError: true });
const loadChaptersSchema = v.compile({
    encodedTrack: {
        type: 'string',
        empty: false,
        messages: {
            required: 'Missing encodedTrack parameter.',
            string: 'Missing encodedTrack parameter.',
            stringEmpty: 'Missing encodedTrack parameter.'
        }
    }
});
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const data = {
        encodedTrack: parsedUrl.searchParams.get('encodedTrack') ?? undefined
    };
    const validation = loadChaptersSchema(data);
    if (validation !== true) {
        const errorMessage = validation?.[0]?.message || 'Missing encodedTrack parameter.';
        return sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
    }
    const encodedTrack = data.encodedTrack.replace(/ /g, '+');
    try {
        const decodedTrack = decodeTrack(encodedTrack);
        if (!decodedTrack || !decodedTrack.info) {
            return sendErrorResponse(req, res, 400, 'Bad Request', 'The provided track is invalid.', parsedUrl.pathname);
        }
        if (decodedTrack.info.sourceName !== 'youtube' &&
            decodedTrack.info.sourceName !== 'ytmusic') {
            return sendResponse(req, res, [], 200);
        }
        logger('debug', 'Chapters', `Request to load chapters for: ${decodedTrack.info.title}`);
        let delegated = false;
        if (nodelink.sourceWorkerManager) {
            delegated = nodelink.sourceWorkerManager.delegate(req, res, 'loadChapters', {
                decodedTrackInfo: decodedTrack.info
            });
        }
        if (delegated)
            return;
        let chaptersData;
        if (nodelink.workerManager) {
            const worker = nodelink.workerManager.getBestWorker();
            chaptersData = await nodelink.workerManager.execute(worker, 'loadChapters', {
                decodedTrackInfo: decodedTrack.info
            });
        }
        else {
            chaptersData = await nodelink.sources.getChapters(decodedTrack);
        }
        sendResponse(req, res, chaptersData, 200);
    }
    catch (err) {
        logger('error', 'Chapters', 'Failed to load chapters:', err);
        sendErrorResponse(req, res, 500, 'Internal Server Error', err.message || 'Failed to load chapters.', parsedUrl.pathname, true);
    }
}
export default {
    handler
};
