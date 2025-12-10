import myzod from 'myzod'
import { logger, sendErrorResponse } from '../utils.js'

const updateMixSchema = myzod
  .object({
    volume: myzod.number().min(0).max(1)
  })
  .allowUnknownKeys()

const pathSchema = myzod.object({
  sessionId: myzod.string(),
  guildId: myzod
    .string()
    .withPredicate(
      (val) => /^\d{17,20}$/.test(val),
      'guildId must be 17-20 digits'
    ),
  mixId: myzod.string()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const method = req.method
  const pathParts = parsedUrl.pathname.split('/')
  const sessionId = pathParts[3]
  const guildId = pathParts[5]
  const mixId = pathParts[7]

  try {
    pathSchema.parse({ sessionId, guildId, mixId })
  } catch (error) {
    if (error instanceof myzod.ValidationError) {
      return sendErrorResponse(req, res, 400, error.message)
    }
    return sendErrorResponse(req, res, 400, 'Invalid path parameters')
  }

  if (method === 'PATCH') {
    return handleUpdateMix(req, res, sessionId, guildId, mixId, nodelink)
  }

  if (method === 'DELETE') {
    return handleDeleteMix(req, res, sessionId, guildId, mixId, nodelink)
  }

  return sendErrorResponse(req, res, 405, 'Method Not Allowed')
}

async function handleUpdateMix(req, res, sessionId, guildId, mixId, nodelink) {
  try {
    let body = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        return sendErrorResponse(req, res, 400, 'Invalid JSON body')
      }
    }

    updateMixSchema.parse(body)

    const session = nodelink.sessions.get(sessionId)
    if (!session) {
      return sendErrorResponse(req, res, 404, 'Session not found')
    }

    if (!session.players) {
      return sendErrorResponse(req, res, 500, 'Player manager not initialized')
    }

    const updated = await session.players.updateMix(
      guildId,
      mixId,
      body.volume
    )

    if (!updated) {
      return sendErrorResponse(req, res, 404, 'Mix not found')
    }

    logger(
      'debug',
      'MixAPI',
      `Updated mix ${mixId} volume to ${body.volume} for guild ${guildId}`
    )

    res.writeHead(204)
    res.end()
  } catch (error) {
    if (error instanceof myzod.ValidationError) {
      return sendErrorResponse(req, res, 400, error.message)
    }
    logger('error', 'MixAPI', `Error updating mix: ${error.message}`)
    return sendErrorResponse(req, res, 500, error.message)
  }
}

async function handleDeleteMix(req, res, sessionId, guildId, mixId, nodelink) {
  try {
    const session = nodelink.sessions.get(sessionId)
    if (!session) {
      return sendErrorResponse(req, res, 404, 'Session not found')
    }

    if (!session.players) {
      return sendErrorResponse(req, res, 500, 'Player manager not initialized')
    }

    const removed = await session.players.removeMix(guildId, mixId)

    if (!removed) {
      return sendErrorResponse(req, res, 404, 'Mix not found')
    }

    logger('debug', 'MixAPI', `Removed mix ${mixId} for guild ${guildId}`)

    res.writeHead(204)
    res.end()
  } catch (error) {
    logger('error', 'MixAPI', `Error removing mix: ${error.message}`)
    return sendErrorResponse(req, res, 500, error.message)
  }
}

export default {
  handler,
  methods: ['PATCH', 'DELETE']
}
