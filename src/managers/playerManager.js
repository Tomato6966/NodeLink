import { logger } from '../utils.js'

export default class PlayerManager {
  constructor(nodelink, sessionId) {
    this.nodelink = nodelink
    this.sessionId = sessionId
    this.players = new Map()
    this.isCluster = !!nodelink.workerManager
  }

  async create(guildId, voice) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.players.has(playerKey)) {
      logger(
        'debug',
        'PlayerManager',
        `Returning existing player for guild ${guildId} (bot: ${session.userId})`
      )
      return this.players.get(playerKey)
    }

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) {
        throw new Error('No workers available to create a player.')
      }
      this.nodelink.workerManager.assignGuildToWorker(playerKey, worker)

      logger(
        'debug',
        'PlayerManager',
        `Creating player for guild ${guildId} (bot: ${session.userId}) on worker ${worker.id}`
      )
      await this.nodelink.workerManager.execute(worker, 'createPlayer', {
        sessionId: this.sessionId,
        guildId,
        userId: session.userId,
        voice
      })

      this.players.set(playerKey, { guildId, userId: session.userId })
      return this.players.get(playerKey)
    }
    const { Player } = await import('../playback/player.js')
    logger(
      'debug',
      'PlayerManager',
      `Creating new player for guild ${guildId} (bot: ${session.userId})`
    )
    const player = new Player({
      nodelink: this.nodelink,
      session: session,
      guildId: guildId
    })
    this.players.set(playerKey, player)
    this.nodelink.statistics.players++
    return player
  }

  get(guildId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`
    return this.players.get(playerKey)
  }

  async destroy(guildId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      if (!this.nodelink.workerManager.isGuildAssigned(playerKey)) {
        throw new Error('Player not found.')
      }

      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (worker) {
        const destroyResult = await this.nodelink.workerManager.execute(
          worker,
          'destroyPlayer',
          { guildId, userId: session.userId }
        )
        if (destroyResult.destroyed) {
          this.nodelink.workerManager.unassignGuild(playerKey)
          this.players.delete(playerKey)
        } else {
          this.nodelink.workerManager.unassignGuild(playerKey)
          this.players.delete(playerKey)
          throw new Error('Player not found in worker, but was assigned.')
        }
      } else {
        throw new Error('Assigned worker not found for player.')
      }
    } else {
      const player = this.players.get(playerKey)
      if (player) {
        player.destroy()
        this.players.delete(playerKey)
        this.nodelink.statistics.players--
      } else {
        throw new Error('Player not found locally.')
      }
    }
  }

  async play(guildId, trackPayload) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'play',
          args: [trackPayload]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.play(trackPayload)
  }

  async stop(guildId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'stop',
          args: []
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.stop()
  }

  async pause(guildId, shouldPause) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'pause',
          args: [shouldPause]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.pause(shouldPause)
  }

  async seek(guildId, position, endTime) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'seek',
          args: [position, endTime]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.seek(position, endTime)
  }

  async volume(guildId, level) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'volume',
          args: [level]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.volume(level)
  }

  async setFilters(guildId, filtersPayload) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'setFilters',
          args: [filtersPayload]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.setFilters(filtersPayload)
  }

  async updateVoice(guildId, voicePayload) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'updateVoice',
          args: [voicePayload]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.updateVoice(voicePayload)
  }

  async toJSON(guildId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${guildId}:${session.userId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          guildId,
          userId: session.userId,
          command: 'toJSON',
          args: []
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.toJSON()
  }
}
