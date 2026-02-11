import Validator from 'fastest-validator'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

const v = new Validator({ haltOnFirstError: true })

// Use unknown -> any in fastest-validator
const filtersSchema = { type: 'any', optional: true }

const voiceStateSchema = {
  type: 'object',
  props: {
    token: { type: 'string', empty: false },
    endpoint: { type: 'string', empty: false },
    sessionId: { type: 'string', empty: false },
    channelId: { type: 'string', optional: true }
  },
  $$strict: false
}

const updatePlayerTrackSchema = {
  type: 'object',
  props: {
    encoded: { type: 'string', nullable: true, optional: true },
    identifier: { type: 'string', optional: true },
    userData: { type: 'any', optional: true }
  },
  $$strict: false
}

const updatePlayerSchema = v.compile({
  track: { ...updatePlayerTrackSchema, optional: true },
  nextTrack: { ...updatePlayerTrackSchema, optional: true },
  encodedTrack: { type: 'string', nullable: true, optional: true },
  position: { type: 'number', min: 0, optional: true },
  endTime: { type: 'number', min: 0, nullable: true, optional: true },
  volume: { type: 'number', min: 0, max: 1000, optional: true },
  paused: { type: 'boolean', optional: true },
  loudnessNormalizer: { type: 'boolean', optional: true },
  filters: filtersSchema,
  fading: { type: 'any', optional: true },
  voice: { ...voiceStateSchema, optional: true },
  guildId: { type: 'string', optional: true },
  $$strict: false
})

const queryParamsSchema = v.compile({
  noReplace: { type: 'string', nullable: true, optional: true },
  $$strict: false
})

const pathSchema = v.compile({
  sessionId: { type: 'string', empty: false },
  guildId: {
    type: 'string',
    pattern: /^\d{17,20}$/,
    optional: true,
    messages: { stringPattern: 'guildId must be 17-20 digits' }
  }
})

const sanitizeFadingConfig = (raw) => {
  const safe = {
    enabled: false,
    trackStart: { duration: 0, curve: 'linear' },
    trackEnd: { duration: 0, curve: 'linear' },
    trackStop: { duration: 0, curve: 'linear' },
    seek: { duration: 0, curve: 'linear' },
    ducking: {
      enabled: false,
      duration: 0,
      targetVolume: 0.3,
      curve: 'linear'
    }
  }

  if (!raw || typeof raw !== 'object') return safe
  safe.enabled = raw.enabled === true

  const updateSection = (key) => {
    const section = raw[key]
    if (!section || typeof section !== 'object') return
    if (Number.isFinite(section.duration)) {
      safe[key].duration = Math.max(0, section.duration)
    }
    if (typeof section.curve === 'string') {
      safe[key].curve = section.curve
    }
  }

  updateSection('trackStart')
  updateSection('trackEnd')
  updateSection('trackStop')
  updateSection('seek')

  if (raw.ducking && typeof raw.ducking === 'object') {
    safe.ducking.enabled = raw.ducking.enabled === true
    if (Number.isFinite(raw.ducking.duration)) {
      safe.ducking.duration = Math.max(0, raw.ducking.duration)
    }
    if (Number.isFinite(raw.ducking.targetVolume)) {
      safe.ducking.targetVolume = Math.max(
        0,
        Math.min(1, raw.ducking.targetVolume)
      )
    }
    if (typeof raw.ducking.curve === 'string') {
      safe.ducking.curve = raw.ducking.curve
    }
  }

  return safe
}

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const pathParams = {
    sessionId: parts[3],
    guildId: parts[5]
  }

  const validation = pathSchema(pathParams)

  if (validation !== true) {
    const errorMessage = validation?.[0]?.message || 'Invalid path parameters'
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

  const { sessionId, guildId } = pathParams
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
        const bodyValidation = updatePlayerSchema(req.body)

        if (bodyValidation !== true) {
          const errorMessage = bodyValidation?.[0]?.message || 'Invalid payload'
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

        const payload = req.body

        const queryValidation = queryParamsSchema({
          noReplace: parsedUrl.searchParams.get('noReplace')
        })

        if (queryValidation !== true) {
          return sendErrorResponse(
            req,
            res,
            400,
            'Bad Request',
            queryValidation?.[0]?.message || 'Invalid query parameters',
            parsedUrl.pathname
          )
        }

        const noReplace = parsedUrl.searchParams.get('noReplace') === 'true'

        logger(
          'debug',
          'PlayerUpdate',
          `Received payload for guild ${guildId}:`,
          payload
        )

        await session.players.create(guildId)

        if (payload.voice) {
          const {
            endpoint,
            token,
            sessionId: voiceSessionId,
            channelId
          } = payload.voice
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
              `Voice payload for guild ${this.guildId} is identical. Skipping.`
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
        const userData = payload.track?.userData

        const trackPayload = payload.track
        const nextTrackPayload = payload.nextTrack
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
                audioTrackId:
                  trackPayload.language || trackPayload.audioTrackId || null
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
                audioTrackId:
                  trackPayload.language || trackPayload.audioTrackId || null
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

        if (nextTrackPayload) {
          let trackToPreload = null

          if (nextTrackPayload.encoded !== undefined) {
            const decodedTrack = decodeTrack(nextTrackPayload.encoded)
            if (decodedTrack) {
              trackToPreload = {
                encoded: nextTrackPayload.encoded,
                info: decodedTrack.info,
                audioTrackId:
                  nextTrackPayload.language || nextTrackPayload.audioTrackId || null,
                userData: nextTrackPayload.userData
              }
            }
          } else if (nextTrackPayload.identifier) {
            if (nodelink.loadTrack) {
              const loadResult = await nodelink.loadTrack(nextTrackPayload.identifier)
              if (loadResult.loadType === 'track') {
                trackToPreload = {
                  encoded: loadResult.data.encoded,
                  info: loadResult.data.info,
                  audioTrackId:
                    nextTrackPayload.language || nextTrackPayload.audioTrackId || null,
                  userData: nextTrackPayload.userData
                }
              }
            }
          }

          if (trackToPreload) {
            logger(
              'debug',
              'PlayerUpdate',
              `Preloading track for guild ${guildId}:`,
              { track: trackToPreload.info }
            )
            await session.players.preload(guildId, trackToPreload)
          }
        }

        if (stopPlayer) {
          const player = session.players.get(guildId)
          if (player?.isUpdatingTrack) {
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

        if (payload.fading !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Setting fading for guild ${guildId}`
          )
          const sanitizedFading = sanitizeFadingConfig(payload.fading)
          await session.players.setFading(guildId, sanitizedFading)
        }

        if (payload.loudnessNormalizer !== undefined) {
          logger(
            'debug',
            'PlayerUpdate',
            `Setting loudnessNormalizer to ${payload.loudnessNormalizer} for guild ${guildId}`
          )
          await session.players.setLoudnessNormalizer(
            guildId,
            payload.loudnessNormalizer
          )
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
