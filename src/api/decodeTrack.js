import Joi from 'joi'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const decodeTrackSchema = Joi.object({
  encodedTrack: Joi.string().required().messages({
    'string.empty': 'encodedTrack parameter cannot be empty.',
    'any.required': 'Missing encodedTrack parameter.'
  })
})

function handler(nodelink, req, res, parsedUrl) {
  const { error, value } = decodeTrackSchema.validate({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack')
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

  const encodedTrack = value.encodedTrack

  try {
    logger('debug', 'Tracks', `Decoding track: ${encodedTrack}`)
    const decodedTrack = decodeTrack(encodedTrack)
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
