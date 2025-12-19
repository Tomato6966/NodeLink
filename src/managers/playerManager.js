import { logger } from '../utils.js'

export default class PlayerManager {
  constructor(nodelink, sessionId) {
    this.nodelink = nodelink
    this.sessionId = sessionId
    this.players = new Map()
    this.isCluster = !!nodelink.workerManager
  }

  async _runInterceptors(action, guildId, ...args) {
    const interceptors = this.nodelink.extensions?.playerInterceptors
    if (!interceptors || interceptors.length === 0) return null

    for (const interceptor of interceptors) {
      try {
        const result = await interceptor(action, guildId, args)
        if (result !== null && result !== undefined && result !== false) {
          return { handled: true, result }
        }
      } catch (e) {
        logger('error', 'PlayerManager', `Interceptor error for ${action}: ${e.message}`)
      }
    }
    return null
  }

  async create(guildId, voice) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.players.has(playerKey)) {
      logger(
        'debug',
        'PlayerManager',
        `Returning existing player for guild ${guildId} (session: ${this.sessionId})`
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
        `Creating player for guild ${guildId} (session: ${this.sessionId}) on worker ${worker.id}`
      )
      await this.nodelink.workerManager.execute(worker, 'createPlayer', {
        sessionId: this.sessionId,
        guildId,
        userId: session.userId,
        voice
      })

      this.players.set(playerKey, {
        guildId,
        userId: session.userId,
        sessionId: this.sessionId
      })
      return this.players.get(playerKey)
    }
    const { Player } = await import('../playback/player.js')
    logger(
      'debug',
      'PlayerManager',
      `Creating new player for guild ${guildId} (session: ${this.sessionId})`
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
    const playerKey = `${this.sessionId}:${guildId}`
    return this.players.get(playerKey)
  }

  async destroy(guildId) {
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      if (!this.nodelink.workerManager.isGuildAssigned(playerKey)) {
        return
      }

      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (worker) {
        const destroyResult = await this.nodelink.workerManager.execute(
          worker,
          'destroyPlayer',
          { sessionId: this.sessionId, guildId }
        )
        if (destroyResult.destroyed) {
          this.nodelink.workerManager.unassignGuild(playerKey)
          this.players.delete(playerKey)
        } else {
          this.nodelink.workerManager.unassignGuild(playerKey)
          this.players.delete(playerKey)
        }
      } else {
        this.nodelink.workerManager.unassignGuild(playerKey)
        this.players.delete(playerKey)
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
    const interception = await this._runInterceptors('play', guildId, trackPayload)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('stop', guildId)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('pause', guildId, shouldPause)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('seek', guildId, position, endTime)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('volume', guildId, level)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('setFilters', guildId, filtersPayload)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const interception = await this._runInterceptors('updateVoice', guildId, voicePayload)
    if (interception?.handled) return interception.result

    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
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

  async addMix(guildId, trackPayload, volume = null) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
          guildId,
          userId: session.userId,
          command: 'addMix',
          args: [trackPayload, volume]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.addMix(trackPayload, volume)
  }

  async removeMix(guildId, mixId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
          guildId,
          userId: session.userId,
          command: 'removeMix',
          args: [mixId]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.removeMix(mixId)
  }

  async updateMix(guildId, mixId, volume) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
          guildId,
          userId: session.userId,
          command: 'updateMix',
          args: [mixId, volume]
        }
      )
      if (result && result.playerNotFound) {
        throw new Error('Player not found.')
      }
      return result
    }
    const player = this.players.get(playerKey)
    if (!player) throw new Error('Player not found locally.')
    return player.updateMix(mixId, volume)
  }

  async getMixes(guildId) {
    const session = this.nodelink.sessions.get(this.sessionId)
    const playerKey = `${this.sessionId}:${guildId}`

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(playerKey)
      if (!worker) throw new Error('Player not assigned to a worker.')
      const result = await this.nodelink.workerManager.execute(
        worker,
        'playerCommand',
        {
          sessionId: this.sessionId,
          guildId,
          userId: session.userId,
          command: 'getMixes',
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
    return player.getMixes()
  }
}
