import cluster from 'node:cluster'
import os from 'node:os'
import crypto from 'node:crypto'
import { logger } from '../utils.js'

export default class WorkerManager {
  constructor(config) {
    this.config = config
    this.workers = []
    this.guildToWorker = new Map()
    this.nextStatelessWorkerIndex = 0
    this.pendingRequests = new Map()
    this.maxWorkers =
      config.cluster.workers === 0
        ? os.cpus().length
        : Math.max(1, config.cluster.workers || 0)
    this.minWorkers = 1
    this.workerLoad = new Map()
    this.idleWorkers = new Map()
    this.scaleCheckInterval = null

    logger(
      'info',
      'Cluster',
      `Primary PID ${process.pid} - WorkerManager initialized. Max workers: ${this.maxWorkers}`
    )

    this.ensureWorkerAvailability()
    this.startScalingCheck()

    cluster.on('exit', (worker, code, signal) => {
      logger(
        'warn',
        'Cluster',
        `Worker ${worker.process.pid} exited (code=${code}). Respawning...`
      )
      this.removeWorker(worker.id)
      if (
        this.workers.length < this.minWorkers ||
        Array.from(this.guildToWorker.values()).some((wId) => wId === worker.id)
      ) {
        this.forkWorker()
      }
    })
  }

  startScalingCheck() {
    if (this.scaleCheckInterval) return
    const interval = this.config.cluster.scaling?.checkIntervalMs || 5000
    this.scaleCheckInterval = setInterval(() => this.scaleWorkers(), interval)
    logger(
      'info',
      'Cluster',
      `Scaling check started with interval: ${interval}ms`
    )
  }

  stopScalingCheck() {
    if (this.scaleCheckInterval) {
      clearInterval(this.scaleCheckInterval)
      this.scaleCheckInterval = null
      logger('info', 'Cluster', 'Scaling check stopped')
    }
  }

  scaleWorkers() {
    const activeWorkers = this.workers.filter((w) => w.isConnected())
    const totalPlayers = Array.from(this.workerLoad.values()).reduce(
      (sum, load) => sum + load,
      0
    )

    const scalingConfig = this.config.cluster.scaling || {}
    const maxPlayersPerWorker = scalingConfig.maxPlayersPerWorker || 20
    const targetUtilization = scalingConfig.targetUtilization || 0.7
    const scaleUpThreshold = scalingConfig.scaleUpThreshold || 0.75
    const scaleDownThreshold = scalingConfig.scaleDownThreshold || 0.3
    const idleWorkerTimeoutMs = scalingConfig.idleWorkerTimeoutMs || 60000

    const clusterCapacity = activeWorkers.length * maxPlayersPerWorker
    const currentUtilization =
      clusterCapacity > 0 ? totalPlayers / clusterCapacity : 0

    if (
      currentUtilization > scaleUpThreshold &&
      activeWorkers.length < this.maxWorkers
    ) {
      logger(
        'info',
        'Cluster',
        `Scaling up: Current utilization ${currentUtilization.toFixed(2)} > ${scaleUpThreshold}. Forking new worker.`
      )
      this.forkWorker()
    } else if (
      currentUtilization < scaleDownThreshold &&
      activeWorkers.length > this.minWorkers
    ) {
      for (const [workerId, _] of this.workerLoad.entries()) {
        const worker = this.workers.find((w) => w.id === workerId)
        if (
          worker &&
          this.workerLoad.get(worker.id) === 0 &&
          activeWorkers.length > this.minWorkers
        ) {
          if (!this.idleWorkers.has(worker.id)) {
            this.idleWorkers.set(worker.id, Date.now())
            logger(
              'debug',
              'Cluster',
              `Worker ${worker.id} became idle. Start timeout for removal.`
            )
          } else if (
            Date.now() - this.idleWorkers.get(worker.id) >
            idleWorkerTimeoutMs
          ) {
            logger(
              'info',
              'Cluster',
              `Scaling down: Worker ${worker.id} idle for > ${idleWorkerTimeoutMs}ms. Removing worker.`
            )
            this.removeWorker(worker.id)
            break
          }
        } else if (
          this.idleWorkers.has(worker.id) &&
          this.workerLoad.get(worker.id) > 0
        ) {
          this.idleWorkers.delete(worker.id)
          logger('debug', 'Cluster', `Worker ${worker.id} is no longer idle.`)
        }
      }
    } else {
      for (const [workerId, timestamp] of this.idleWorkers.entries()) {
        const worker = this.workers.find((w) => w.id === workerId)
        if (worker && this.workerLoad.get(worker.id) > 0) {
          this.idleWorkers.delete(worker.id)
          logger('debug', 'Cluster', `Worker ${worker.id} is no longer idle.`)
        }
      }
    }
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
    this.workerLoad.set(worker.id, 0)
    logger('info', 'Cluster', `Spawned worker ${worker.process.pid}`)

    worker.on('message', (msg) => this.handleWorkerMessage(worker, msg))
    return worker
  }

  removeWorker(workerId) {
    const worker = this.workers.find((w) => w.id === workerId)
    if (!worker) return

    const index = this.workers.findIndex((w) => w.id === workerId)
    if (index !== -1) this.workers.splice(index, 1)
    this.workerLoad.delete(workerId)
    this.idleWorkers.delete(workerId)

    const affectedGuilds = []
    for (const [guildId, wId] of this.guildToWorker.entries()) {
      if (wId === workerId) {
        affectedGuilds.push(guildId)
        this.guildToWorker.delete(guildId)
        logger(
          'warn',
          'Cluster',
          `Guild ${guildId} unassigned due to worker ${workerId} exit. Will be reassigned on next request.`
        )
      }
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

  handleWorkerMessage(worker, msg) {
    if (msg.type === 'commandResult') {
      const callback = this.pendingRequests.get(msg.requestId)
      if (callback) {
        clearTimeout(callback.timeout)
        this.pendingRequests.delete(msg.requestId)
        if (msg.error) callback.reject(new Error(String(msg.error)))
        else callback.resolve(msg.payload)
      }
    } else if (msg.type === 'workerStats') {
      this.workerLoad.set(worker.id, msg.stats.players)
      if (msg.stats.players === 0 && !this.idleWorkers.has(worker.id)) {
        this.idleWorkers.set(worker.id, Date.now())
      } else if (msg.stats.players > 0 && this.idleWorkers.has(worker.id)) {
        this.idleWorkers.delete(worker.id)
      }
    } else if (global.nodelink) {
      global.nodelink.handleIPCMessage(msg)
    }
  }

  getWorkerForGuild(guildId) {
    if (this.guildToWorker.has(guildId)) {
      const workerId = this.guildToWorker.get(guildId)
      const worker = this.workers.find((w) => w.id === workerId)
      if (worker?.isConnected()) return worker
      this.guildToWorker.delete(guildId)
    }

    if (this.workers.length === 0 && this.maxWorkers > 0) {
      const worker = this.forkWorker()
      if (!worker)
        throw new Error('No workers available and cannot fork new ones.')
      this.assignGuildToWorker(guildId, worker)
      return worker
    }

    let bestWorker = null
    let minLoad = Infinity

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
      if (!worker)
        throw new Error('No workers available and cannot fork new ones.')
      return worker
    }
    const worker = this.workers[this.nextStatelessWorkerIndex]
    this.nextStatelessWorkerIndex =
      (this.nextStatelessWorkerIndex + 1) % this.workers.length
    return worker
  }

  assignGuildToWorker(guildId, worker) {
    this.guildToWorker.set(guildId, worker.id)
    logger(
      'debug',
      'Cluster',
      `Assigned guild ${guildId} to worker ${worker.id}`
    )
  }

  unassignGuild(guildId) {
    this.guildToWorker.delete(guildId)
  }

  isGuildAssigned(guildId) {
    return this.guildToWorker.has(guildId)
  }

  ensureWorkerAvailability() {
    if (this.workers.length === 0 && this.maxWorkers > 0) {
      logger('info', 'Cluster', 'No workers available, forking initial worker.')
      this.forkWorker()
    }
  }

  destroy() {
    this.stopScalingCheck()
    for (const worker of this.workers) {
      if (worker.isConnected()) {
        worker.process.kill()
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
      this.pendingRequests.set(requestId, { resolve, reject })

      worker.send({ type, requestId, payload })
    })
  }
}
