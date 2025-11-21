import { generateRandomLetters, logger } from '../utils.js'
import PlayerManager from './playerManager.js'

export default class SessionManager {
  constructor(nodelink, PlayerManagerClass = PlayerManager) {
    this.nodelink = nodelink
    this.PlayerManagerClass = PlayerManagerClass
    this.activeSessions = new Map()
    this.resumableSessions = new Map()
  }

  create(request, socket, clientInfo) {
    const sessionId = generateRandomLetters(16)
    logger(
      'debug',
      'SessionManager',
      `New session created with ID ${sessionId}`
    )
    const session = {
      id: sessionId,
      clientInfo,
      userId: request.headers['user-id'],
      socket,
      players: new this.PlayerManagerClass(this.nodelink, sessionId),
      resuming: false,
      timeout: 60,
      isPaused: false,
      eventQueue: [],
      timeoutFuture: null
    }
    this.activeSessions.set(sessionId, session)
    return sessionId
  }

  get(sessionId) {
    return (
      this.activeSessions.get(sessionId) ||
      this.resumableSessions.get(sessionId)
    )
  }

  has(sessionId) {
    return (
      this.activeSessions.has(sessionId) ||
      this.resumableSessions.has(sessionId)
    )
  }

  pause(sessionId) {
    const session = this.activeSessions.get(sessionId)
    if (!session) return

    logger(
      'info',
      'SessionManager',
      `Pausing session ${sessionId} for ${session.timeout} seconds.`
    )

    this.activeSessions.delete(sessionId)
    session.isPaused = true
    this.resumableSessions.set(sessionId, session)

    session.timeoutFuture = setTimeout(() => {
      logger(
        'info',
        'SessionManager',
        `Session ${sessionId} resume timeout expired. Destroying.`
      )
      this.resumableSessions.delete(sessionId)
      this.destroy(session)
    }, session.timeout * 1000)
  }

  resume(sessionId, newSocket) {
    const session = this.resumableSessions.get(sessionId)
    if (!session) return null

    logger('info', 'SessionManager', `Resuming session ${sessionId}.`)
    this.resumableSessions.delete(sessionId)

    if (session.timeoutFuture) {
      clearTimeout(session.timeoutFuture)
      session.timeoutFuture = null
    }

    session.socket = newSocket
    session.isPaused = false
    this.activeSessions.set(sessionId, session)

    return session
  }

  async destroy(session) {
    if (!session) return

    logger(
      'debug',
      'SessionManager',
      `Destroying session ${session.id} and its players.`
    )
    const { players } = session

    if (this.nodelink.workerManager) {
      for (const playerInfo of players.players.values()) {
        try {
          await players.destroy(playerInfo.guildId)
        } catch (error) {
          logger(
            'error',
            'SessionManager',
            `Failed to destroy player for guild ${playerInfo.guildId} during session destruction: ${error.message}`
          )
        }
      }
    } else {
      for (const player of players.players.values()) {
        player?.destroy()
      }
    }

    session.socket?.destroy()
  }

  async shutdown(sessionId) {
    logger('debug', 'SessionManager', `Shutting down session ${sessionId}.`)
    const session = this.activeSessions.get(sessionId)
    if (session) {
      this.activeSessions.delete(sessionId)
      await this.destroy(session)
    }
  }

  values() {
    return this.activeSessions.values()
  }
}
