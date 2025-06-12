import { decodeTrack } from '../utils.js'

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const sessionId = parts[3]

  const session = nodelink.sessions.get(sessionId)

  if (!session) {
    return sendResponse(
      req,
      res,
      {
        timestamp: Date.now(),
        status: 404,
        error: 'Not Found',
        message: "The provided sessionId doesn't exist.",
        path: parsedUrl.pathname
      },
      404
    )
  }

  if (parsedUrl.pathname === `/v4/sessions/${sessionId}` && req.method === 'PATCH') {
    const payload = req.body
    const { resuming, timeout } = payload

    if (resuming !== undefined) {
      if (typeof resuming !== 'boolean') {
        return sendResponse(
          req,
          res,
          {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            message: 'The resuming value must be a boolean.',
            path: parsedUrl.pathname
          },
          400
        )
      }
      session.resuming = resuming
    }

    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || timeout < 0) {
        return sendResponse(
          req,
          res,
          {
            timestamp: Date.now(),
            status: 400,
            error: 'Bad Request',
            message: 'The timeout value must be a non-negative number.',
            path: parsedUrl.pathname
          },
          400
        )
      }
      session.timeout = timeout
    }

    return sendResponse(req, res, { resuming: session.resuming, timeout: session.timeout }, 200)
  }
}

export default {
  handler,
  methods: ['PATCH']
}
