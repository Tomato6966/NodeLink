import Validator from 'fastest-validator'
import { logger, sendErrorResponse } from '../utils.ts'

const v = new Validator({ haltOnFirstError: true })

const sessionPatchSchema = v.compile({
  resuming: { type: 'boolean', optional: true },
  timeout: { type: 'number', min: 0, optional: true },
  $$strict: false
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
    const validation = sessionPatchSchema(req.body)

    if (validation !== true) {
      const errorMessage = validation?.[0]?.message || 'Invalid PATCH payload'
      logger(
        'warn',
        'Session',
        `Invalid PATCH payload for session ${sessionId}: ${errorMessage}`
      )
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        errorMessage,
        parsedUrl.pathname
      )
    }

    const payload = req.body
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
