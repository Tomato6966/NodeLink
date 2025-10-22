import { Player } from '../playback/player.js'
import { logger } from '../utils.js'

export default class PlayerManager {
  constructor(nodelink, sessionId) {
    this.nodelink = nodelink
    this.sessionId = sessionId
    this.players = new Map()
    this.isCluster = !!nodelink.workerManager; 
  }

  async create(guildId, voice) {
    if (this.players.has(guildId)) {
      logger('debug', 'PlayerManager', `Returning existing player for guild ${guildId}`);
      return this.players.get(guildId);
    }

    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) {
        throw new Error('No workers available to create a player.');
      }
      this.nodelink.workerManager.assignGuildToWorker(guildId, worker);

      logger('debug', 'PlayerManager', `Creating player for guild ${guildId} on worker ${worker.id}`);
      await this.nodelink.workerManager.execute(worker, 'createPlayer', { sessionId: this.sessionId, guildId, userId: this.nodelink.sessions.get(this.sessionId).userId, voice });
      
      this.players.set(guildId, { guildId });
      return this.players.get(guildId);
    } else {
      logger('debug', 'PlayerManager', `Creating new player for guild ${guildId}`);
      const player = new Player({
        nodelink: this.nodelink,
        session: this.nodelink.sessions.get(this.sessionId),
        guildId: guildId
      });
      this.players.set(guildId, player);
      this.nodelink.statistics.players++;
      return player;
    }
  }

  get(guildId) {
    return this.players.get(guildId);
  }

  async destroy(guildId) {
    if (this.isCluster) {
      if (!this.nodelink.workerManager.isGuildAssigned(guildId)) {
          throw new Error('Player not found.');
      }
      
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (worker) {
        const destroyResult = await this.nodelink.workerManager.execute(worker, 'destroyPlayer', { guildId });
        if (destroyResult.destroyed) {
            this.nodelink.workerManager.unassignGuild(guildId);
            this.players.delete(guildId);
        } else {
           
            this.nodelink.workerManager.unassignGuild(guildId);
            this.players.delete(guildId);
            throw new Error('Player not found in worker, but was assigned.');
        }
      } else {
          throw new Error('Assigned worker not found for player.');
      }
    } else {
      const player = this.players.get(guildId);
      if (player) {
        player.destroy();
        this.players.delete(guildId);
        this.nodelink.statistics.players--;
      } else {
          throw new Error('Player not found locally.');
      }
    }
  }

  async play(guildId, trackPayload) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'play', args: [trackPayload] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.play(trackPayload);
    }
  }

  async stop(guildId) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'stop', args: [] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.stop();
    }
  }

  async pause(guildId, shouldPause) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'pause', args: [shouldPause] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.pause(shouldPause);
    }
  }

  async seek(guildId, position, endTime) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'seek', args: [position, endTime] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.seek(position, endTime);
    }
  }

  async volume(guildId, level) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'volume', args: [level] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.volume(level);
    }
  }

  async setFilters(guildId, filtersPayload) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'setFilters', args: [filtersPayload] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.setFilters(filtersPayload);
    }
  }

  async updateVoice(guildId, voicePayload) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'updateVoice', args: [voicePayload] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.updateVoice(voicePayload);
    }
  }

  async toJSON(guildId) {
    if (this.isCluster) {
      const worker = this.nodelink.workerManager.getWorkerForGuild(guildId);
      if (!worker) throw new Error('Player not assigned to a worker.');
      return this.nodelink.workerManager.execute(worker, 'playerCommand', { guildId, command: 'toJSON', args: [] });
    } else {
      const player = this.players.get(guildId);
      if (!player) throw new Error('Player not found locally.');
      return player.toJSON();
    }
  }
}