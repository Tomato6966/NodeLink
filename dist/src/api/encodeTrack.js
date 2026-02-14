import Validator from 'fastest-validator';
import { encodeTrack, logger, sendErrorResponse } from "../utils.js";
const v = new Validator({ haltOnFirstError: true });
const encodeTrackSchema = v.compile({
    track: { type: 'string', empty: false, messages: { required: 'Missing track parameter.', stringEmpty: 'Missing track parameter.' } }
});
function handler(_nodelink, req, res, sendResponse, parsedUrl) {
    const data = {
        track: parsedUrl.searchParams.get('track') ?? undefined
    };
    const validation = encodeTrackSchema(data);
    if (validation !== true) {
        const errorMessage = validation?.[0]?.message || 'Missing track parameter.';
        sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname, true);
        return;
    }
    const track = data.track;
    try {
        logger('debug', 'Tracks', `Encoding track: ${track}`);
        const encodedTrack = encodeTrack(track);
        sendResponse(req, res, encodedTrack, 200);
    }
    catch (err) {
        logger('error', 'Tracks', `Failed to encode track ${track}:`, err);
        sendErrorResponse(req, res, 500, 'Failed to encode track', err.message || 'Failed to encode track', parsedUrl.pathname, true);
    }
}
export default {
    handler
};
