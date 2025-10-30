import Joi from 'joi'
import { decodeTrack, logger, sendErrorResponse } from '../utils.js'

const filtersSchema = Joi.object().unknown(true)

const voiceStateSchema = Joi.object({
  token: Joi.string().required(),
  endpoint: Joi.string().required(),
  sessionId: Joi.string().required()
}).unknown(true)

const updatePlayerTrackSchema = Joi.object({
  encoded: Joi.string().allow(null).optional(),
  identifier: Joi.string().optional(),
  userData: Joi.object().unknown(true).optional()
})
  .xor('encoded', 'identifier')
  .unknown(true)

const updatePlayerSchema = Joi.object({
  track: updatePlayerTrackSchema.optional(),
  encodedTrack: Joi.string().allow(null).optional(),
  position: Joi.number().integer().min(0).optional(),
  endTime: Joi.number().integer().min(0).allow(null).optional(),
  volume: Joi.number().integer().min(0).max(1000).optional(),
  paused: Joi.boolean().optional(),
  filters: filtersSchema.optional(),
  voice: voiceStateSchema.optional()
})
  .min(1)
  .unknown(true)

const queryParamsSchema = Joi.object({
  noReplace: Joi.boolean().empty(null).default(false)
}).unknown(true)

const pathSchema = Joi.object({
  sessionId: Joi.string().required(),
  guildId: Joi.string().regex(/^\d{17,20}$/).optional() 
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const pathParams = {
    sessionId: parts[3],
    guildId: parts[5]
  }

  const { error: pathError, value: validatedParams } =
    pathSchema.validate(pathParams)

  if (pathError) {
    logger(
      'warn',
      'PlayerUpdate',
      `Invalid path parameters: ${pathError.details[0].message}`
    )
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      pathError.details[0].message,
      parsedUrl.pathname
    )
  }

  const { sessionId, guildId } = validatedParams
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
        const { error: bodyError, value: payload } = updatePlayerSchema.validate(
          req.body
        )

        if (bodyError) {
          logger(
            'warn',
            'PlayerUpdate',
            `Invalid payload for guild ${guildId}:`,
            bodyError.details[0].message
          )
          return sendErrorResponse(
            req,
            res,
            400,
            'Bad Request',
            bodyError.details[0].message,
            parsedUrl.pathname
          )
        }

        const { error: queryError, value: query } = queryParamsSchema.validate({
          noReplace: parsedUrl.searchParams.get('noReplace')
        })

        if (queryError) {
          return sendErrorResponse(
            req,
            res,
            400,
            'Bad Request',
            queryError.details[0].message,
            parsedUrl.pathname
          )
        }

        const { noReplace } = query

        logger(
          'debug',
          'PlayerUpdate',
          `Received payload for guild ${guildId}:`,
          payload
        )

        await session.players.create(guildId)

        if (payload.voice) {
          const { endpoint, token, sessionId: voiceSessionId } = payload.voice
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
                info: decodedTrack.info
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
                info: loadResult.data.info
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

        if (payload.position !== undefined) {
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
      logger('error', 'PlayerUpdate', `Unhandled error: ${error.message}`, error)
      throw error
    }
  }
}

export default {
  handler,
  methods: ['GET', 'DELETE', 'PATCH']
}