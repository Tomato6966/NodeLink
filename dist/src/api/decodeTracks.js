import Validator from 'fastest-validator';
import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
const v = new Validator({ haltOnFirstError: true });
const decodeTracksSchema = v.compile({
    $$root: true,
    type: 'array',
    items: 'string',
    min: 1,
    messages: {
        arrayMin: 'encodedTracks parameter must be a non-empty array of strings.',
        array: 'encodedTracks parameter must be a non-empty array of strings.'
    }
});
function handler(_nodelink, req, res, sendResponse, parsedUrl) {
    const validation = decodeTracksSchema(req.body);
    if (validation !== true) {
        const errorMessage = validation?.[0]?.message || 'encodedTracks parameter must be a non-empty array of strings.';
        sendErrorResponse(req, res, 400, 'Invalid request', errorMessage, parsedUrl.pathname, true);
        return;
    }
    const encodedTracks = req.body;
    const decodedTracks = [];
    logger('debug', 'Tracks', `Decoding ${encodedTracks.length} tracks.`);
    for (const encodedTrack of encodedTracks) {
        try {
            const decodedTrack = decodeTrack(encodedTrack);
            decodedTracks.push(decodedTrack);
        }
        catch (err) {
            logger('error', 'Tracks', `Failed to decode track ${encodedTrack}:`, err);
            sendErrorResponse(req, res, 500, 'Failed to decode track', err.message || 'Failed to decode track', parsedUrl.pathname, true);
            return;
        }
    }
    sendResponse(req, res, decodedTracks, 200);
}
export default {
    handler,
    methods: ['POST']
};
