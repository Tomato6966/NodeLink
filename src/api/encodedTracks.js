import Validator from 'fastest-validator'
import { encodeTrack, logger, sendErrorResponse } from '../utils.js'

const v = new Validator({ haltOnFirstError: true })

const encodedTracksSchema = v.compile({
  $$root: true,
  type: 'array',
  min: 1,
  items: {
    type: 'object',
    props: {
      encoded: { type: 'string', empty: false },
      info: { type: 'object', optional: false }
    },
    $$strict: false
  },
  messages: {
    arrayMin: 'tracks parameter must be an array and cannot be empty.'
  }
})

function handler(_nodelink, req, res, sendResponse, parsedUrl) {
  const validation = encodedTracksSchema(req.body)

  if (validation !== true) {
    const errorMessage =
      validation?.[0]?.message || 'tracks parameter must be an array and cannot be empty.'
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

  const tracks = req.body

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
