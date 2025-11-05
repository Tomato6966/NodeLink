import { GatewayEvents } from './constants.js'
import ConnectionManager from './managers/connectionManager.js'
import LyricsManager from './managers/lyricsManager.js'
import RoutePlannerManager from './managers/routePlannerManager.js'
import SourceManager from './managers/sourceManager.js'
import StatsManager from './managers/statsManager.js'
import { Player } from './playback/player.js'
import PluginManager from './plugins/pluginManager.js'
import { initLogger, logger } from './utils.js'

let config
try {
  config = (await import('../config.js')).default
} catch {
  config = (await import('../config.default.js')).default
}

initLogger(config)

const players = new Map()
const commandQueue = []
const nodelink = {
  options: config,
  logger
}

nodelink.statsManager = new StatsManager(nodelink)
nodelink.sources = new SourceManager(nodelink)
nodelink.lyrics = new LyricsManager(nodelink)
nodelink.routePlanner = new RoutePlannerManager(nodelink)
nodelink.connectionManager = new ConnectionManager(nodelink)
nodelink.pluginManager = new PluginManager(nodelink)

async function initialize() {
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()
  await nodelink.pluginManager.loadAll()
  logger(
    'info',
    'Worker',
    `Worker process ${process.pid} started and initialized.`
  )
}

initialize()

process.on('uncaughtException', (err) => {
  logger('error', 'Worker-Crash', `Uncaught Exception: ${err.stack || err.message}`)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  logger('error', 'Worker-Crash', `Unhandled Rejection at: ${promise}, reason: ${reason}`)
})

async function processQueue() {
  if (commandQueue.length === 0) return

  const { type, requestId, payload } = commandQueue.shift()

  try {
    let result
    switch (type) {
      case 'createPlayer': {
        const { sessionId, guildId, userId, voice } = payload
        if (players.has(guildId)) {
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
                  logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${e.message}`)
                }
              }
            }
          }
        }

        const player = new Player({ nodelink, session: mockSession, guildId })
        players.set(guildId, player)

        if (voice) player.updateVoice(voice)

        result = { created: true }
        break
      }

      case 'destroyPlayer': {
        const { guildId } = payload
        const player = players.get(guildId)
        if (player) {
          player.destroy(false)
          players.delete(guildId)
          
          if (process.connected) {
            try {
              process.send({
                type: 'playerDestroyed',
                payload: { guildId }
              })
            } catch (e) {
              logger('error', 'Worker-IPC', `Failed to send playerDestroyed for guild ${guildId}: ${e.message}`)
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
        const { guildId, sessionId, userId, track, position, isPaused, volume, filters, voice } = snapshot
        
        logger('info', 'Worker', `Restoring player for guild ${guildId} (position: ${position}ms, paused: ${isPaused})`)
        
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
                  logger('error', 'Worker-IPC', `Failed to send playerEvent for guild ${guildId}: ${e.message}`)
                }
              }
            }
          }
        }

        const player = new Player({ nodelink, session: mockSession, guildId })
        player._isRestoring = true
        players.set(guildId, player)

        if (voice) player.updateVoice(voice)
        if (volume) player.volume(volume)
        if (filters && Object.keys(filters).length > 0) player.setFilters(filters)
        
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
        const { guildId, command, args } = payload
        const player = players.get(guildId)
        if (player && typeof player[command] === 'function') {
          result = await player[command](...args)
        } else {
          result = {
            error: `Player or command '${command}' not found for guild ${guildId}`,
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
        const { decodedTrack } = payload
        result = await nodelink.lyrics.loadLyrics(decodedTrack)
        break
      }
      case 'getSources': {
        result = nodelink.sources.getEnabledSourceNames()
        break
      }
      default:
        throw new Error(`Unknown command type: ${type}`)
    }

    if (process.connected) {
      try {
        process.send({ type: 'commandResult', requestId, payload: result })
      } catch (e) {
        logger('error', 'Worker-IPC', `Failed to send commandResult for ${requestId}: ${e.message}`)
      }
    }
  } catch (e) {
    if (process.connected) {
      try {
        process.send({ type: 'commandResult', requestId, error: e.message })
      } catch (e) {
        logger('error', 'Worker-IPC', `Failed to send commandResult (error) for ${requestId}: ${e.message}`)
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

const updateInterval = config?.playerUpdateInterval ?? 5000
const zombieThreshold = config?.zombieThresholdMs ?? 60000

setTimeout(() => {
  if (process.connected) {
    try {
      process.send({ type: 'ready', pid: process.pid })
    } catch (e) {
      logger('error', 'Worker-IPC', `Failed to send ready: ${e.message}`)
    }
  }
}, 1000)

setInterval(() => {
  if (!process.connected) return

  let localPlayers = 0
  let localPlayingPlayers = 0
  for (const player of players.values()) {
    localPlayers++
    if (!player.isPaused && player.track) {
      localPlayingPlayers++
    }

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
    
    if (player.track && !player._isRestoring) {
      try {
        process.send({
          type: 'playerSnapshot',
          payload: {
            guildId: player.guildId,
            playerState: {
              sessionId: player.session.id,
              userId: player.session.userId,
              track: player.track,
              position: player._realPosition(),
              isPaused: player.isPaused,
              volume: player.volumePercent,
              filters: player.filters,
              voice: player.voice
            }
          }
        })
      } catch (e) {
        logger('error', 'Worker-IPC', `Failed to send playerSnapshot for guild ${player.guildId}: ${e.message}`)
      }
    }
  }

  try {
    process.send({
      type: 'workerStats',
      pid: process.pid,
      stats: {
        players: localPlayers,
        playingPlayers: localPlayingPlayers,
        commandQueueLength: commandQueue.length
      }
    })
  } catch (e) {
    logger('error', 'Worker-IPC', `Failed to send workerStats: ${e.message}`)
  }
}, updateInterval)
