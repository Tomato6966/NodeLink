import { encodeTrack } from '../utils.js'
function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const track = parsedUrl.searchParams.get('track')
  if (!track) {
    // biome-ignore format: off
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'missing track parameter',
      trace: new Error().stack,
      message: 'track parameter is required',
      path: parsedUrl.pathname
    }, 404)
    return
  }
  try {
    const encodedTrack = encodeTrack(track)
    sendResponse(req, res, encodedTrack, 200)
  } catch (error) {
    // biome-ignore format: off
    sendResponse(req, res, {
            timestamp: Date.now(),
            status: 500,
            error: 'Failed to encode track',
            trace: new Error().stack,
            message: error.message || 'Failed to encode track',
            path: parsedUrl.pathname
        }, 500)
  }
}
export default {
  handler
}
