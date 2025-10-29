import Joi from 'joi'
import {
  encodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'
const encodeTrackSchema = Joi.object({
  track: Joi.string().required().messages({
    'string.empty': 'track parameter cannot be empty.',
    'any.required': 'Missing track parameter.'
  })
})

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const { error, value } = encodeTrackSchema.validate({
    track: parsedUrl.searchParams.get('track')
  })

  if (error) {
    sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      error.details[0].message,
      parsedUrl.pathname,
      true
    )
    return
  }

  const track = value.track

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
