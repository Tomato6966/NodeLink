import cluster from 'node:cluster'
import crypto from 'node:crypto'
import os from 'node:os'

import { logger } from '../utils.js'

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
    this.minWorkers = 1
    this.workerLoad = new Map()
    this.idleWorkers = new Map()
    this.scaleCheckInterval = null
    this.workerFailureHistory = new Map()
    this.statsUpdateBatch = new Map()
    this.statsUpdateTimer = null
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
      `Primary PID ${process.pid} - WorkerManager initialized. Max workers: ${this.maxWorkers}`
    )

    this._ensureWorkerAvailability()
    this._startScalingCheck()

    cluster.on('exit', (worker, code, signal) => {
      logger(
        'warn',
        'Cluster',
        `Worker ${worker.process.pid} exited (code=${code}). Respawning...`
      )
      this._updateWorkerFailureHistory(worker.id, code, signal)
      this.removeWorker(worker.id)

      const shouldRespawn = this.workers.length < this.minWorkers ||
        Array.from(this.workerToGuilds.get(worker.id) || []).length > 0

      if (shouldRespawn) {
        this.forkWorker()
      }
    })
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
    this.workerFailureHistory.set(worker.id, {
      count: 0,
      lastFailure: null,
      recentFailures: []
    })

    logger('info', 'Cluster', `Spawned worker ${worker.process.pid}`)

    worker.on('message', (msg) => this._handleWorkerMessage(worker, msg))

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
    } else if (msg.type === 'workerStats') {
      this.statsUpdateBatch.set(worker.id, msg.stats.players)

      if (!this.statsUpdateTimer) {
        this.statsUpdateTimer = setTimeout(() => {
          this._flushStatsUpdates()
        }, 100)
      }
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
    if (this.workers.length === 0 && this.maxWorkers > 0) {
      logger('info', 'Cluster', 'No workers available, forking initial worker.')
      this.forkWorker()
    }
  }

  destroy() {
    this._stopScalingCheck()

    if (this.statsUpdateTimer) {
      clearTimeout(this.statsUpdateTimer)
      this._flushStatsUpdates()
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

  execute(worker, type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomBytes(16).toString('hex')
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`Worker command timeout for request ${requestId}`))
      }, 30000)

      this.pendingRequests.set(requestId, { resolve, reject, timeout })

      worker.send({ type, requestId, payload })
    })
  }
}
