import { Player } from '../playback/player.js'
import { logger } from '../utils.js'

export default class PlayerManager {
  constructor(nodelink, sessionId) {
    this.nodelink = nodelink
    this.sessionId = sessionId
    this.players = new Map()
  }

  create(guildId) {
    if (this.players.has(guildId)) {
      logger(
        'debug',
        'PlayerManager',
        `Returning existing player for guild ${guildId}`
      )
      return this.players.get(guildId)
    }

    logger('debug', 'PlayerManager', `Creating new player for guild ${guildId}`)
    const player = new Player({
      nodelink: this.nodelink,
      session: this.nodelink.sessions.get(this.sessionId),
      guildId: guildId
    })
    this.players.set(guildId, player)
    this.nodelink.statistics.players++
    return player
  }

  get(guildId) {
    return this.players.get(guildId)
  }
}
