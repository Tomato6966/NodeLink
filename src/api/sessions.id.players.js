import { decodeTrack, logger } from '../utils.js'

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const parts = parsedUrl.pathname.split('/')
  const sessionId = parts[3]
  const guildId = parts[5]

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
    const player = session.players.players.get(guildId)

    if (req.method === 'GET') {
      await session.players.create(guildId) // Ensure player exists or create it
      const playerJson = await session.players.toJSON(guildId)
      return sendResponse(req, res, playerJson, 200)
    }

    if (req.method === 'DELETE') {
      try {
        await session.players.destroy(guildId)
        return sendResponse(req, res, null, 204)
      } catch (error) {
        if (error.message.toLowerCase().includes('not found')) {
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 404,
              error: 'Not Found',
              message: error.message,
              path: parsedUrl.pathname
            },
            404
          )
        }
        throw error // Re-throw other errors
      }
    }

    if (req.method === 'PATCH') {
      const payload = req.body
      logger(
        'debug',
        'PlayerUpdate',
        `Received payload for guild ${guildId}:`,
        payload
      )

      // Ensure player exists or create it
      await session.players.create(guildId)

      if (payload.voice) {
        const { endpoint, token, sessionId: voiceSessionId } = payload.voice
        if (!endpoint || !token || !voiceSessionId) {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid voice object for guild ${guildId}:`,
            payload.voice
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message:
                'Invalid voice object. Endpoint, token, and sessionId are required.',
              path: parsedUrl.pathname
            },
            400
          )
        }
        logger(
          'debug',
          'PlayerUpdate',
          `Updating voice for guild ${guildId}:`,
          payload.voice
        )
        await session.players.updateVoice(guildId, payload.voice)
      }

      if (payload.encodedTrack) {
        logger(
          'warn',
          'PlayerUpdate',
          'The `encodedTrack` field is deprecated. Use `track.encoded` instead.'
        )
      }

      const encodedTrack = payload.track?.encoded
      if (encodedTrack !== undefined) {
        if (encodedTrack === null) {
          // The PlayerManager.stop method handles checking if the player is playing.
          await session.players.stop(guildId)
        } else {
          const noReplace = parsedUrl.searchParams.get('noReplace') === 'true'
          const decodedTrack = decodeTrack(encodedTrack)
          if (!decodedTrack) {
            logger(
              'warn',
              'PlayerUpdate',
              `Received invalid track for guild ${guildId}: ${encodedTrack}`
            )
            return sendResponse(
              req,
              res,
              {
                timestamp: Date.now(),
                status: 400,
                error: 'Bad Request',
                message: 'The provided track is invalid.',
                path: parsedUrl.pathname
              },
              400
            )
          }
          logger(
            'debug',
            'PlayerUpdate',
            `Playing track for guild ${guildId}:`,
            { track: decodedTrack.info, noReplace }
          )
          await session.players.play(guildId, {
            encoded: encodedTrack,
            info: decodedTrack.info,
            noReplace,
            endTime: payload.endTime
          })
        }
      }

      if (payload.volume !== undefined) {
        if (payload.volume < 0 || payload.volume > 1000) {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid volume for guild ${guildId}: ${payload.volume}. Expected 0-1000.`
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message: 'The volume must be between 0 and 1000.',
              path: parsedUrl.pathname
            },
            400
          )
        }
        logger(
          'debug',
          'PlayerUpdate',
          `Setting volume to ${payload.volume} for guild ${guildId}`
        )
        await session.players.volume(guildId, payload.volume)
      }

      if (payload.paused !== undefined) {
        if (typeof payload.paused !== 'boolean') {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid paused value for guild ${guildId}: ${payload.paused}. Expected boolean.`
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message: 'The paused value must be a boolean.',
              path: parsedUrl.pathname
            },
            400
          )
        }
        logger(
          'debug',
          'PlayerUpdate',
          `Setting paused to ${payload.paused} for guild ${guildId}`
        )
        await session.players.pause(guildId, payload.paused)
      }

      if (payload.position !== undefined) {
        if (typeof payload.position !== 'number') {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid position for guild ${guildId}: ${payload.position}. Expected number.`
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message: 'The position value must be a number.',
              path: parsedUrl.pathname
            },
            400
          )
        }
        logger(
          'debug',
          'PlayerUpdate',
          `Seeking to ${payload.position}ms for guild ${guildId}`
        )
        await session.players.seek(guildId, payload.position)
      }

      if (payload.endTime !== undefined) {
        if (typeof payload.endTime !== 'number' || payload.endTime < 0) {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid endTime for guild ${guildId}: ${payload.endTime}. Expected a non-negative number.`
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message: 'The endTime value must be a non-negative number.',
              path: parsedUrl.pathname
            },
            400
          )
        }
        logger(
          'debug',
          'PlayerUpdate',
          `Setting endTime to ${payload.endTime}ms for guild ${guildId}`
        )
        // Need to get current position from player state
        const playerState = await session.players.toJSON(guildId)
        await session.players.seek(
          guildId,
          playerState.state.position,
          payload.endTime
        )
      }

      if (payload.filters !== undefined) {
        if (typeof payload.filters !== 'object') {
          logger(
            'warn',
            'PlayerUpdate',
            `Received invalid filters value for guild ${guildId}: ${payload.filters}. Expected object.`
          )
          return sendResponse(
            req,
            res,
            {
              timestamp: Date.now(),
              status: 400,
              error: 'Bad Request',
              message: 'The filters value must be an object.',
              path: parsedUrl.pathname
            },
            400
          )
        }
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
  }

  return sendResponse(
    req,
    res,
    {
      timestamp: Date.now(),
      status: 404,
      error: 'Not Found',
      message: 'The requested player endpoint was not found.',
      path: parsedUrl.pathname
    },
    404
  )
}

export default {
  handler,
  methods: ['GET', 'DELETE', 'PATCH']
}
