import cluster from 'node:cluster'
import crypto from 'node:crypto'
import os from 'node:os'

import { logger } from '../utils.js'
import PlayerBackupManager from './playerBackupManager.js'

export default class WorkerManager {
  constructor(config) {
    this.config = config
    this.workers = []
    this.workersById = new Map()
    this.guildToWorker = new Map()
    this.workerToGuilds = new Map()
    this.nextStatelessWorkerIndex = 0
    this.pendingRequests = new Map()
    this.maxWorkers = config.cluster.workers === 0
      ? os.cpus().length
      : Math.max(1, config.cluster.workers || 0)
    this.minWorkers = Math.max(1, config.cluster?.minWorkers || 1)
    this.workerLoad = new Map()
    this.idleWorkers = new Map()
    this.scaleCheckInterval = null
    this.workerFailureHistory = new Map()
    this.statsUpdateBatch = new Map()
    this.statsUpdateTimer = null
    this.workerHealth = new Map()
    this.commandTimeout = config.cluster?.commandTimeout || 45000
    this.fastCommandTimeout = config.cluster?.fastCommandTimeout || 10000
    this.maxRetries = config.cluster?.maxRetries || 2
    this.backupManager = new PlayerBackupManager()
    this.scalingConfig = {
      maxPlayersPerWorker: config.cluster.scaling?.maxPlayersPerWorker || 20,
      targetUtilization: config.cluster.scaling?.targetUtilization || 0.7,
      scaleUpThreshold: config.cluster.scaling?.scaleUpThreshold || 0.75,
      scaleDownThreshold: config.cluster.scaling?.scaleDownThreshold || 0.3,
      idleWorkerTimeoutMs: config.cluster.scaling?.idleWorkerTimeoutMs || 60000,
      checkIntervalMs: config.cluster.scaling?.checkIntervalMs || 5000
    }

    logger(
      'info',
      'Cluster',
      `Primary PID ${process.pid} - WorkerManager initialized. Min: ${this.minWorkers}, Max: ${this.maxWorkers} workers`
    )

    this._ensureWorkerAvailability()
    this._startScalingCheck()
    this._startHealthCheck()

    cluster.on('exit', (worker, code, signal) => {
      logger(
        'warn',
        'Cluster',
        `Worker ${worker.process.pid} exited (code=${code}, signal=${signal})`
      )
      this._updateWorkerFailureHistory(worker.id, code, signal)
      
      const affectedGuilds = Array.from(this.workerToGuilds.get(worker.id) || [])
      const snapshots = this.backupManager.getWorkerSnapshots(worker.id)
      
      this._retryPendingRequestsForWorker(worker.id)
      this.removeWorker(worker.id)

      const shouldRespawn = this._shouldRespawnWorker(worker.id, code, affectedGuilds.length)

      if (shouldRespawn) {
        logger('info', 'Cluster', `Respawning worker and restoring ${snapshots.length} players...`)
        setTimeout(() => {
          const newWorker = this.forkWorker()
          if (newWorker && snapshots.length > 0) {
            this._restorePlayers(newWorker, snapshots)
          }
        }, 500)
      }
    })
  }

  _shouldRespawnWorker(workerId, exitCode, affectedGuildsCount) {
    if (this.workers.length < this.minWorkers) return true
    if (affectedGuildsCount > 0) return true

    const history = this.workerFailureHistory.get(workerId)
    if (history) {
      const recentFailures = history.recentFailures.filter(
        f => Date.now() - f.timestamp < 30000
      )
      
      if (recentFailures.length >= 3) {
        logger(
          'error',
          'Cluster',
          `Worker ${workerId} crashed ${recentFailures.length} times in 30s. Preventing crash loop.`
        )
        return false
      }
    }

    return true
  }

  _startHealthCheck() {
    setInterval(() => {
      const now = Date.now()
      for (const worker of this.workers) {
        if (worker.isConnected()) {
          const lastSeen = this.workerHealth.get(worker.id) || 0
          if (now - lastSeen > 30000) {
            logger('warn', 'Cluster', `Worker ${worker.id} unresponsive (${Math.floor((now - lastSeen) / 1000)}s)`)
          }
          worker.send({ type: 'ping', timestamp: now })
        }
      }
    }, 10000)
  }

  _retryPendingRequestsForWorker(workerId) {
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.workerId === workerId) {
        clearTimeout(request.timeout)
        this.pendingRequests.delete(requestId)
        
        if (request.retryCount < this.maxRetries) {
          logger('debug', 'Cluster', `Retrying command after worker ${workerId} exit (attempt ${request.retryCount + 1})`)
          
          setTimeout(() => {
            const newWorker = this.getBestWorker()
            if (newWorker) {
              this._executeCommand(newWorker, request.type, request.payload, request.resolve, request.reject, request.retryCount + 1, request.isFast)
            } else {
              request.reject(new Error('No workers available for retry'))
            }
          }, 500 * Math.pow(2, request.retryCount))
        } else {
          request.reject(new Error(`Worker ${workerId} exited before completing request`))
        }
      }
    }
  }

  _startScalingCheck() {
    if (this.scaleCheckInterval) return;

    this.scaleCheckInterval = setInterval(
      () => this._scaleWorkers(),
      this.scalingConfig.checkIntervalMs
    )

    logger(
      'info',
      'Cluster',
      `Scaling check started with interval: ${this.scalingConfig.checkIntervalMs}ms`
    )
  }

  _stopScalingCheck() {
    if (this.scaleCheckInterval) {
      clearInterval(this.scaleCheckInterval)
      this.scaleCheckInterval = null
      logger('info', 'Cluster', 'Scaling check stopped')
    }
  }

  _scaleWorkers() {
    let activeCount = 0
    let totalPlayers = 0
    const metrics = []

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        activeCount++
        const load = this.workerLoad.get(worker.id) || 0
        totalPlayers += load
        metrics.push({ worker, load })
      }
    }

    const { maxPlayersPerWorker, scaleUpThreshold, scaleDownThreshold, idleWorkerTimeoutMs } = this.scalingConfig
    const clusterCapacity = activeCount * maxPlayersPerWorker
    const currentUtilization = clusterCapacity > 0 ? totalPlayers / clusterCapacity : 0

    if (currentUtilization > scaleUpThreshold && activeCount < this.maxWorkers) {
      logger(
        'info',
        'Cluster',
        `Scaling up: Current utilization ${currentUtilization.toFixed(2)} > ${scaleUpThreshold}. Forking new worker.`
      )
      this.forkWorker()
      return;
    }

    if (currentUtilization < scaleDownThreshold && activeCount > this.minWorkers) {
      const now = Date.now()

      for (const { worker, load } of metrics) {
        if (load === 0 && activeCount > this.minWorkers) {
          const idleTime = this.idleWorkers.get(worker.id)

          if (!idleTime) {
            this.idleWorkers.set(worker.id, now)
            logger(
              'debug',
              'Cluster',
              `Worker ${worker.id} became idle. Start timeout for removal.`
            )
          } else if (now - idleTime > idleWorkerTimeoutMs) {
            logger(
              'info',
              'Cluster',
              `Scaling down: Worker ${worker.id} idle for > ${idleWorkerTimeoutMs}ms. Removing worker.`
            )
            this.removeWorker(worker.id)
            activeCount--
            break
          }
        } else if (load > 0) {
          if (this.idleWorkers.has(worker.id)) {
            this.idleWorkers.delete(worker.id)
            logger('debug', 'Cluster', `Worker ${worker.id} is no longer idle.`)
          }
        }
      }
    } else {
      for (const { worker, load } of metrics) {
        if (load > 0 && this.idleWorkers.has(worker.id)) {
          this.idleWorkers.delete(worker.id)
          logger('debug', 'Cluster', `Worker ${worker.id} is no longer idle.`)
        }
      }
    }
  }

  _updateWorkerFailureHistory(workerId, code, signal) {
    let history = this.workerFailureHistory.get(workerId)

    if (!history) {
      history = {
        count: 0,
        lastFailure: null,
        recentFailures: []
      }
      this.workerFailureHistory.set(workerId, history)
    }

    history.count++
    history.lastFailure = Date.now()
    history.recentFailures.push({ timestamp: Date.now(), code, signal })

    if (history.recentFailures.length > 5) {
      history.recentFailures = history.recentFailures.slice(-5)
    }

    logger(
      'debug',
      'Cluster',
      `Worker ${workerId} failure history updated: ${JSON.stringify(history)}`
    )
  }

  forkWorker() {
    if (this.workers.length >= this.maxWorkers) {
      logger(
        'warn',
        'Cluster',
        `Cannot fork new worker: maximum worker limit (${this.maxWorkers}) reached.`
      )
      return null
    }

    const worker = cluster.fork()

    this.workers.push(worker)
    this.workersById.set(worker.id, worker)
    this.workerLoad.set(worker.id, 0)
    this.workerToGuilds.set(worker.id, new Set())
    this.workerHealth.set(worker.id, Date.now())
    this.workerFailureHistory.set(worker.id, {
      count: 0,
      lastFailure: null,
      recentFailures: []
    })

    logger('info', 'Cluster', `Spawned worker ${worker.process.pid} (id: ${worker.id})`)

    worker.on('message', (msg) => this._handleWorkerMessage(worker, msg))
    
    worker.on('error', (error) => {
      logger('error', 'Cluster', `Worker ${worker.id} error: ${error.message}`)
    })

    return worker
  }

  removeWorker(workerId) {
    const worker = this.workersById.get(workerId)
    if (!worker) return;

    const index = this.workers.indexOf(worker)
    if (index !== -1) this.workers.splice(index, 1)

    this.workersById.delete(workerId)
    this.workerLoad.delete(workerId)
    this.idleWorkers.delete(workerId)

    const affectedGuilds = Array.from(this.workerToGuilds.get(workerId) || [])
    this.workerToGuilds.delete(workerId)

    for (const guildId of affectedGuilds) {
      this.guildToWorker.delete(guildId)
      logger(
        'warn',
        'Cluster',
        `Guild ${guildId} unassigned due to worker ${workerId} exit. Will be reassigned on next request.`
      )
    }

    if (affectedGuilds.length > 0) {
      for (const guildId of affectedGuilds) {
        for (const session of global.nodelink.sessions.values()) {
          if (session.players.players.has(guildId)) {
            session.players.players.delete(guildId)
            logger(
              'debug',
              'Cluster',
              `Removed stale player placeholder for guild ${guildId} from session ${session.id}`
            )
          }
        }
      }

      global.nodelink.handleIPCMessage({
        type: 'workerFailed',
        payload: { workerId: worker.id, affectedGuilds }
      })
    }

    try {
      worker.process.kill()
      logger(
        'info',
        'Cluster',
        `Terminated worker ${worker.process.pid} (id: ${worker.id})`
      )
    } catch (e) {
      logger(
        'error',
        'Cluster',
        `Failed to kill worker ${worker.process.pid}: ${e.message}`
      )
    }
  }

  _handleWorkerMessage(worker, msg) {
    if (msg.type === 'commandResult') {
      const callback = this.pendingRequests.get(msg.requestId)
      if (callback) {
        clearTimeout(callback.timeout)
        this.pendingRequests.delete(msg.requestId)
        if (msg.error) callback.reject(new Error(String(msg.error)))
        else callback.resolve(msg.payload)
      }
    } else if (msg.type === 'playerSnapshot') {
      const { guildId, playerState } = msg.payload
      this.backupManager.storeSnapshot(guildId, worker.id, playerState)
    } else if (msg.type === 'playerDestroyed') {
      const { guildId } = msg.payload
      this.backupManager.removeSnapshot(guildId)
    } else if (msg.type === 'workerStats') {
      this.statsUpdateBatch.set(worker.id, msg.stats.players)

      if (!this.statsUpdateTimer) {
        this.statsUpdateTimer = setTimeout(() => {
          this._flushStatsUpdates()
        }, 100)
      }
    } else if (msg.type === 'pong') {
      this.workerHealth.set(worker.id, Date.now())
    } else if (msg.type === 'ready') {
      this.workerHealth.set(worker.id, Date.now())
      logger('info', 'Cluster', `Worker ${worker.id} (PID ${worker.process.pid}) ready`)
    } else if (global.nodelink) {
      global.nodelink.handleIPCMessage(msg)
    }
  }

  _flushStatsUpdates() {
    for (const [workerId, players] of this.statsUpdateBatch) {
      this.workerLoad.set(workerId, players)

      if (players === 0 && !this.idleWorkers.has(workerId)) {
        this.idleWorkers.set(workerId, Date.now())
      } else if (players > 0) {
        this.idleWorkers.delete(workerId)
      }
    }

    this.statsUpdateBatch.clear()
    this.statsUpdateTimer = null
  }

  getWorkerForGuild(guildId) {
    if (this.guildToWorker.has(guildId)) {
      const workerId = this.guildToWorker.get(guildId)
      const worker = this.workersById.get(workerId)

      if (worker?.isConnected()) return worker

      this.guildToWorker.delete(guildId)
      this.workerToGuilds.get(workerId)?.delete(guildId)
    }

    if (this.workers.length === 0 && this.maxWorkers > 0) {
      const worker = this.forkWorker()
      if (!worker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      this.assignGuildToWorker(guildId, worker)
      return worker
    }

    let bestWorker = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        const load = this.workerLoad.get(worker.id) || 0
        if (load < minLoad) {
          minLoad = load
          bestWorker = worker
        }
      }
    }

    if (!bestWorker) {
      bestWorker = this.forkWorker()
      if (!bestWorker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
    }

    this.assignGuildToWorker(guildId, bestWorker)
    return bestWorker
  }

  getBestWorker() {
    if (this.workers.length === 0) {
      const worker = this.forkWorker()
      if (!worker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      return worker
    }

    let bestWorker = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        const load = this.workerLoad.get(worker.id) || 0
        if (load < minLoad) {
          minLoad = load
          bestWorker = worker
        }
      }
    }

    return bestWorker || this.forkWorker()
  }

  assignGuildToWorker(guildId, worker) {
    this.guildToWorker.set(guildId, worker.id)

    if (!this.workerToGuilds.has(worker.id)) {
      this.workerToGuilds.set(worker.id, new Set())
    }
    this.workerToGuilds.get(worker.id).add(guildId)

    logger(
      'debug',
      'Cluster',
      `Assigned guild ${guildId} to worker ${worker.id}`
    )
  }

  unassignGuild(guildId) {
    const workerId = this.guildToWorker.get(guildId)
    this.guildToWorker.delete(guildId)

    if (workerId && this.workerToGuilds.has(workerId)) {
      this.workerToGuilds.get(workerId).delete(guildId)
    }
  }

  isGuildAssigned(guildId) {
    return this.guildToWorker.has(guildId)
  }

  _ensureWorkerAvailability() {
    const neededWorkers = Math.max(this.minWorkers - this.workers.length, 0)

    for (let i = 0; i < neededWorkers && this.workers.length < this.maxWorkers; i++) {
      logger('info', 'Cluster', `Forking worker ${this.workers.length + 1}/${this.minWorkers}`)
      this.forkWorker()
    }
  }

  async _restorePlayers(worker, snapshots) {
    logger('info', 'Cluster', `Restoring ${snapshots.length} players to worker ${worker.id}`)
    
    for (const snapshot of snapshots) {
      try {
        this.assignGuildToWorker(snapshot.guildId, worker)
        
        await this.execute(worker, 'restorePlayer', {
          snapshot
        })
        
        logger('debug', 'Cluster', `Restored player for guild ${snapshot.guildId}`)
      } catch (error) {
        logger('error', 'Cluster', `Failed to restore player for guild ${snapshot.guildId}: ${error.message}`)
      }
    }
    
    logger('info', 'Cluster', `Restoration complete for worker ${worker.id}`)
  }

  destroy() {
    this._stopScalingCheck()

    if (this.statsUpdateTimer) {
      clearTimeout(this.statsUpdateTimer)
      this._flushStatsUpdates()
    }
    
    if (this.backupManager) {
      this.backupManager.destroy()
    }

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        worker.process.kill()
      } else {
        logger(
          'debug',
          'Cluster',
          `Worker ${worker.id} is not connected, skipping kill.`
        )
      }
    }

    logger(
      'info',
      'Cluster',
      'WorkerManager destroyed. All workers terminated.'
    )
  }

  execute(worker, type, payload, options = {}) {
    return new Promise((resolve, reject) => {
      this._executeCommand(worker, type, payload, resolve, reject, 0, options.fast || false)
    })
  }

  _executeCommand(worker, type, payload, resolve, reject, retryCount, isFast) {
    const requestId = crypto.randomBytes(16).toString('hex')
    const timeoutMs = isFast ? this.fastCommandTimeout : this.commandTimeout
    
    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId)
      
      if (retryCount < this.maxRetries && worker.isConnected()) {
        logger('warn', 'Cluster', `Command timeout (${timeoutMs}ms), retrying... (${retryCount + 1}/${this.maxRetries})`)
        
        setTimeout(() => {
          const newWorker = this.getBestWorker() || worker
          this._executeCommand(newWorker, type, payload, resolve, reject, retryCount + 1, isFast)
        }, 500)
      } else {
        reject(new Error(`Worker command timeout after ${retryCount + 1} attempts`))
      }
    }, timeoutMs)

    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      workerId: worker.id,
      type,
      payload,
      retryCount,
      isFast,
      startTime: Date.now()
    })

    try {
      if (!worker.isConnected()) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)
        
        if (retryCount < this.maxRetries) {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(newWorker, type, payload, resolve, reject, retryCount + 1, isFast)
          } else {
            reject(new Error('No workers available'))
          }
        } else {
          reject(new Error('Worker disconnected and max retries reached'))
        }
        return
      }

      worker.send({ type, requestId, payload })
    } catch (error) {
      clearTimeout(timeout)
      this.pendingRequests.delete(requestId)
      
      if (retryCount < this.maxRetries) {
        logger('error', 'Cluster', `Send error: ${error.message}, retrying...`)
        setTimeout(() => {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(newWorker, type, payload, resolve, reject, retryCount + 1, isFast)
          } else {
            reject(error)
          }
        }, 500)
      } else {
        reject(error)
      }
    }
  }
}
