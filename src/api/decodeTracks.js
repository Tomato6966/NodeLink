import Joi from 'joi'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const decodeTracksSchema = Joi.array()
  .items(Joi.string().required())
  .min(1)
  .messages({
    'array.base': 'encodedTracks parameter must be an array.',
    'array.empty': 'encodedTracks parameter cannot be an empty array.',
    'array.min': 'encodedTracks parameter cannot be an empty array.',
    'string.base': 'Each item in encodedTracks must be a string.',
    'any.required': 'encodedTracks parameter is required.'
  })

function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const { error, value } = decodeTracksSchema.validate(req.body)

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

  const encodedTracks = value // Joi já validou e retornou o array

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
