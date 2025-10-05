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
      const players = Array.from(session.players.players.values()).map(
        (player) => player.toJSON()
      )
      return sendResponse(req, res, players, 200)
    }
  }

  if (guildId) {
    let player = session.players.players.get(guildId)

    if (req.method === 'GET') {
      if (!player) {
        player = session.players.create(guildId)
      }
      return sendResponse(req, res, player.toJSON(), 200)
    }

    if (req.method === 'DELETE') {
      if (!player) {
        return sendResponse(
          req,
          res,
          {
            timestamp: Date.now(),
            status: 404,
            error: 'Not Found',
            message: "The provided guildId doesn't exist.",
            path: parsedUrl.pathname
          },
          404
        )
      }
      player.destroy()
      session.players.players.delete(guildId)
      nodelink.statistics.players--
      return sendResponse(req, res, null, 204)
    }

    if (req.method === 'PATCH') {
      const payload = req.body
      logger(
        'debug',
        'PlayerUpdate',
        `Received payload for guild ${guildId}:`,
        payload
      )

      if (!player) {
        player = session.players.create(guildId)
      }

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
        player.updateVoice(payload.voice)

        if (player.track) {
          player.play({
            encoded: player.track.encoded,
            info: player.track.info,
            noReplace: false
          })
        }
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
          if (!player.track) {
            logger(
              'warn',
              'PlayerUpdate',
              `Stop requested for guild ${guildId}, but player is not playing.`
            )
            return sendResponse(
              req,
              res,
              {
                timestamp: Date.now(),
                status: 400,
                error: 'Bad Request',
                message: 'The player is not playing.',
                path: parsedUrl.pathname
              },
              400
            )
          }
          logger('debug', 'PlayerUpdate', `Stopping track for guild ${guildId}`)
          player.stop()
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
          await player.play({
            encoded: encodedTrack,
            info: decodedTrack.info,
            noReplace
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
        player.volume(payload.volume)
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
        player.pause(payload.paused)
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
        await player.seek(payload.position)
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
        player.setFilters(payload)
      }

      return sendResponse(req, res, player.toJSON(), 200)
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
