import Joi from 'joi'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const sessionPatchSchema = Joi.object({
  resuming: Joi.boolean().optional().messages({
    'boolean.base': 'The resuming value must be a boolean.'
  }),
  timeout: Joi.number().integer().min(0).optional().messages({
    'number.base': 'The timeout value must be a number.',
    'number.integer': 'The timeout value must be an integer.',
    'number.min': 'The timeout value must be a non-negative number.'
  })
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const sessionId = parts[3]

  const session = nodelink.sessions.get(sessionId)

  if (!session) {
    return sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.', parsedUrl.pathname"
    )
  }

  if (
    parsedUrl.pathname === `/v4/sessions/${sessionId}` &&
    req.method === 'PATCH'
  ) {
    const { error, value } = sessionPatchSchema.validate(req.body)

    if (error) {
      logger(
        'warn',
        'Session',
        `Invalid PATCH payload for session ${sessionId}: ${error.details[0].message}`
      )
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        error.details[0].message,
        parsedUrl.pathname
      )
    }

    const payload = value
    logger(
      'debug',
      'Session',
      `Received PATCH for session ${sessionId}:`,
      payload
    )

    const { resuming, timeout } = payload

    if (resuming !== undefined) {
      session.resuming = resuming
    }

    if (timeout !== undefined) {
      session.timeout = timeout
    }

    logger('debug', 'Session', `Updated session ${sessionId}:`, {
      resuming: session.resuming,
      timeout: session.timeout
    })
    return sendResponse(
      req,
      res,
      { resuming: session.resuming, timeout: session.timeout },
      200
    )
  }
}

export default {
  handler,
  methods: ['PATCH']
}
