import Validator from 'fastest-validator'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

const v = new Validator({ haltOnFirstError: true })

const checkDecodeTrack = v.compile({
  encodedTrack: {
    type: 'string',
    empty: false,
    messages: {
      required: 'Missing encodedTrack parameter.',
      string: 'Missing encodedTrack parameter.',
      stringEmpty: 'Missing encodedTrack parameter.'
    }
  }
})

function handler(_nodelink, req, res, sendResponse, parsedUrl) {
  const data = {
    encodedTrack: parsedUrl.searchParams.get('encodedTrack') ?? undefined
  }

  const validation = checkDecodeTrack(data)

  if (validation !== true) {
    const errorMessage = validation?.[0]?.message || 'Missing encodedTrack parameter.'
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

  const encodedTrack = data.encodedTrack.replace(/ /g, '+')

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