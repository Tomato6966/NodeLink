import { decodeTrack, logger } from '../utils.js'

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const encodedTracks = req.body // ["encodedTrack1", "encodedTrack2"]
  if (!encodedTracks || !Array.isArray(encodedTracks)) {
    // biome-ignore format: off
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Invalid request',
      message: 'encodedTracks parameter is required and should be an array',
      path: parsedUrl.pathname
    }, 400)
    return
  }
  const decodedTracks = []
  logger('debug', 'Tracks', `Decoding ${encodedTracks.length} tracks.`)
  for (const encodedTrack of encodedTracks) {
    try {
      const decodedTrack = decodeTrack(encodedTrack)
      decodedTracks.push(decodedTrack)
    } catch (error) {
      logger(
        'error',
        'Tracks',
        `Failed to decode track ${encodedTrack}:`,
        error
      )
      // biome-ignore format: off
      sendResponse(req, res, {
          timestamp: Date.now(),
          status: 500,
          trace: new Error().stack,
          error: 'Failed to decode track',
          message: error.message || 'Failed to decode track',
          path: parsedUrl.pathname
        }, 500)
      return
    }
  }
  sendResponse(req, res, decodedTracks, 200)
}

export default {
  handler,
  methods: ['POST']
}
