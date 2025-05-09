import { encodeTrack } from '../utils.js'

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const tracks = req.body // [{ encoded: "", info: {...}}, {}]
  if (!tracks || !Array.isArray(tracks)) {
    // biome-ignore format: off
    sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Invalid request',
        message: 'tracks parameter is required and should be an array',
        path: parsedUrl.pathname
      }, 400)
    return
  }
  const encodedTracks = []
  for (const track of tracks) {
    try {
      const encodedTrack = encodeTrack(track)
      encodedTracks.push(encodedTrack)
    } catch (error) {
      // biome-ignore format: off
      sendResponse(req, res, {
                timestamp: Date.now(),
                status: 500,
                trace: new Error().stack,
                error: 'Failed to encode track',
                message: error.message || 'Failed to encode track',
                path: parsedUrl.pathname
            }, 500)
      return
    }
    sendResponse(req, res, encodedTracks, 200)
  }
}

export default {
  handler,
  methods: ['POST']
}
