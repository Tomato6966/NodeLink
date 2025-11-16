import myzod from 'myzod'
import {
  encodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const encodedTracksSchema = myzod
  .array(
    myzod
      .object({
        encoded: myzod.string(),
        info: myzod.object({}).allowUnknownKeys()
      })
      .allowUnknownKeys()
  )
  .min(1)

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = encodedTracksSchema.try(req.body)

  if (result instanceof myzod.ValidationError) {
    const errorMessage =
      result.message || 'tracks parameter must be an array and cannot be empty.'
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

  const tracks = result

  const encodedTracks = []
  logger('debug', 'Tracks', `Encoding ${tracks.length} tracks.`)
  for (const track of tracks) {
    try {
      const encodedTrack = encodeTrack(track)
      encodedTracks.push(encodedTrack)
    } catch (err) {
      logger('error', 'Tracks', `Failed to encode track ${track}:`, err)
      sendErrorResponse(
        req,
        res,
        500,
        'Failed to encode track',
        err.message || 'Failed to encode track',
        parsedUrl.pathname,
        true
      )
      return
    }
  }
  sendResponse(req, res, encodedTracks, 200)
}

export default {
  handler,
  methods: ['POST']
}
