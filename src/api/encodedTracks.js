import Joi from 'joi'
import {
  encodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const encodedTracksSchema = Joi.array()
  .items(
    Joi.object({
      encoded: Joi.string().required(),
      info: Joi.object().required()
    }).unknown(true) // Permitir outras propriedades no objeto track
  )
  .min(1)
  .messages({
    'array.base': 'tracks parameter must be an array.',
    'array.empty': 'tracks parameter cannot be an empty array.',
    'array.min': 'tracks parameter cannot be an empty array.',
    'string.base': 'Each item in tracks must be a string.',
    'any.required': 'tracks parameter is required.'
  })

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const { error, value } = encodedTracksSchema.validate(req.body)

  if (error) {
    sendErrorResponse(
      req,
      res,
      400,
      'Invalid request',
      error.details[0].message,
      parsedUrl.pathname,
      true
    )
    return
  }

  const tracks = value

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
