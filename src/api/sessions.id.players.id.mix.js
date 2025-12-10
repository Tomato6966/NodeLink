import myzod from 'myzod'
import { decodeTrack, logger, sendErrorResponse, sendResponse } from '../utils.js'

const mixTrackSchema = myzod
  .object({
    encoded: myzod.string().nullable().optional(),
    identifier: myzod.string().optional(),
    userData: myzod.unknown().optional()
  })
  .allowUnknownKeys()

const createMixSchema = myzod
  .object({
    track: mixTrackSchema,
    volume: myzod.number().min(0).max(1).optional()
  })
  .allowUnknownKeys()

const pathSchema = myzod.object({
  sessionId: myzod.string(),
  guildId: myzod
    .string()
    .withPredicate(
      (val) => /^\d{17,20}$/.test(val),
      'guildId must be 17-20 digits'
    )
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
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

  if (method === 'POST') {
    return handleCreateMix(req, res, sessionId, guildId, nodelink, sendResponse)
  }

  if (method === 'GET') {
    return handleGetMixes(req, res, sessionId, guildId, nodelink, sendResponse)
  }

  return sendErrorResponse(req, res, 405, 'Method Not Allowed')
}

async function handleCreateMix(req, res, sessionId, guildId, nodelink, sendResponse) {
  try {
    let body = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        return sendErrorResponse(req, res, 400, 'Invalid JSON body')
      }
    }

    createMixSchema.parse(body)

    const session = nodelink.sessions.get(sessionId)
    if (!session) {
      return sendErrorResponse(req, res, 404, 'Session not found')
    }

    if (!session.players) {
      return sendErrorResponse(req, res, 500, 'Player manager not initialized')
    }

    const mixConfig = nodelink.options?.mix ?? { enabled: true, defaultVolume: 0.8, maxLayersMix: 5, autoCleanup: true }
    
    if (!mixConfig.enabled) {
      return sendErrorResponse(req, res, 403, 'Mix feature is disabled')
    }

    let trackData = body.track
    if (trackData.encoded) {
      trackData = decodeTrack(trackData.encoded)
      if (body.track.userData !== undefined) {
        trackData.userData = body.track.userData
      }
    } else if (trackData.identifier) {
      trackData = {
        identifier: trackData.identifier,
        userData: body.track.userData
      }
    } else {
      return sendErrorResponse(
        req, res,
        400,
        'Track must have either encoded or identifier'
      )
    }

    const result = await session.players.addMix(
      guildId,
      trackData,
      body.volume
    )

    logger(
      'debug',
      'MixAPI',
      `Created mix ${result.id} for guild ${guildId}`
    )

    return sendResponse(req, res, {
      id: result.id,
      track: result.track,
      volume: result.volume
    }, 201)
  } catch (error) {
    if (error instanceof myzod.ValidationError) {
      return sendErrorResponse(req, res, 400, error.message)
    }
    logger('error', 'MixAPI', `Error creating mix: ${error.message}`)
    return sendErrorResponse(req, res, 500, error.message)
  }
}

async function handleGetMixes(req, res, sessionId, guildId, nodelink, sendResponse) {
  try {
    const session = nodelink.sessions.get(sessionId)
    if (!session) {
      return sendErrorResponse(req, res, 404, 'Session not found')
    }

    if (!session.players) {
      return sendErrorResponse(req, res, 500, 'Player manager not initialized')
    }

    const mixes = await session.players.getMixes(guildId)

    return sendResponse(req, res, { mixes }, 200)
  } catch (error) {
    logger('error', 'MixAPI', `Error getting mixes: ${error.message}`)
    return sendErrorResponse(req, res, 500, error.message)
  }
}

export default {
  handler,
  methods: ['GET', 'POST']
}
