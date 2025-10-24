import { Player } from './playback/player.js'
import { logger, initLogger } from './utils.js'
import SourceManager from './managers/sourceManager.js'
import LyricsManager from './managers/lyricsManager.js'
import StatsManager from './managers/statsManager.js'
import RoutePlannerManager from './managers/routePlannerManager.js'
import ConnectionManager from './managers/connectionManager.js'
import { GatewayEvents } from './constants.js'

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

async function initialize() {
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()
  logger(
    'info',
    'Worker',
    `Worker process ${process.pid} started and initialized.`
  )
}

initialize()

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
                process.send({
                  type: 'playerEvent',
                  payload: { sessionId, guildId, data }
                })
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
          result = { destroyed: true }
        } else {
          result = { destroyed: false, reason: 'Player not found in worker' }
        }
        break
      }

      case 'playerCommand': {
        const { guildId, command, args } = payload
        const player = players.get(guildId)
        if (player && typeof player[command] === 'function') {
          result = await player[command](...args)
        } else {
          throw new Error(
            `Player or command '${command}' not found for guild ${guildId}`
          )
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
      process.send({ type: 'commandResult', requestId, payload: result })
    }
  } catch (e) {
    if (process.connected) {
      process.send({ type: 'commandResult', requestId, error: e.message })
    }
  } finally {
    if (commandQueue.length > 0) {
      setImmediate(processQueue)
    }
  }
}

process.on('message', (msg) => {
  if (!msg.type || !msg.requestId) return

  commandQueue.push(msg)
  setImmediate(processQueue)
})

const updateInterval = config?.playerUpdateInterval ?? 5000
const zombieThreshold = config?.zombieThresholdMs ?? 60000

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
      player._sendUpdate()
    }
  }

  process.send({
    type: 'workerStats',
    pid: process.pid,
    stats: {
      players: localPlayers,
      playingPlayers: localPlayingPlayers,
      commandQueueLength: commandQueue.length
    }
  })
}, updateInterval)
