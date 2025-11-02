import { gzipSync, gunzipSync } from 'node:zlib'
import { logger } from '../utils.js'

export default class PlayerBackupManager {
  constructor() {
    this.snapshots = new Map()
    this.workerAssignments = new Map()
    this.lastUpdate = new Map()
    this.cleanupInterval = null
    this.snapshotTTL = 300000
    
    logger('info', 'PlayerBackup', 'Backup manager initialized')
    this._startCleanup()
  }

  storeSnapshot(guildId, workerId, playerState) {
    try {
      const snapshot = {
        guildId,
        sessionId: playerState.sessionId,
        userId: playerState.userId,
        track: playerState.track,
        position: playerState.position || 0,
        isPaused: playerState.isPaused || false,
        volume: playerState.volume || 100,
        filters: playerState.filters || {},
        voice: playerState.voice,
        timestamp: Date.now()
      }

      const json = JSON.stringify(snapshot)
      const compressed = gzipSync(Buffer.from(json))
      
      this.snapshots.set(guildId, compressed)
      this.workerAssignments.set(guildId, workerId)
      this.lastUpdate.set(guildId, Date.now())
    } catch (error) {
      logger('error', 'PlayerBackup', `Failed to store snapshot for guild ${guildId}: ${error.message}`)
    }
  }

  getSnapshot(guildId) {
    try {
      const compressed = this.snapshots.get(guildId)
      if (!compressed) return null

      const decompressed = gunzipSync(compressed)
      const snapshot = JSON.parse(decompressed.toString())
      
      return snapshot
    } catch (error) {
      logger('error', 'PlayerBackup', `Failed to get snapshot for guild ${guildId}: ${error.message}`)
      return null
    }
  }

  getWorkerSnapshots(workerId) {
    const snapshots = []
    
    for (const [guildId, assignedWorkerId] of this.workerAssignments.entries()) {
      if (assignedWorkerId === workerId) {
        const snapshot = this.getSnapshot(guildId)
        if (snapshot) {
          snapshots.push(snapshot)
        }
      }
    }
    
    logger('info', 'PlayerBackup', `Retrieved ${snapshots.length} snapshots for worker ${workerId}`)
    return snapshots
  }

  removeSnapshot(guildId) {
    this.snapshots.delete(guildId)
    this.workerAssignments.delete(guildId)
    this.lastUpdate.delete(guildId)
  }

  clearWorkerSnapshots(workerId) {
    let cleared = 0
    
    for (const [guildId, assignedWorkerId] of this.workerAssignments.entries()) {
      if (assignedWorkerId === workerId) {
        this.removeSnapshot(guildId)
        cleared++
      }
    }
    
    logger('info', 'PlayerBackup', `Cleared ${cleared} snapshots for worker ${workerId}`)
    return cleared
  }

  _startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      let cleaned = 0

      for (const [guildId, lastUpdate] of this.lastUpdate.entries()) {
        if (now - lastUpdate > this.snapshotTTL) {
          this.removeSnapshot(guildId)
          cleaned++
        }
      }

      if (cleaned > 0) {
        logger('info', 'PlayerBackup', `Cleaned ${cleaned} expired snapshots`)
      }
    }, 60000)
  }

  getStats() {
    let totalSize = 0
    for (const compressed of this.snapshots.values()) {
      totalSize += compressed.length
    }

    return {
      totalSnapshots: this.snapshots.size,
      totalSizeBytes: totalSize,
      totalSizeKB: Math.round(totalSize / 1024),
      workers: new Set(this.workerAssignments.values()).size
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    
    this.snapshots.clear()
    this.workerAssignments.clear()
    this.lastUpdate.clear()
    
    logger('info', 'PlayerBackup', 'Backup manager destroyed')
  }
}
