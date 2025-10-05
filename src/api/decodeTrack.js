import { decodeTrack, logger, sendResponse } from '../utils.js'

function handler(nodelink, req, res, parsedUrl) {
  const encodedTrack = parsedUrl.searchParams.get('encodedTrack')
  if (!encodedTrack) {
    // biome-ignore format: off
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 404,
      error: 'missing encodedTrack parameter',
      trace: new Error().stack,
      message: 'encodedTrack parameter is required',
      path: parsedUrl.pathname
    }, 404)
    return
  }

  try {
    logger('debug', 'Tracks', `Decoding track: ${encodedTrack}`)
    const decodedTrack = decodeTrack(encodedTrack)
    sendResponse(req, res, decodedTrack, 200)
  } catch (error) {
    logger('error', 'Tracks', `Failed to decode track ${encodedTrack}:`, error)
    // biome-ignore format: off
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 500,
      error: 'Failed to decode track',
      trace: new Error().stack,
      message: error.message || 'Failed to decode track',
      path: parsedUrl.pathname
    }, 500)
  }
}
export default {
  handler
}
