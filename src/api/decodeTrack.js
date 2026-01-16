import myzod from 'myzod'
import { decodeTrack, logger, sendErrorResponse } from '../utils.js'

const decodeTrackSchema = myzod.object({
  encodedTrack: myzod.string()
})

function handler(_nodelink, req, res, sendResponse, parsedUrl) {
  const result = decodeTrackSchema.try({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack')
  })

  if (result instanceof myzod.ValidationError) {
    const errorMessage = result.message || 'Missing encodedTrack parameter.'
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

  const encodedTrack = result.encodedTrack.replace(/ /g, '+')

  try {
    logger('debug', 'Tracks', `Decoding track: ${encodedTrack}`)
    const decodedTrack = decodeTrack(encodedTrack)
    if (decodedTrack.details) {
      decodedTrack.pluginInfo = {
        ...decodedTrack.pluginInfo,
        details: decodedTrack.details
      }

      delete decodedTrack.details
    }
    sendResponse(req, res, decodedTrack, 200)
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
  }
}
export default {
  handler
}
