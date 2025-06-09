import {
  validateProperty,
  logger,
  getVersion,
  getGitInfo,
  parseClient,
  verifyDiscordID
} from './utils.js'
import requestHandler from './api/index.js'
import config from '../config.js'
import WebSocketServer from '@performanc/pwsl-server'
import sessionManager from './managers/sessionManager.js'
import sourceManager from './managers/sourceManager.js'
import http from 'node:http'

class NodelinkServer {
  constructor(options) {
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.server = null
    this.socket = null
    this.sessions = new sessionManager(this)
    this.sources = new sourceManager(this)
    this.version = getVersion()
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }
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
      options => options.server.port && typeof options.server.port === 'number',
      'Port must be a number'
    )
    validateProperty(
      this.options,
      options => options.server.host && typeof options.server.host === 'string',
      'Host must be a string'
    )
  }
  _createServer() {
    this.server = http.createServer((req, res) => requestHandler(this, req, res))
    this.socket = new WebSocketServer({ noServer: true })
    this.socket.on('/v4/websocket', (socket, request, clientInfo) => {
      const sessionId = this.sessions.create(request, socket, clientInfo)
      socket.on('close', (code, reason) => {
        if (!this.sessions.has(sessionId)) return
        logger(
          'info',
          'Server',
          `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${clientInfo.version}\x1b[0m disconnected with code ${code} and reason: ${reason || 'without reason'}`
        )
        this.sessions.delete(sessionId)
      })

      socket.send(
        JSON.stringify({
          op: 'ready',
          resumed: false,
          sessionId
        })
      )
    })
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

      const { pathname } = new URL(request.url, `http://${request.headers.host}`)
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

        this.socket.handleUpgrade(request, socket, head, {}, ws =>
          this.socket.emit('/v4/websocket', ws, request, clientInfo)
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
        logger('started', 'Server', `running at host ${this.options.server.host} on port ${port}`)
      })
    } catch (error) {
      logger('error', 'Server', `Failed to start server: ${error.message}`)
      process.exit(1)
    }
  }
  async start() {
    this._validateConfig()
    await this.sources.loadFolder()
    this._createServer()
    this._listen()
    return this
  }
}

const server = new NodelinkServer(config).start()
export default server
