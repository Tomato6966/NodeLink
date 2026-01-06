import myzod from 'myzod'
import { decodeTrack, logger, sendErrorResponse } from '../utils.js'

// Use unknown() instead of object for filters to preserve all properties
const filtersSchema = myzod.unknown()

const voiceStateSchema = myzod
  .object({
    token: myzod.string(),
    endpoint: myzod.string(),
    sessionId: myzod.string(),
    channelId: myzod.string().optional()
  })
  .allowUnknownKeys()

const updatePlayerTrackSchema = myzod
  .object({
    encoded: myzod.string().nullable().optional(),
    identifier: myzod.string().optional(),
    userData: myzod.unknown().optional()
  })
  .allowUnknownKeys()

const updatePlayerSchema = myzod
  .object({
    track: updatePlayerTrackSchema.optional(),
    encodedTrack: myzod.string().nullable().optional(),
    position: myzod.number().min(0).optional(),
    endTime: myzod.number().min(0).nullable().optional(),
    volume: myzod.number().min(0).max(1000).optional(),
    paused: myzod.boolean().optional(),
    filters: filtersSchema.optional(),
    voice: voiceStateSchema.optional(),
    guildId: myzod.string().optional()
  })
  .allowUnknownKeys()

const queryParamsSchema = myzod
  .object({
    noReplace: myzod.union([myzod.string(), myzod.null()]).optional()
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
    .optional()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const pathParams = {
    sessionId: parts[3],
    guildId: parts[5]
  }

  const pathResult = pathSchema.try(pathParams)

  if (pathResult instanceof myzod.ValidationError) {
    const errorMessage = pathResult.message || 'Invalid path parameters'
    logger('warn', 'PlayerUpdate', `Invalid path parameters: ${errorMessage}`)
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      errorMessage,
      parsedUrl.pathname
    )
  }

  const { sessionId, guildId } = pathResult
  const session = nodelink.sessions.get(sessionId)

  if (!session) {
    return sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      "The provided sessionId doesn't exist.",
      parsedUrl.pathname
    )
  }

  if (!guildId && parsedUrl.pathname === `/v4/sessions/${sessionId}/players`) {
    if (req.method === 'GET') {
      if (nodelink.workerManager) {
        const playerKeys = Array.from(
          nodelink.workerManager.guildToWorker.keys()
        )
        const sessionPlayerKeys = playerKeys.filter((key) =>
          key.startsWith(`${session.id}:`)
        )
        const guildIds = sessionPlayerKeys.map((key) => key.split(':')[1])

        const players = await Promise.all(
          guildIds.map((gid) =>
            session.players.toJSON(gid).catch((err) => {
              logger(
                'error',
                'PlayerList',
                `Failed to get player JSON for guild ${gid}: ${err.message}`
              )
              return null
            })
          )
        )

        return sendResponse(
          req,
          res,
          players.filter((p) => p !== null),
          200
        )
      }

      const players = await Promise.all(
        Array.from(session.players.players.values()).map((player) =>
          session.players.toJSON(player.guildId)
        )
      )
      return sendResponse(req, res, players, 200)
    }
  }

  if (guildId) {
    try {
      if (req.method === 'GET') {
        await session.players.create(guildId)
        const playerJson = await session.players.toJSON(guildId)
        return sendResponse(req, res, playerJson, 200)
      }

      if (req.method === 'DELETE') {
        await session.players.destroy(guildId)
        return sendResponse(req, res, null, 204)
      }

      if (req.method === 'PATCH') {
        const bodyResult = updatePlayerSchema.try(req.body)

        if (bodyResult instanceof myzod.ValidationError) {
          const errorMessage = bodyResult.message || 'Invalid payload'
          logger(
            'warn',
            'PlayerUpdate',
            `Invalid payload for guild ${guildId}: ${errorMessage}`
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

        const payload = bodyResult

        const queryResult = queryParamsSchema.try({
          noReplace: parsedUrl.searchParams.get('noReplace')
        })

        if (queryResult instanceof myzod.ValidationError) {
          return sendErrorResponse(
            req,
            res,
            400,
            'Bad Request',
            queryResult.message,
            parsedUrl.pathname
          )
        }

        const noReplace = queryResult.noReplace === 'true'

        logger(
          'debug',
          'PlayerUpdate',
          `Received payload for guild ${guildId}:`,
          payload
        )

        await session.players.create(guildId)

        if (payload.voice) {
          const { endpoint, token, sessionId: voiceSessionId, channelId } = payload.voice
          const currentPlayer = session.players.get(guildId)
          if (
            currentPlayer &&
            currentPlayer.voice?.endpoint === endpoint &&
            currentPlayer.voice?.token === token &&
            currentPlayer.voice?.sessionId === voiceSessionId
          ) {
            logger(
              'debug',
              'PlayerUpdate',
              `Voice payload for guild ${guildId} is identical. Skipping.`
            )
          } else {
            logger(
              'debug',
              'PlayerUpdate',
              `Updating voice for guild ${guildId}`
            )
            await session.players.updateVoice(guildId, payload.voice)
          }
        }

        let trackToPlay = null
        let stopPlayer = false
        let userData = payload.track?.userData

        const trackPayload = payload.track
        const legacyEncodedTrack = payload.encodedTrack

        if (legacyEncodedTrack) {
          logger(
            'warn',
            'PlayerUpdate',
            'The `encodedTrack` field is deprecated. Use `track.encoded` instead.'
          )
          return sendErrorResponse(
            req,
            res,
            400,
            'Bad Request',
            'The `encodedTrack` field is deprecated. Use `track.encoded` instead.',
            parsedUrl.pathname
          )
        }

        if (trackPayload) {
          if (trackPayload.encoded !== undefined) {
            if (trackPayload.encoded === null) {
              stopPlayer = true
            } else {
              const decodedTrack = decodeTrack(trackPayload.encoded)
              if (!decodedTrack) {
                return sendErrorResponse(
                  req,
                  res,
                  400,
                  'Bad Request',
                  'The provided track is invalid.',
                  parsedUrl.pathname
                )
              }
              trackToPlay = {
                encoded: trackPayload.encoded,
                info: decodedTrack.info,
                audioTrackId: trackPayload.language || trackPayload.audioTrackId || null
              }
            }
          } else if (trackPayload.identifier) {
            logger(
              'debug',
              'PlayerUpdate',
              `Resolving identifier: ${trackPayload.identifier}`
            )

            if (!nodelink.loadTrack) {
              logger(
                'error',
                'PlayerUpdate',
                'nodelink.loadTrack is not implemented!'
              )
              return sendErrorResponse(
                req,
                res,
                500,
                'Internal Server Error',
                'Track identifier loading is not supported.',
                parsedUrl.pathname
              )
            }

            const loadResult = await nodelink.loadTrack(trackPayload.identifier)

            if (loadResult.loadType === 'track') {
              trackToPlay = {
                encoded: loadResult.data.encoded,
                info: loadResult.data.info,
                audioTrackId: trackPayload.language || trackPayload.audioTrackId || null
              }
            } else {
              const message =
                loadResult.loadType === 'empty'
                  ? 'Track identifier resolved to no tracks.'
                  : `Track identifier resolved to ${loadResult.loadType}, expected 'track'.`
              return sendErrorResponse(
                req,
                res,
                400,
                'Bad Request',
                message,
                parsedUrl.pathname
              )
            }
          }
        } else if (legacyEncodedTrack !== undefined) {
          if (legacyEncodedTrack === null) {
            stopPlayer = true
          } else {
            const decodedTrack = decodeTrack(legacyEncodedTrack)
            if (!decodedTrack) {
              return sendErrorResponse(
                req,
                res,
                400,
                'Bad Request',
                'The provided track is invalid.',
                parsedUrl.pathname
              )
            }
            trackToPlay = {
              encoded: legacyEncodedTrack,
              info: decodedTrack.info
            }
          }
        }

        if (stopPlayer) {
          const player = session.players.get(guildId)
          if (player && player.isUpdatingTrack) {
            logger(
              'debug',
              'PlayerUpdate',
              `Player for guild ${guildId} is updating. Waiting before stopping.`
            )
            let attempts = 0
            const maxAttempts = 10
            while (player.isUpdatingTrack && attempts < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 100))
              attempts++
            }
            if (player.isUpdatingTrack) {
              logger(
                'warn',
                'PlayerUpdate',
                `Player for guild ${guildId} still updating. Forcing stop.`
              )
            }
          }
          await session.players.stop(guildId)
        }

        if (trackToPlay) {
          logger(
            'debug',
            'PlayerUpdate',
            `Playing track for guild ${guildId}:`,
            { track: trackToPlay.info, noReplace }
          )
          await session.players.play(guildId, {
            ...trackToPlay,
            userData,
            noReplace,
            startTime: payload.position,
            endTime: payload.endTime || undefined
          })
        }

        if (payload.volume !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Setting volume to ${payload.volume} for guild ${guildId}`
          )
          await session.players.volume(guildId, payload.volume)
        }

        if (payload.paused !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Setting paused to ${payload.paused} for guild ${guildId}`
          )
          await session.players.pause(guildId, payload.paused)
        }

        if (payload.position !== undefined && !trackToPlay) {
          logger(
            'debug',
            'PlayerUpdate',
            `Seeking to ${payload.position}ms for guild ${guildId}`
          )
          await session.players.seek(guildId, payload.position)
        }

        if (payload.endTime !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Setting endTime to ${payload.endTime}ms for guild ${guildId}`
          )
          const playerState = await session.players.toJSON(guildId)
          await session.players.seek(
            guildId,
            playerState.state.position,
            payload.endTime
          )
        }

        if (payload.filters !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Applying filters for guild ${guildId}:`,
            payload.filters
          )
          await session.players.setFilters(guildId, payload)
        }

        const playerJson = await session.players.toJSON(guildId)
        return sendResponse(req, res, playerJson, 200)
      }
    } catch (error) {
      if (
        error.message.toLowerCase().includes('player not found') ||
        error.message.toLowerCase().includes('player not assigned')
      ) {
        return sendErrorResponse(
          req,
          res,
          404,
          'Not Found',
          error.message,
          parsedUrl.pathname
        )
      }
      logger(
        'error',
        'PlayerUpdate',
        `Unhandled error: ${error.message}`,
        error
      )
      return sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        error.message,
        parsedUrl.pathname,
        true
      )
    }
  }
}

export default {
  handler,
  methods: ['GET', 'DELETE', 'PATCH']
}
