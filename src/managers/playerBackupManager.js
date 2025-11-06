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

  storeSnapshot(playerKey, workerId, playerState) {
    try {
      const [guildId, userId] = playerKey.split(':')
      const snapshot = {
        guildId,
        userId,
        sessionId: playerState.sessionId,
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
      
      this.snapshots.set(playerKey, compressed)
      this.workerAssignments.set(playerKey, workerId)
      this.lastUpdate.set(playerKey, Date.now())
    } catch (error) {
      logger('error', 'PlayerBackup', `Failed to store snapshot for ${playerKey}: ${error.message}`)
    }
  }

  getSnapshot(playerKey) {
    try {
      const compressed = this.snapshots.get(playerKey)
      if (!compressed) return null

      const decompressed = gunzipSync(compressed)
      const snapshot = JSON.parse(decompressed.toString())
      
      return snapshot
    } catch (error) {
      logger('error', 'PlayerBackup', `Failed to get snapshot for ${playerKey}: ${error.message}`)
      return null
    }
  }

  getWorkerSnapshots(workerId) {
    const snapshots = []
    
    for (const [playerKey, assignedWorkerId] of this.workerAssignments.entries()) {
      if (assignedWorkerId === workerId) {
        const snapshot = this.getSnapshot(playerKey)
        if (snapshot) {
          snapshots.push(snapshot)
        }
      }
    }
    
    logger('info', 'PlayerBackup', `Retrieved ${snapshots.length} snapshots for worker ${workerId}`)
    return snapshots
  }

  removeSnapshot(playerKey) {
    this.snapshots.delete(playerKey)
    this.workerAssignments.delete(playerKey)
    this.lastUpdate.delete(playerKey)
  }

  clearWorkerSnapshots(workerId) {
    let cleared = 0
    
    for (const [playerKey, assignedWorkerId] of this.workerAssignments.entries()) {
      if (assignedWorkerId === workerId) {
        this.removeSnapshot(playerKey)
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

      for (const [playerKey, lastUpdate] of this.lastUpdate.entries()) {
        if (now - lastUpdate > this.snapshotTTL) {
          this.removeSnapshot(playerKey)
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
