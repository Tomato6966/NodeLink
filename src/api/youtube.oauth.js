import myzod from 'myzod'
import { logger, sendResponse, sendErrorResponse, makeRequest } from '../utils.js'

const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT'

const schema = myzod.object({
  refreshToken: myzod.string().min(1)
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  let refreshToken = null

  if (req.method === 'GET') {
    refreshToken = parsedUrl.searchParams.get('refreshToken')
  } else if (req.method === 'POST') {
    const body = req.body
    if (body && body.refreshToken) {
      refreshToken = body.refreshToken
    }
  }

  if (!refreshToken) {
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Missing refreshToken parameter.',
      parsedUrl.pathname
    )
  }

  try {
    const { body, error, statusCode } = await makeRequest(
      'https://www.youtube.com/o/oauth2/token',
      {
        method: 'POST',
        body: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }
      }
    )

    if (error || statusCode !== 200) {
      const msg = error?.message || body?.error_description || 'Failed to refresh token'
      return sendErrorResponse(req, res, 500, 'Internal Server Error', msg, parsedUrl.pathname)
    }

    if (body.error) {
      return sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        body.error_description || body.error,
        parsedUrl.pathname
      )
    }

    return sendResponse(req, res, body, 200)
  } catch (e) {
    logger('error', 'API', `OAuth refresh failed: ${e.message}`)
    return sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      e.message,
      parsedUrl.pathname
    )
  }
}

export default {
  handler,
  methods: ['GET', 'POST']
}
