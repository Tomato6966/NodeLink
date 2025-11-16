import myzod from 'myzod'
import {
  encodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const encodeTrackSchema = myzod.object({
  track: myzod.string()
})

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = encodeTrackSchema.try({
    track: parsedUrl.searchParams.get('track')
  })

  if (result instanceof myzod.ValidationError) {
    const errorMessage = result.message || 'Missing track parameter.'
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      errorMessage,
      parsedUrl.pathname,
      true
    )
    return
  }

  const track = result.track

  try {
    logger('debug', 'Tracks', `Encoding track: ${track}`)
    const encodedTrack = encodeTrack(track)
    sendResponse(req, res, encodedTrack, 200)
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
  }
}
export default {
  handler
}
