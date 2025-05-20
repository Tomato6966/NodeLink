import { generateRandomLetters } from '../utils.js'
import PlayerManager from './playerManager.js'

export default class SessionManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.connections = new Map()
  }
  create(request, socket, clientInfo) {
    const sessionId = generateRandomLetters(16)
    this.connections.set(sessionId, {
      clientInfo,
      userId: request.headers['user-id'],
      request,
      socket,
      players: new PlayerManager(this.nodelink, sessionId)
    })
    return sessionId
  }
  get(sessionId) {
    return this.connections.get(sessionId)
  }
  has(sessionId) {
    return this.connections.has(sessionId)
  }
  delete(sessionId) {
    const connection = this.connections.get(sessionId)
    if (connection) {
      connection.socket.destroy()
      this.connections.delete(sessionId)
    }
  }
  values() {
    return this.connections.values()
  }
}
