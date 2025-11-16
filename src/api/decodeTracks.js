import myzod from 'myzod'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const decodeTracksSchema = myzod.array(myzod.string()).min(1)

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = decodeTracksSchema.try(req.body)

  if (result instanceof myzod.ValidationError) {
    const errorMessage =
      result.message ||
      'encodedTracks parameter must be a non-empty array of strings.'
    sendErrorResponse(
      req,
      res,
      400,
      'Invalid request',
      errorMessage,
      parsedUrl.pathname,
      true
    )
    return
  }

  const encodedTracks = result

  const decodedTracks = []
  logger('debug', 'Tracks', `Decoding ${encodedTracks.length} tracks.`)
  for (const encodedTrack of encodedTracks) {
    try {
      const decodedTrack = decodeTrack(encodedTrack)
      decodedTracks.push(decodedTrack)
    } catch (err) {
      logger('error', 'Tracks', `Failed to decode track ${encodedTrack}:`, err)
      sendErrorResponse(
        req,
        res,
        500,
        'Failed to decode track',
        err.message || 'Failed to decode track',
        parsedUrl.pathname,
        true
      )
      return
    }
  }
  sendResponse(req, res, decodedTracks, 200)
}

export default {
  handler,
  methods: ['POST']
}
