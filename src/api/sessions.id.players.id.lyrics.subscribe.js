import myzod from 'myzod'
import { logger, sendErrorResponse } from '../utils.js'

const querySchema = myzod.object({
  skipTrackSource: myzod.string().optional()
})

const pathSchema = myzod.object({
  sessionId: myzod.string(),
  guildId: myzod
    .string()
    .withPredicate(
      (val) => /^\d{17,20}$/.test(val),
      'guildId must be 17-20 digits'
    )
})

async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
  const method = req.method
  const pathParts = parsedUrl.pathname.split('/')
  const sessionId = pathParts[3]
  const guildId = pathParts[5]

  try {
    pathSchema.parse({ sessionId, guildId })
  } catch (error) {
    if (error instanceof myzod.ValidationError) {
      return sendErrorResponse(req, res, 400, error.message)
    }
    return sendErrorResponse(req, res, 400, 'Invalid path parameters')
  }

  const session = nodelink.sessions.get(sessionId)
  if (!session) {
    return sendErrorResponse(req, res, 404, 'Session not found')
  }

  if (!session.players) {
    return sendErrorResponse(req, res, 500, 'Player manager not initialized')
  }

  if (method === 'POST') {
    const result = querySchema.try({
        skipTrackSource: parsedUrl.searchParams.get('skipTrackSource')
    })

    if (result instanceof myzod.ValidationError) {
        return sendErrorResponse(req, res, 400, result.message)
    }

    const skipTrackSource = result.skipTrackSource === 'true'

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
