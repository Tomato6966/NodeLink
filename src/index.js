import { validateProperty, logger, getVersion, getGitInfo } from './utils.js'
import requestHandler from './api/index.js'
import config from '../config.js'
import WebSocketServer from '@performanc/pwsl-server'
import http from 'node:http'

class NodelinkServer {
  constructor(options) {
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.server = null
    this.socket = null
    this.sessions = new Map()
    this.version = getVersion()
    this.gitInfo = getGitInfo()
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
    //this.socket.on('/v4/websocket', ...)
    this.server.on('upgrade', (request, socket, head) => {
      const { headers } = request
      if (headers.authorization !== this.options.password) {
        logger(
          'warn',
          'Server',
          `Unauthorized connection attempt from ${request.socket.remoteAddress} - Invalid password provided`
        )
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }
    })
  }
  _listen() {
    const port = this.options.server.port
    this.server.listen(port, () => {
      logger('info', 'Server', `running at host ${this.options.server.host} on port ${port}`)
    })
  }
  start() {
    this._validateConfig()
    this._createServer()
    this._listen()
    return this
  }
}

const server = new NodelinkServer(config).start()
export default server
