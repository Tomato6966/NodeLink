import http from 'node:http'
import WebSocketServer from '@performanc/pwsl-server'
import config from '../config.js'
import requestHandler from './api/index.js'
import lyricsManager from './managers/lyricsManager.js'
import sessionManager from './managers/sessionManager.js'
import sourceManager from './managers/sourceManager.js'
import OAuth from './sources/youtube/OAuth.js'
import {
  getGitInfo,
  getVersion,
  logger,
  parseClient,
  validateProperty,
  verifyDiscordID
} from './utils.js'
import 'dotenv/config'

class NodelinkServer {
  constructor(options) {
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.server = null
    this.socket = null
    this.sessions = new sessionManager(this)
    this.sources = new sourceManager(this)
    this.lyrics = new lyricsManager(this)
    this.version = getVersion()
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }
    this._globalPlayerUpdater = null
    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )
  }
  _validateConfig() {
    validateProperty(
      this.options,
      (options) =>
        options.server.port && typeof options.server.port === 'number',
      'Port must be a number'
    )
    validateProperty(
      this.options,
      (options) =>
        options.server.host && typeof options.server.host === 'string',
      'Host must be a string'
    )
  }
  _createServer() {
    this.server = http.createServer((req, res) =>
      requestHandler(this, req, res)
    )
    this.socket = new WebSocketServer({ noServer: true })
    this.socket.on(
      '/v4/websocket',
      (socket, request, clientInfo, oldSessionId) => {
        if (oldSessionId) {
          const session = this.sessions.get(oldSessionId)
          if (session) {
            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m resumed session with ID: ${oldSessionId}`
            )
            session.socket = socket
            socket.send(
              JSON.stringify({
                op: 'ready',
                resumed: true,
                sessionId: oldSessionId
              })
            )
            session.resumed = true

            if (session.interval) {
              clearTimeout(session.interval)
              session.interval = null
            }
          }
        } else {
          const sessionId = this.sessions.create(request, socket, clientInfo)
          socket.on('close', (code, reason) => {
            if (!this.sessions.has(sessionId)) return
            const session = this.sessions.get(sessionId)
            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m disconnected with code ${code} and reason: ${reason || 'without reason'}`
            )
            if (!session.resuming) this.sessions.delete(sessionId)
            else {
              logger(
                'info',
                'Server',
                `Session with ID: ${sessionId} is resuming, waiting for reconnection in ${session.timeout || 60} seconds`
              )

              socket.interval = setTimeout(
                () => {
                  if (this.sessions.get(sessionId)?.resumed !== true) {
                    logger(
                      'info',
                      'Server',
                      `Session with ID: ${sessionId} has not been resumed, deleting session`
                    )
                    this.sessions.delete(sessionId)
                  } else
                    logger(
                      'info',
                      'Server',
                      `Session with ID: ${sessionId} has been resumed, keeping session alive`
                    )
                },
                (session.timeout || 60) * 1000
              )
            }
          })

          socket.send(
            JSON.stringify({
              op: 'ready',
              resumed: false,
              sessionId
            })
          )
        }
      }
    )
    this.server.on('upgrade', (request, socket, head) => {
      const { remoteAddress, remotePort } = request.socket
      const isInternal =
        /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress) ||
        /^::ffff:127\.0\.0\.1/.test(remoteAddress)
      const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`
      const { headers } = request

      if (headers.authorization !== this.options.server.password) {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid password provided`
        )
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }
      const clientInfo = parseClient(headers['client-name'])
      if (!clientInfo) {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid client-name provided`
        )
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        return socket.destroy()
      }

      let sessionId = headers['session-id']
      if (sessionId && !this.sessions.has(sessionId)) {
        logger(
          'warn',
          'Server',
          `Session-ID provided by ${clientAddress} does not exist: ${sessionId}, creating a new session`
        )
        sessionId = undefined
      }

      const { pathname } = new URL(
        request.url,
        `http://${request.headers.host}`
      )
      if (pathname === '/v4/websocket') {
        if (!request.headers['user-id']) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Missing user ID`
          )
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          return socket.destroy()
        }
        if (!verifyDiscordID(request.headers['user-id'])) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid user ID provided`
          )
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
          return socket.destroy()
        }
        logger(
          'info',
          'Server',
          `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`
        )

        this.socket.handleUpgrade(request, socket, head, {}, (ws) =>
          this.socket.emit('/v4/websocket', ws, request, clientInfo, sessionId)
        )
      } else {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${clientAddress} - Invalid path provided`
        )
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        return socket.destroy()
      }
    })
  }
  _listen() {
    try {
      const port = this.options.server.port
      this.server.listen(port, () => {
        logger(
          'started',
          'Server',
          `running at host ${this.options.server.host} on port ${port}`
        )
      })
    } catch (error) {
      logger('error', 'Server', `Failed to start server: ${error.message}`)
      process.exit(1)
    }
  }
  _startGlobalPlayerUpdater() {
    if (this._globalPlayerUpdater) return
    const updateInterval = this.options?.playerUpdateInterval ?? 5000
    this._globalPlayerUpdater = setInterval(() => {
      for (const session of this.sessions.values()) {
        for (const player of session.players.players.values()) {
          if (player && player.track && !player.isPaused && player.connection) {
            player._sendUpdate()
          }
        }
      }
    }, updateInterval)
  }
  _stopGlobalPlayerUpdater() {
    if (this._globalPlayerUpdater) {
      clearInterval(this._globalPlayerUpdater)
      this._globalPlayerUpdater = null
    }
  }
  async start() {
    this._validateConfig()

    if (this.options.sources.youtube?.getOAuthToken) {
      logger(
        'info',
        'OAuth',
        'Starting YouTube OAuth token acquisition process...'
      )
      try {
        await OAuth.acquireRefreshToken()
        logger(
          'info',
          'OAuth',
          'YouTube OAuth token acquisition completed. Please update your config.js with the refresh token and set sources.youtube.getOAuthToken to false.'
        )
        process.exit(0)
      } catch (error) {
        logger(
          'error',
          'OAuth',
          `YouTube OAuth token acquisition failed: ${error.message}`
        )
        process.exit(1)
      }
    }

    await this.sources.loadFolder()
    await this.lyrics.loadFolder()
    this._createServer()
    this._listen()
    this._startGlobalPlayerUpdater()
    return this
  }
}

const server = new NodelinkServer(config).start()
export default server
