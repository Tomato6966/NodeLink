import os from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import v8 from 'node:v8'
import { GatewayEvents } from './constants.js'
import ConnectionManager from './managers/connectionManager.js'
import CredentialManager from './managers/credentialManager.js'
import LyricsManager from './managers/lyricsManager.js'
import PluginManager from './managers/pluginManager.js'
import RateLimitManager from './managers/rateLimitManager.js'
import RoutePlannerManager from './managers/routePlannerManager.js'
import SourceManager from './managers/sourceManager.js'
import StatsManager from './managers/statsManager.js'
import { bufferPool } from './playback/BufferPool.js'
import { Player } from './playback/player.js'
import { cleanupHttpAgents, initLogger, logger } from './utils.js'

let lastCpuUsage = process.cpuUsage()
let lastCpuTime = Date.now()
let lastActivityTime = Date.now()
let isHibernating = false
let playerUpdateTimer = null
let statsUpdateTimer = null

const hndl = monitorEventLoopDelay({ resolution: 10 })
hndl.enable()

try {
  os.setPriority(os.constants.priority.PRIORITY_HIGH)
} catch (e) {
  // Ignore errors
}

let config
try {
  config = (await import('../config.js')).default
} catch {
  config = (await import('../config.default.js')).default
}

const HIBERNATION_ENABLED = config.cluster?.hibernation?.enabled !== false

const HIBERNATION_TIMEOUT =
  config.cluster?.hibernation?.timeoutMs || 20 * 60 * 1000

initLogger(config)

const players = new Map()
const commandQueue = []

const nodelink = {
  options: config,
  logger
}

nodelink.statsManager = new StatsManager(nodelink)
nodelink.credentialManager = new CredentialManager(nodelink)
nodelink.sources = new SourceManager(nodelink)
nodelink.lyrics = new LyricsManager(nodelink)
nodelink.routePlanner = new RoutePlannerManager(nodelink)
nodelink.connectionManager = new ConnectionManager(nodelink)
nodelink.pluginManager = new PluginManager(nodelink)
nodelink.registry = null
if (process.embedder === 'nodejs') {
  try {
    nodelink.registry = await import('./registry.js')
  } catch (e) {
    logger('error', 'Worker', `Failed to load registry: ${e.message}`)
  }
}

nodelink.extensions = {
  workerInterceptors: [],
  audioInterceptors: []
}

function setEfficiencyMode(enabled) {
  try {
    os.setPriority(
      process.pid,
      enabled ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_HIGH
    )
    if (enabled) {
      v8.setFlagsFromString('--optimize-for-size')
    } else {
      v8.setFlagsFromString('--no-optimize-for-size')
    }
  } catch (_e) {}
}

function startTimers(hibernating = false) {
  if (playerUpdateTimer) clearInterval(playerUpdateTimer)
  if (statsUpdateTimer) clearInterval(statsUpdateTimer)

  const updateInterval = hibernating
    ? 60000
    : (config?.playerUpdateInterval ?? 5000)
  const statsInterval = hibernating
    ? 120000
    : config?.metrics?.enabled
      ? 5000
      : (config?.statsUpdateInterval ?? 30000)
  const zombieThreshold = config?.zombieThresholdMs ?? 60000

  playerUpdateTimer = setInterval(() => {
    if (!process.connected) return

    for (const player of players.values()) {
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
        try {
          player._sendUpdate()
        } catch (updateError) {
          logger(
            'error',
            'Worker',
            `Error during player update for guild ${player.guildId}: ${updateError.message}`,
            updateError
          )
        }
      }
    }
  }, updateInterval)

  statsUpdateTimer = setInterval(() => {
    if (!process.connected) return

    let localPlayers = 0
    let localPlayingPlayers = 0
    const localFrameStats = { sent: 0, nulled: 0, deficit: 0, expected: 0 }

    for (const player of players.values()) {
      localPlayers++
      if (!player.isPaused && player.track) {
        localPlayingPlayers++
      }

      if (player?.track && !player.isPaused && player.connection) {
        if (player.connection.statistics) {
          localFrameStats.sent += player.connection.statistics.packetsSent || 0
          localFrameStats.nulled +=
            player.connection.statistics.packetsLost || 0
          localFrameStats.expected +=
            player.connection.statistics.packetsExpected || 0
        }
      }
    }

    localFrameStats.deficit += Math.max(
      0,
      localFrameStats.expected - localFrameStats.sent
    )

    if (localPlayers === 0 && HIBERNATION_ENABLED) {
      if (
        !isHibernating &&
        Date.now() - lastActivityTime > HIBERNATION_TIMEOUT
      ) {
        logger(
          'info',
          'Worker',
          'Worker entering hibernation mode (Efficiency Mode).'
        )
        isHibernating = true
        bufferPool.clear()
        cleanupHttpAgents()
        nodelink.connectionManager.stop()
        setEfficiencyMode(true)
        startTimers(true)

        if (global.gc) {
          let cycles = 0
          const aggressiveGC = setInterval(() => {
            try {
              global.gc()
              cycles++
              if (cycles >= 3) clearInterval(aggressiveGC)
            } catch (_e) {
              clearInterval(aggressiveGC)
            }
          }, 1000)
        }
      }
    } else {
      lastActivityTime = Date.now()
      if (isHibernating) {
        isHibernating = false
        setEfficiencyMode(false)
        nodelink.connectionManager.start()
        startTimers(false)
      }
    }

    try {
      const now = Date.now()
      const elapsedMs = now - lastCpuTime
      const cpuUsage = process.cpuUsage(lastCpuUsage)
      lastCpuTime = now
      lastCpuUsage = process.cpuUsage()

      const nodelinkLoad =
        elapsedMs > 0 ? (cpuUsage.user + cpuUsage.system) / 1000 / elapsedMs : 0

      const mem = process.memoryUsage()

      if (process.connected) {
        const success = process.send({
          type: 'workerStats',
          pid: process.pid,
          stats: {
            isHibernating,
            players: localPlayers,
            playingPlayers: localPlayingPlayers,
            commandQueueLength: commandQueue.length,
            cpu: { nodelinkLoad },
            eventLoopLag: hndl.mean / 1e6,
            memory: {
              used: mem.heapUsed,
              allocated: mem.heapTotal
            },
            frameStats: localFrameStats
          }
        })

        if (!success) {
          logger(
            'warn',
            'Worker-IPC',
            'IPC channel saturated, skipping non-critical workerStats update.'
          )
        }
      }
    } catch (e) {
      if (process.connected) {
        logger(
          'error',
          'Worker-IPC',
          `Failed to send workerStats: ${e.message}`
        )
      }
    }
  }, statsInterval)
}

nodelink.extensions = {
  workerInterceptors: [],
  audioInterceptors: []
}

nodelink.registerWorkerInterceptor = (fn) => {
  nodelink.extensions.workerInterceptors.push(fn)
  logger('info', 'Worker', 'Registered worker command interceptor')
}

nodelink.registerSource = (name, source) => {
  if (!nodelink.sources) {
    logger(
      'warn',
      'Worker',
      'Cannot register source (sources manager not ready).'
    )
    return
  }
  nodelink.sources.sources.set(name, source)
  logger('info', 'Worker', `Registered custom source: ${name}`)
}

nodelink.registerFilter = (name, filter) => {
  if (!nodelink.extensions.filters) nodelink.extensions.filters = new Map()
  nodelink.extensions.filters.set(name, filter)
  logger('info', 'Worker', `Registered custom filter: ${name}`)
}

nodelink.registerAudioInterceptor = (interceptor) => {
  if (!nodelink.extensions.audioInterceptors)
    nodelink.extensions.audioInterceptors = []
  nodelink.extensions.audioInterceptors.push(interceptor)
  logger('info', 'Worker', 'Registered custom audio interceptor')
}

async function initialize() {
  await nodelink.credentialManager.load()
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()
  await nodelink.statsManager.initialize()
  await nodelink.pluginManager.load('worker')
  
  lastActivityTime = Date.now()
  
  logger(
    'info',
    'Worker',
    `Worker process ${process.pid} started and initialized.`
  )
}

initialize()
startTimers(false)

process.on('uncaughtException', (err) => {
  const isStreamAbort =
    err.message === 'aborted' ||
    err.code === 'ECONNRESET' ||
    err.code === 'ERR_STREAM_PREMATURE_CLOSE'

  if (isStreamAbort) {
    logger('debug', 'Worker', `Stream disconnected: ${err.message}`)
    return
  }

  logger(
    'error',
    'Worker–Crash',
    `Uncaught Exception: ${err.stack || err.message}`
  )
  process.stderr.write('', () => process.exit(1))
})

process.on('unhandledRejection', (reason, promise) => {
  logger(
    'error',
    'Worker-Crash',
    `Unhandled Rejection at: ${promise}, reason: ${reason}`
  )
})

async function processQueue() {
  if (commandQueue.length === 0) return

  const { type, requestId, payload } = commandQueue.shift()

  lastActivityTime = Date.now()
  if (isHibernating) {
    logger('info', 'Worker', 'Worker waking up from hibernation.')
    isHibernating = false
    setEfficiencyMode(false)
    nodelink.connectionManager.start()
    startTimers(false)
  }

  // Execute Worker Interceptors
  const interceptors = nodelink.extensions.workerInterceptors
  if (interceptors && interceptors.length > 0) {
    for (const interceptor of interceptors) {
      try {
        const shouldBlock = await interceptor(type, payload)
        if (shouldBlock === true) {
          if (process.connected && requestId) {
            process.send({
              type: 'commandResult',
              requestId,
              payload: { intercepted: true }
            })
          }
          setImmediate(processQueue)
          return
        }
      } catch (e) {
        logger('error', 'Worker', `Interceptor error: ${e.message}`)
      }
    }
  }

  try {
    let result
    switch (type) {
      case 'createPlayer': {
        const { sessionId, guildId, userId, voice } = payload
        const playerKey = `${sessionId}:${guildId}`

        if (players.has(playerKey)) {
          result = { created: false, reason: 'Player already exists' }
          break
        }
        const mockSession = {
          id: sessionId,
          userId: userId,
          socket: {
            send: (data) => {
              if (process.connected) {
                try {
                  process.send({
                    type: 'playerEvent',
                    payload: { sessionId, guildId, data }
                  })
                } catch (e) {
                  logger(
                    'error',
                    'Worker-IPC',
                    `Failed to send playerEvent for guild ${guildId}: ${e.message}`
                  )
                }
              }
            }
          }
        }

        const player = new Player({ nodelink, session: mockSession, guildId })
        players.set(playerKey, player)

        if (voice) player.updateVoice(voice)

        result = { created: true }
        break
      }

      case 'destroyPlayer': {
        const { sessionId, guildId } = payload
        const playerKey = `${sessionId}:${guildId}`
        const player = players.get(playerKey)

        if (player) {
          player.destroy(false)
          players.delete(playerKey)

          if (process.connected) {
            try {
              process.send({
                type: 'playerDestroyed',
                payload: {
                  guildId,
                  userId: player.session.userId,
                  sessionId
                }
              })
            } catch (e) {
              logger(
                'error',
                'Worker-IPC',
                `Failed to send playerDestroyed for guild ${guildId}: ${e.message}`
              )
            }
          }

          result = { destroyed: true }
        } else {
          result = { destroyed: false, reason: 'Player not found in worker' }
        }
        break
      }

      case 'restorePlayer': {
        const { snapshot } = payload
        const {
          guildId,
          sessionId,
          userId,
          track,
          position,
          isPaused,
          volume,
          filters,
          voice
        } = snapshot
        const playerKey = `${sessionId}:${guildId}`

        logger(
          'info',
          'Worker',
          `Restoring player for guild ${guildId} (session: ${sessionId}) (position: ${position}ms, paused: ${isPaused})`
        )

        const mockSession = {
          id: sessionId,
          userId: userId,
          socket: {
            send: (data) => {
              if (process.connected) {
                try {
                  process.send({
                    type: 'playerEvent',
                    payload: { sessionId, guildId, data }
                  })
                } catch (e) {
                  logger(
                    'error',
                    'Worker-IPC',
                    `Failed to send playerEvent for guild ${guildId}: ${e.message}`
                  )
                }
              }
            }
          }
        }

        const player = new Player({ nodelink, session: mockSession, guildId })
        player._isRestoring = true
        players.set(playerKey, player)

        if (voice) player.updateVoice(voice)
        if (volume) player.volume(volume)
        if (filters && Object.keys(filters).length > 0)
          player.setFilters(filters)

        if (track) {
          await player.play({ ...track, startTime: position })
          if (isPaused) {
            player.pause(true)
          }
        }

        player._isRestoring = false
        result = { restored: true }
        break
      }

      case 'playerCommand': {
        const { sessionId, guildId, command, args } = payload
        const playerKey = `${sessionId}:${guildId}`
        const player = players.get(playerKey)

        if (player && typeof player[command] === 'function') {
          result = await player[command](...args)
        } else if (command === 'forceUpdate') {
          player?._sendUpdate()
          result = { updated: true }
        } else {
          result = {
            error: `Player or command '${command}' not found for guild ${guildId} (session: ${sessionId})`,
            playerNotFound: true
          }
        }
        break
      }

      case 'loadTracks': {
        const { identifier } = payload
        const re =
          /^(?:(?<url>(?:https?|ftts):\/\/\S+)|(?<source>[A-Za-z0-9]+):(?<query>[^/\s].*))$/i
        const match = re.exec(identifier)
        if (!match) throw new Error('Invalid identifier')

        const { url, source, query } = match.groups
        if (url) result = await nodelink.sources.resolve(url)
        else if (source === 'search')
          result = await nodelink.sources.unifiedSearch(query)
        else result = await nodelink.sources.search(source, query)
        break
      }

      case 'loadLyrics': {
        const { decodedTrack, language } = payload
        result = await nodelink.lyrics.loadLyrics(decodedTrack, language)
        break
      }

      case 'loadChapters': {
        const { decodedTrack } = payload
        result = await nodelink.sources.getChapters(decodedTrack)
        break
      }
      case 'getSources': {
        result = nodelink.sources.getEnabledSourceNames()
        break
      }
      case 'getTrackUrl': {
        const { decodedTrackInfo, itag } = payload
        result = await nodelink.sources.getTrackUrl(decodedTrackInfo, itag)
        break
      }

      case 'updateYoutubeConfig': {
        try {
          const { refreshToken, visitorData } = payload
          const youtube = nodelink.sources.sources.get('youtube')

          if (!youtube) {
            result = {
              success: false,
              reason: 'YouTube source not loaded on this worker'
            }
            break
          }

          if (refreshToken) {
            if (youtube.oauth) {
              youtube.oauth.refreshToken = refreshToken
              youtube.oauth.accessToken = null
              youtube.oauth.tokenExpiry = 0
              logger(
                'info',
                'Worker',
                'YouTube OAuth refresh token updated via API.'
              )
            } else {
              logger(
                'warn',
                'Worker',
                'Cannot update refreshToken: youtube.oauth is undefined.'
              )
            }
          }

          if (visitorData) {
            if (youtube.ytContext?.client) {
              youtube.ytContext.client.visitorData = visitorData
              logger('info', 'Worker', 'YouTube visitorData updated via API.')
            } else {
              logger(
                'warn',
                'Worker',
                'Cannot update visitorData: youtube.ytContext.client is undefined.'
              )
            }
          }

          result = { success: true }
        } catch (err) {
          logger(
            'error',
            'Worker',
            `Error updating YouTube config: ${err.message}`
          )
          result = { success: false, error: err.message }
        }
        break
      }

      default:
        throw new Error(`Unknown command type: ${type}`)
    }

    if (process.connected) {
      try {
        process.send({ type: 'commandResult', requestId, payload: result })
      } catch (e) {
        logger(
          'error',
          'Worker-IPC',
          `Failed to send commandResult for ${requestId}: ${e.message}`
        )
      }
    }
  } catch (e) {
    if (process.connected) {
      try {
        process.send({ type: 'commandResult', requestId, error: e.message })
      } catch (e) {
        logger(
          'error',
          'Worker-IPC',
          `Failed to send commandResult (error) for ${requestId}: ${e.message}`
        )
      }
    }
  } finally {
    if (commandQueue.length > 0) {
      setImmediate(processQueue)
    }
  }
}

process.on('message', (msg) => {
  if (msg.type === 'ping') {
    if (process.connected) {
      try {
        process.send({ type: 'pong', timestamp: msg.timestamp })
      } catch (e) {
        logger('error', 'Worker-IPC', `Failed to send pong: ${e.message}`)
      }
    }
    return
  }

  if (!msg.type || !msg.requestId) return

  commandQueue.push(msg)

  if (commandQueue.length === 1) {
    setImmediate(processQueue)
  }
})

setTimeout(() => {
  if (process.connected) {
    try {
      process.send({ type: 'ready', pid: process.pid })
    } catch (e) {
      logger('error', 'Worker-IPC', `Failed to send ready: ${e.message}`)
    }
  }
}, 1000)
