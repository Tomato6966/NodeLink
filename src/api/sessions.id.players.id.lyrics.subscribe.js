import Validator from 'fastest-validator'
import { logger, sendErrorResponse } from '../utils.js'

const v = new Validator({ haltOnFirstError: true })

const querySchema = v.compile({
  skipTrackSource: { type: 'string', optional: true }
})

const pathSchema = v.compile({
  sessionId: { type: 'string', empty: false },
  guildId: { type: 'string', pattern: /^\d{17,20}$/, messages: { stringPattern: 'guildId must be 17-20 digits' } }
})

async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
  const method = req.method
  const pathParts = parsedUrl.pathname.split('/')
  const sessionId = pathParts[3]
  const guildId = pathParts[5]

  const validation = pathSchema({ sessionId, guildId })
  if (validation !== true) {
    return sendErrorResponse(req, res, 400, validation?.[0]?.message || 'Invalid path parameters')
  }

  const session = nodelink.sessions.get(sessionId)
  if (!session) {
    return sendErrorResponse(req, res, 404, 'Session not found')
  }

  if (!session.players) {
    return sendErrorResponse(req, res, 500, 'Player manager not initialized')
  }

  if (method === 'POST') {
    const queryData = {
      skipTrackSource: parsedUrl.searchParams.get('skipTrackSource') ?? undefined
    }
    const queryValidation = querySchema(queryData)

    if (queryValidation !== true) {
      return sendErrorResponse(req, res, 400, queryValidation?.[0]?.message || 'Invalid parameters')
    }

    const skipTrackSource = queryData.skipTrackSource === 'true'

    try {
        await session.players.subscribeLyrics(guildId, skipTrackSource)
        res.writeHead(204)
        res.end()
    } catch (error) {
        logger('error', 'LyricsAPI', `Error subscribing to lyrics: ${error.message}`)
        return sendErrorResponse(req, res, 500, error.message)
    }
    return
  }

  if (method === 'DELETE') {
    try {
        await session.players.unsubscribeLyrics(guildId)
        res.writeHead(204)
        res.end()
    } catch (error) {
        logger('error', 'LyricsAPI', `Error unsubscribing from lyrics: ${error.message}`)
        return sendErrorResponse(req, res, 500, error.message)
    }
    return
  }

  return sendErrorResponse(req, res, 405, 'Method Not Allowed')
}

export default {
  handler,
  methods: ['POST', 'DELETE']
}
