import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import cluster from 'node:cluster'
import WebSocketServer from '@performanc/pwsl-server'

import requestHandler from './api/index.js'
import lyricsManager from './managers/lyricsManager.js'
import sessionManager from './managers/sessionManager.js'
import sourceManager from './managers/sourceManager.js'
import routePlannerManager from './managers/routePlannerManager.js'
import connectionManager from './managers/connectionManager.js'
import statsManager from './managers/statsManager.js'
import OAuth from './sources/youtube/OAuth.js'
import {
  initLogger,
  getGitInfo,
  getVersion,
  logger,
  parseClient,
  validateProperty,
  verifyDiscordID,
  checkForUpdates,
  getStats
} from './utils.js'
import 'dotenv/config'

let config

try {
  config = (await import('../config.js')).default
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND') {
    try {
      config = (await import('../config.default.js')).default
      console.log(
        '[WARN] Config: config.js not found, using config.default.js. It is recommended to create a config.js file for your own configuration.'
      )
    } catch (e2) {
      console.error(
        '[ERROR] Config: Failed to load config.default.js. Please make sure it exists.'
      )
      throw e2
    }
  } else {
    throw e
  }
}

const clusterEnabled =
  process.env.CLUSTER_ENABLED?.toLowerCase() === 'true' ||
  (typeof config.cluster?.enabled === 'boolean' && config.cluster.enabled) ||
  false

let configuredWorkers = 0
if (process.env.CLUSTER_WORKERS)
  configuredWorkers = Number(process.env.CLUSTER_WORKERS)
else if (typeof config.cluster?.workers === 'number')
  configuredWorkers = config.cluster.workers

initLogger(config)
await checkForUpdates()

function ipHash(ip) {
  const cleaned = ip?.replace('::ffff:', '') ?? ''
  let h = 0
  for (let i = 0; i < cleaned.length; i++) {
    h = (h << 5) - h + cleaned.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

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
    this.routePlanner = new routePlannerManager(this)
    this.connectionManager = new connectionManager(this)
    this.statsManager = new statsManager(this)
    this.version = getVersion()
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }
    this._globalUpdater = null
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

              session.interval = setTimeout(
                () => {
                  if (this.sessions.get(sessionId)?.resumed !== true) {
                    logger(
                      'info',
                      'Server',
                      `Session with ID: ${sessionId} has not been resumed, deleting session due to timeout`
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
      const host = this.options.server.host
      this.server.listen(port, host, () => {
        logger('started', 'Server', `running at host ${host} on port ${port}`)
      })
    } catch (error) {
      logger('error', 'Server', `Failed to start server: ${error.message}`)
      process.exit(1)
    }
  }
  _startGlobalUpdater() {
    if (this._globalUpdater) return
    const updateInterval = this.options?.playerUpdateInterval ?? 5000
    const zombieThreshold = this.options?.zombieThresholdMs ?? 60000

    this._globalUpdater = setInterval(() => {
      let localPlayers = 0
      let localPlayingPlayers = 0
      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          localPlayers++
          if (!player.isPaused && player.track) {
            localPlayingPlayers++
          }
        }
      }

      if (clusterEnabled && cluster.isWorker) {
        process.send({
          type: 'workerStats',
          stats: {
            players: localPlayers,
            playingPlayers: localPlayingPlayers
          }
        })
      }

      const stats = getStats(this)
      const statsPayload = JSON.stringify({ op: 'stats', ...stats })

      for (const session of this.sessions.values()) {
        if (session.socket) {
          session.socket.send(statsPayload)
        }

        for (const player of session.players.players.values()) {
          if (player?.track && !player.isPaused && player.connection) {
            if (
              player._lastStreamDataTime > 0 &&
              Date.now() - player._lastStreamDataTime >= zombieThreshold
            ) {
              logger(
                'warn',
                'Player',
                `Player for guild ${player.guildId} detected as zombie (no stream data).`
              )
              player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: player.guildId,
                track: player.track,
                reason: 'no_stream_data',
                thresholdMs: zombieThreshold
              })
            }
            player._sendUpdate()
          }
        }
      }
    }, updateInterval)
  }
  _stopGlobalPlayerUpdater() {
    if (this._globalUpdater) {
      clearInterval(this._globalUpdater)
      this._globalUpdater = null
    }
  }

  async start(startOptions = {}) {
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

    if (startOptions.isClusterWorker) {
      logger(
        'info',
        'Server',
        'Running as cluster worker — waiting for sockets from master.'
      )
      process.on('message', (msg, handle) => {
        if (!msg || msg.type !== 'sticky-session') return
        if (!handle) return
        try {
          try {
            handle.pause && handle.pause()
          } catch (e) {}
          this.server.emit('connection', handle)
        } catch (err) {
          logger(
            'error',
            'Server',
            `Failed to inject socket from master: ${err?.message ?? err}`
          )
          try {
            handle.destroy && handle.destroy()
          } catch (e) {}
        }
      })
    } else {
      this._listen()
    }

    this._startGlobalUpdater()
    this.connectionManager.start()
    return this
  }
}

if (clusterEnabled && cluster.isPrimary) {
  const cpus = os.cpus().length
  const workersCount =
    configuredWorkers === 0 ? cpus : Math.max(1, configuredWorkers)

  logger(
    'info',
    'Cluster',
    `Primary process PID ${process.pid} - starting ${workersCount} workers`
  )

  const workerStats = new Map()
  let globalStatsInterval

  for (let i = 0; i < workersCount; i++) {
    const w = cluster.fork()
    logger('info', 'Cluster', `Spawned worker ${w.process.pid}`)
  }

  const workerIds = Object.keys(cluster.workers).map(Number)

  cluster.on('message', (worker, message) => {
    if (message.type === 'workerStats') {
      workerStats.set(worker.id, message.stats)
    }
  })

  const listenHost = config.server.host
  const listenPort = config.server.port

  const masterServer = net.createServer({ pauseOnConnect: true }, (socket) => {
    const addr = socket.remoteAddress || ''
    const index = ipHash(addr) % workerIds.length
    const workerId = workerIds[index]
    const worker = cluster.workers[workerId]
    if (!worker) {
      const fallbackWorkerId =
        workerIds[Math.floor(Math.random() * workerIds.length)]
      const fallback = cluster.workers[fallbackWorkerId]
      try {
        fallback.send({ type: 'sticky-session' }, socket)
      } catch (e) {
        socket.destroy()
      }
      return
    }
    try {
      worker.send({ type: 'sticky-session' }, socket)
    } catch (err) {
      logger(
        'warn',
        'Cluster',
        `Failed to send socket to worker ${worker.process.pid}: ${err.message}`
      )
      socket.destroy()
    }
  })

  masterServer.on('error', (err) => {
    logger('error', 'Cluster', `Master server error: ${err.message}`)
  })

  masterServer.listen(listenPort, listenHost, () => {
    logger(
      'started',
      'Cluster',
      `Master listening ${listenHost}:${listenPort} and distributing to ${workersCount} workers (PID ${process.pid})`
    )
  })

  cluster.on('exit', (worker, code, signal) => {
    logger(
      'warn',
      'Cluster',
      `Worker ${worker.process.pid} exited (code=${code} signal=${signal}). Spawning a new worker...`
    )
    const nw = cluster.fork()
    logger('info', 'Cluster', `Spawned worker ${nw.process.pid}`)
    const idx = workerIds.indexOf(Number(worker.id))
    if (idx !== -1) workerIds[idx] = Number(nw.id)
  })

  globalStatsInterval = setInterval(() => {
    let totalPlayers = 0
    let totalPlayingPlayers = 0

    for (const stats of workerStats.values()) {
      totalPlayers += stats.players
      totalPlayingPlayers += stats.playingPlayers
    }

    const globalStats = {
      players: totalPlayers,
      playingPlayers: totalPlayingPlayers
    }

    for (const id in cluster.workers) {
      cluster.workers[id].send({ type: 'globalStats', stats: globalStats })
    }
  }, config.playerUpdateInterval || 5000)
} else {
  const isWorker = clusterEnabled && cluster.worker

  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(config)
    await nserver.start({ isClusterWorker: !!isWorker })
    global.nodelink = nserver

    if (isWorker) {
      process.on('message', (message) => {
        if (message.type === 'globalStats') {
          nserver.statistics.players = message.stats.players
          nserver.statistics.playingPlayers = message.stats.playingPlayers
        }
      })
    } else {
      logger(
        'info',
        'Server',
        `Single-process server running (PID ${process.pid})`
      )
    }

    return nserver
  })()

  await serverInstancePromise
}
