import cluster from 'node:cluster'
import crypto from 'node:crypto'
import os from 'node:os'
import net from 'node:net'

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
    this.streamRequests = new Map()
    this.maxWorkers =
      config.cluster.workers === 0
        ? os.cpus().length
        : Math.max(1, config.cluster.workers || 0)
    this.minWorkers = Math.max(1, config.cluster?.minWorkers || 1)
    this.workerLoad = new Map()
    this.workerStats = new Map()
    this.idleWorkers = new Map()
    this.scaleCheckInterval = null
    this.healthCheckInterval = null
    this.workerFailureHistory = new Map()
    this.statsUpdateBatch = new Map()
    this.statsUpdateTimer = null
    this.workerHealth = new Map()
    this.workerStartTime = new Map()
    this.workerUniqueId = new Map()
    this.workerReady = new Set()
    this.nextWorkerId = 1
    this.liveYoutubeConfig = { refreshToken: null, visitorData: null }
    this.isDestroying = false
    this.commandTimeout = config.cluster?.commandTimeout || 45000
    this.fastCommandTimeout = config.cluster?.fastCommandTimeout || 10000
    this.maxRetries = config.cluster?.maxRetries || 2
    this.scalingConfig = {
      maxPlayersPerWorker:
        config.cluster.scaling?.maxPlayersPerWorker ||
        config.cluster.workers ||
        20,
      targetUtilization: config.cluster.scaling?.targetUtilization || 0.7,
      scaleUpThreshold: config.cluster.scaling?.scaleUpThreshold || 0.75,
      scaleDownThreshold: config.cluster.scaling?.scaleDownThreshold || 0.3,
      idleWorkerTimeoutMs: config.cluster.scaling?.idleWorkerTimeoutMs || 60000,
      checkIntervalMs: config.cluster.scaling?.checkIntervalMs || 5000,
      lagPenaltyLimit: config.cluster.scaling?.lagPenaltyLimit || 60,
      cpuPenaltyLimit: config.cluster.scaling?.cpuPenaltyLimit || 0.85
    }

    this.socketPath = os.platform() === 'win32'
      ? `\\\\.\\pipe\\nodelink-events-${crypto.randomBytes(8).toString('hex')}`
      : `/tmp/nodelink-events-${crypto.randomBytes(8).toString('hex')}.sock`
    this.server = null

    logger(
      'info',
      'Cluster',
      `Primary PID ${process.pid} - WorkerManager initialized. Min: ${this.minWorkers}, Max: ${this.maxWorkers} workers`
    )

    this._startSocketServer()
    this._ensureWorkerAvailability()
    this._startScalingCheck()
    this._startHealthCheck()

    cluster.on('exit', (worker, code, signal) => {
      if (worker.workerType !== 'playback') return

      const isSystemSignal = signal === 'SIGINT' || signal === 'SIGTERM' || code === 130 || code === 143
      if (this.isDestroying || isSystemSignal) {
        const index = this.workers.indexOf(worker)
        if (index !== -1) this.workers.splice(index, 1)
        this.workersById.delete(worker.id)
        return
      }

      this._updateWorkerFailureHistory(worker.id, code, signal)

      if (global.nodelink?.statsManager) {
        global.nodelink.statsManager.incrementWorkerFailure(worker.id, code)
      }

      const affectedGuilds = Array.from(
        this.workerToGuilds.get(worker.id) || []
      )

      this._retryPendingRequestsForWorker(worker.id)
      this.removeWorker(worker.id)

      const shouldRespawn = this._shouldRespawnWorker(
        worker.id,
        code,
        affectedGuilds.length
      )

      if (shouldRespawn) {
        logger('info', 'Cluster', 'Respawning worker...')
        const history = this.workerFailureHistory.get(worker.id)
        const delay = history ? Math.min(history.count * 1000, 30000) : 500
        
        setTimeout(() => {
          this.forkWorker()
          if (global.nodelink?.statsManager) {
            global.nodelink.statsManager.incrementWorkerRestart(worker.id)
          }
        }, delay)
      }
    })
  }

  _shouldRespawnWorker(workerId, exitCode, affectedGuildsCount) {
    if (this.isDestroying) return false
    if (this.workers.length < this.minWorkers) return true
    if (affectedGuildsCount > 0) return true

    const history = this.workerFailureHistory.get(workerId)
    if (history) {
      const recentFailures = history.recentFailures.filter(
        (f) => Date.now() - f.timestamp < 30000
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
    this.healthCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const worker of this.workers) {
        if (worker.isConnected()) {
          const lastSeen = this.workerHealth.get(worker.id) || 0
          if (now - lastSeen > 30000) {
            logger(
              'warn',
              'Cluster',
              `Worker ${worker.id} unresponsive (${Math.floor((now - lastSeen) / 1000)}s)`
            )
          }
          worker.send({ type: 'ping', timestamp: now })
        }
      }
    }, 10000)
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
      logger('info', 'Cluster', 'Health check stopped')
    }
  }

  _retryPendingRequestsForWorker(workerId) {
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.workerId === workerId) {
        clearTimeout(request.timeout)
        this.pendingRequests.delete(requestId)

        if (request.retryCount < this.maxRetries) {
          logger(
            'debug',
            'Cluster',
            `Retrying command after worker ${workerId} exit (attempt ${request.retryCount + 1})`
          )

          setTimeout(
            () => {
              const newWorker = this.getBestWorker()
              if (newWorker) {
                this._executeCommand(
                  newWorker,
                  request.type,
                  request.payload,
                  request.resolve,
                  request.reject,
                  request.retryCount + 1,
                  request.isFast
                )
              } else {
                request.reject(new Error('No workers available for retry'))
              }
            },
            500 * 2 ** request.retryCount
          )
        } else {
          request.reject(
            new Error(`Worker ${workerId} exited before completing request`)
          )
        }
      }
    }
  }

  _startScalingCheck() {
    if (this.scaleCheckInterval) return

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
    let totalCost = 0
    const metrics = []

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        activeCount++
        const cost = this._calculateWorkerCost(worker.id)
        totalCost += cost
        metrics.push({ worker, cost })
      }
    }

    const averageCost = activeCount > 0 ? totalCost / activeCount : 0
    const { idleWorkerTimeoutMs, maxPlayersPerWorker, scaleUpThreshold } =
      this.scalingConfig

    if (
      averageCost >= maxPlayersPerWorker * scaleUpThreshold &&
      activeCount < this.maxWorkers
    ) {
      logger(
        'info',
        'Cluster',
        `Scaling up: Average cost ${averageCost.toFixed(2)} reached threshold ${(maxPlayersPerWorker * scaleUpThreshold).toFixed(2)} (${scaleUpThreshold * 100}%). Forking new worker.`
      )
      this.forkWorker()
      return
    }

    if (averageCost < 2 && activeCount > this.minWorkers) {
      const now = Date.now()

      for (const { worker, cost } of metrics) {
        if (cost === 0 && activeCount > this.minWorkers) {
          const idleTime = this.idleWorkers.get(worker.id)

          if (!idleTime) {
            this.idleWorkers.set(worker.id, now)
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
        } else if (cost > 0) {
          this.idleWorkers.delete(worker.id)
        }
      }
    }
  }

  _calculateWorkerCost(workerId) {
    const stats = this.workerStats.get(workerId)
    if (!stats) return 0

    const playingWeight = 1.0
    const pausedWeight = 0.01

    const playingCount = stats.playingPlayers || 0
    const pausedCount = Math.max(0, (stats.players || 0) - playingCount)

    let cost = playingCount * playingWeight + pausedCount * pausedWeight

    if (stats.isHibernating) return cost

    if (stats.cpu?.nodelinkLoad > this.scalingConfig.cpuPenaltyLimit) {
      cost += this.scalingConfig.maxPlayersPerWorker + 5
    }

    if (stats.eventLoopLag > this.scalingConfig.lagPenaltyLimit) {
      cost += this.scalingConfig.maxPlayersPerWorker / 2
    }

    return cost
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

  _startSocketServer() {
    this.server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0)

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])

        while (buffer.length >= 6) {
          const idSize = buffer.readUInt8(0)
          const type = buffer.readUInt8(1)
          const payloadSize = buffer.readUInt32BE(2)
          const totalSize = 6 + idSize + payloadSize

          if (buffer.length < totalSize) break

          const id = buffer.toString('utf8', 6, 6 + idSize)
          const payload = buffer.subarray(6 + idSize, totalSize)
          buffer = buffer.subarray(totalSize)

          if (type === 5) {
            this._handleStreamChunk(id, payload)
            continue
          }
          if (type === 6) {
            this._handleStreamEnd(id)
            continue
          }
          if (type === 7) {
            this._handleStreamError(id, payload.toString('utf8'))
            continue
          }

          try {
            const data = JSON.parse(payload.toString('utf8'))
            if (type === 3) { // playerEvent
              if (global.nodelink) global.nodelink.handleIPCMessage({ type: 'playerEvent', payload: data })
            } else if (type === 4) { // workerStats
              const workerId = data.workerId
              delete data.workerId
              this.statsUpdateBatch.set(workerId, data)
              if (!this.statsUpdateTimer) {
                this.statsUpdateTimer = setTimeout(() => this._flushStatsUpdates(), 100)
              }
            }
          } catch (e) {
            logger('error', 'Cluster', `Socket event parse error: ${e.message}`)
          }
        }
      })
    })

    this.server.on('error', (err) => {
      logger('error', 'Cluster', `Event socket server error: ${err.message}`)
    })

    this.server.listen(this.socketPath, () => {
      logger('info', 'Cluster', `Event socket server listening at ${this.socketPath}`)
    })
  }

  _handleStreamChunk(streamId, payload) {
    const request = this.streamRequests.get(streamId)
    if (!request) return

    if (request.timeout) {
      clearTimeout(request.timeout)
      request.timeout = null
    }

    if (!request.res.headersSent) {
      const headers = request.options?.headers
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          request.res.setHeader(key, value)
        }
      }
      request.res.writeHead(request.options?.statusCode || 200)
    }

    request.res.write(payload)
  }

  _handleStreamEnd(streamId) {
    const request = this.streamRequests.get(streamId)
    if (!request) return
    request.res.end()
    this._cleanupStreamRequest(streamId, false)
  }

  _handleStreamError(streamId, errorMsg) {
    const request = this.streamRequests.get(streamId)
    if (!request) return

    if (!request.res.headersSent) {
      request.res.writeHead(500, { 'Content-Type': 'application/json' })
      request.res.end(JSON.stringify({
        timestamp: Date.now(),
        status: 500,
        error: 'Worker Error',
        message: errorMsg,
        path: request.req.url
      }))
    } else {
      request.res.end()
    }

    this._cleanupStreamRequest(streamId, false)
  }

  _cleanupStreamRequest(streamId, sendCancel) {
    const request = this.streamRequests.get(streamId)
    if (!request || request.cleaned) return
    request.cleaned = true

    if (request.timeout) clearTimeout(request.timeout)
    this.streamRequests.delete(streamId)

    if (sendCancel) {
      const worker = this.workersById.get(request.workerId)
      if (worker?.isConnected()) {
        this._sendStreamCommand(worker, {
          type: 'cancelStream',
          requestId: streamId,
          payload: { streamId }
        })
      }
    }
  }

  _failStreamsForWorker(workerId, reason = 'Worker exited') {
    const streamIds = []
    for (const [streamId, request] of this.streamRequests) {
      if (request.workerId !== workerId) continue
      streamIds.push(streamId)

      if (!request.res.headersSent) {
        request.res.writeHead(500, { 'Content-Type': 'application/json' })
        request.res.end(JSON.stringify({
          timestamp: Date.now(),
          status: 500,
          error: 'Worker Error',
          message: reason,
          path: request.req.url
        }))
      } else {
        request.res.end()
      }
    }

    for (const streamId of streamIds) {
      this._cleanupStreamRequest(streamId, false)
    }
  }

  _sendStreamCommand(worker, msg) {
    if (!worker?.isConnected()) return false
    if (this.workerReady.has(worker.id)) {
      worker.send(msg)
      return true
    }

    let attempts = 0
    const checkReady = setInterval(() => {
      attempts++
      if (!worker.isConnected()) {
        clearInterval(checkReady)
        return
      }
      if (this.workerReady.has(worker.id)) {
        clearInterval(checkReady)
        worker.send(msg)
      } else if (attempts > 50) {
        clearInterval(checkReady)
      }
    }, 100)
    return true
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

    cluster.setupPrimary({ exec: './src/index.js' })
    const worker = cluster.fork({ EVENT_SOCKET_PATH: this.socketPath })
    worker.workerType = 'playback'

    this.workers.push(worker)
    this.workersById.set(worker.id, worker)
    this.workerLoad.set(worker.id, 0)

    this.workerStats.set(worker.id, { players: 0, playingPlayers: 0 })

    this.workerToGuilds.set(worker.id, new Set())
    this.workerHealth.set(worker.id, Date.now())
    this.workerStartTime.set(worker.id, Date.now())
    this.workerUniqueId.set(worker.id, this.nextWorkerId++)
    this.workerFailureHistory.set(worker.id, {
      count: 0,
      lastFailure: null,
      recentFailures: []
    })

    logger(
      'info',
      'Cluster',
      `Spawned worker ${worker.process.pid} (id: ${worker.id})`
    )

    worker.on('message', (msg) => this._handleWorkerMessage(worker, msg))

    worker.on('error', (error) => {
      logger('error', 'Cluster', `Worker ${worker.id} error: ${error.message}`)
    })

    return worker
  }

  removeWorker(workerId) {
    const worker = this.workersById.get(workerId)
    if (!worker) return

    this._failStreamsForWorker(workerId)

    const index = this.workers.indexOf(worker)
    if (index !== -1) this.workers.splice(index, 1)

    this.workersById.delete(workerId)
    this.workerReady.delete(workerId)
    this.workerLoad.delete(workerId)
    this.workerStats.delete(workerId)
    this.idleWorkers.delete(workerId)
    this.workerStartTime.delete(workerId)
    this.workerUniqueId.delete(workerId)

    const affectedGuilds = Array.from(this.workerToGuilds.get(workerId) || [])
    this.workerToGuilds.delete(workerId)

    for (const playerKey of affectedGuilds) {
      this.guildToWorker.delete(playerKey)
      logger(
        'warn',
        'Cluster',
        `Player ${playerKey} unassigned due to worker ${workerId} exit. Will be reassigned on next request.`
      )
    }

    if (affectedGuilds.length > 0) {
      for (const playerKey of affectedGuilds) {
        const [guildId] = playerKey.split(':')
        for (const session of global.nodelink.sessions.values()) {
          const sessionKey = `${guildId}:${session.userId}`
          if (session.players.players.has(sessionKey)) {
            session.players.players.delete(sessionKey)
            logger(
              'debug',
              'Cluster',
              `Removed stale player placeholder for ${playerKey} from session ${session.id}`
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
      this.statsUpdateBatch.set(worker.id, msg.stats)

      if (!this.statsUpdateTimer) {
        this.statsUpdateTimer = setTimeout(() => {
          this._flushStatsUpdates()
        }, 100)
      }
    } else if (msg.type === 'pong') {
      this.workerHealth.set(worker.id, Date.now())
    } else if (msg.type === 'ready') {
      this.workerHealth.set(worker.id, Date.now())
      this.workerReady.add(worker.id)
      logger(
        'info',
        'Cluster',
        `Worker ${worker.id} (PID ${worker.process.pid}) ready`
      )

      if (
        this.liveYoutubeConfig.refreshToken ||
        this.liveYoutubeConfig.visitorData
      ) {
        logger(
          'info',
          'Cluster',
          `Syncing live YouTube config to new worker ${worker.id}`
        )
        this.execute(
          worker,
          'updateYoutubeConfig',
          this.liveYoutubeConfig
        ).catch((err) =>
          logger(
            'error',
            'Cluster',
            `Failed to sync config to worker ${worker.id}: ${err.message}`
          )
        )
      }
    } else if (msg.type === 'ready' && worker.onSourceReady) {
       // This part might be handled by SourceWorkerManager if integrated deeper, 
       // but for now we keep WorkerManager clean of SourceWorker logic.
    } else if (global.nodelink) {
      global.nodelink.handleIPCMessage(msg)
    }
  }

  setLiveYoutubeConfig(config) {
    if (config.refreshToken)
      this.liveYoutubeConfig.refreshToken = config.refreshToken
    if (config.visitorData)
      this.liveYoutubeConfig.visitorData = config.visitorData
  }

  _flushStatsUpdates() {
    for (const [workerId, stats] of this.statsUpdateBatch) {
      this.workerLoad.set(workerId, stats.players)
      this.workerStats.set(workerId, stats)

      if (stats.players === 0 && !this.idleWorkers.has(workerId)) {
        this.idleWorkers.set(workerId, Date.now())
      } else if (stats.players > 0) {
        this.idleWorkers.delete(workerId)
      }
    }

    this.statsUpdateBatch.clear()
    this.statsUpdateTimer = null
  }

  getWorkerForGuild(playerKey) {
    if (this.guildToWorker.has(playerKey)) {
      const workerId = this.guildToWorker.get(playerKey)
      const worker = this.workersById.get(workerId)

      if (worker?.isConnected()) return worker

      this.guildToWorker.delete(playerKey)
      this.workerToGuilds.get(workerId)?.delete(playerKey)
    }

    if (this.workers.length === 0 && this.maxWorkers > 0) {
      const worker = this.forkWorker()
      if (!worker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
      this.assignGuildToWorker(playerKey, worker)
      return worker
    }

    let bestWorker = null
    let minCost = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      if (worker.isConnected()) {
        const cost = this._calculateWorkerCost(worker.id)
        if (cost < minCost) {
          minCost = cost
          bestWorker = worker
        }
      }
    }

    const threshold = this.scalingConfig.maxPlayersPerWorker

    if (minCost >= threshold && this.workers.length < this.maxWorkers) {
      logger(
        'debug',
        'Cluster',
        `Best worker is saturated (Cost: ${minCost.toFixed(2)}). Forking new worker.`
      )
      const newWorker = this.forkWorker()
      if (newWorker) {
        this.assignGuildToWorker(playerKey, newWorker)
        return newWorker
      }
    }

    if (!bestWorker) {
      bestWorker = this.forkWorker()
      if (!bestWorker) {
        throw new Error('No workers available and cannot fork new ones.')
      }
    }

    // Warning logs if system is squeezed
    if (minCost >= threshold) {
      if (this.workers.length >= this.maxWorkers) {
        logger(
          'warn',
          'Cluster',
          '\x1b[31m! THIS SERVER IS OPERATING AT CRITICAL CAPACITY !\x1b[0m'
        )
        logger(
          'warn',
          'Cluster',
          '\x1b[31mIt is EXTREMELY RECOMMENDED that you scale your instance.\x1b[0m'
        )
        logger(
          'warn',
          'Cluster',
          '\x1b[31mIf this client serves a large volume of users or multiple bots, it is time to implement a server mesh for better performance.\x1b[0m'
        )
      } else {
        logger(
          'warn',
          'Cluster',
          `Worker #${bestWorker.id} is operating under heavy load (squeezed) :p`
        )
      }
    }

    this.assignGuildToWorker(playerKey, bestWorker)
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

  assignGuildToWorker(playerKey, worker) {
    this.guildToWorker.set(playerKey, worker.id)

    if (!this.workerToGuilds.has(worker.id)) {
      this.workerToGuilds.set(worker.id, new Set())
    }
    this.workerToGuilds.get(worker.id).add(playerKey)

    logger(
      'debug',
      'Cluster',
      `Assigned player ${playerKey} to worker ${worker.id}`
    )
  }

  unassignGuild(playerKey) {
    const workerId = this.guildToWorker.get(playerKey)
    this.guildToWorker.delete(playerKey)

    if (workerId && this.workerToGuilds.has(workerId)) {
      this.workerToGuilds.get(workerId).delete(playerKey)
    }
  }

  isGuildAssigned(playerKey) {
    return this.guildToWorker.has(playerKey)
  }

  _ensureWorkerAvailability() {
    const neededWorkers = Math.max(this.minWorkers - this.workers.length, 0)

    for (
      let i = 0;
      i < neededWorkers && this.workers.length < this.maxWorkers;
      i++
    ) {
      logger(
        'info',
        'Cluster',
        `Forking worker ${this.workers.length + 1}/${this.minWorkers}`
      )
      this.forkWorker()
    }
  }

  getWorkerMetrics() {
    const workerMetrics = {}
    const now = Date.now()

    for (const worker of this.workers) {
      if (!worker.isConnected()) continue

      const workerId = worker.id
      const uniqueId = this.workerUniqueId.get(workerId) || workerId
      const pid = worker.process.pid
      const stats = this.workerStats.get(workerId) || {}
      const lastHealthCheck = this.workerHealth.get(workerId) || 0
      const startTime = this.workerStartTime.get(workerId) || now
      const uptimeSeconds = Math.floor((now - startTime) / 1000)
      const isHealthy = now - lastHealthCheck < 30000

      workerMetrics[uniqueId] = {
        clusterId: workerId,
        pid,
        stats,
        health: isHealthy,
        uptime: uptimeSeconds
      }
    }

    return workerMetrics
  }

  destroy() {
    this.isDestroying = true
    this._stopScalingCheck()
    this._stopHealthCheck()

    if (this.statsUpdateTimer) {
      clearTimeout(this.statsUpdateTimer)
      this._flushStatsUpdates()
    }

    this.pendingRequests.clear()
    this.workerFailureHistory.clear()
    this.statsUpdateBatch.clear()
    this.workerHealth.clear()
    this.workerStartTime.clear()
    this.workerUniqueId.clear()
    this.idleWorkers.clear()

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

    const streamIds = []
    for (const [streamId, request] of this.streamRequests) {
      streamIds.push(streamId)
      if (!request.res.headersSent) {
        request.res.writeHead(503, { 'Content-Type': 'application/json' })
        request.res.end(JSON.stringify({
          timestamp: Date.now(),
          status: 503,
          error: 'Service Unavailable',
          message: 'Server shutting down.',
          path: request.req.url
        }))
      } else {
        request.res.end()
      }
    }

    for (const streamId of streamIds) {
      this._cleanupStreamRequest(streamId, false)
    }

    logger(
      'info',
      'Cluster',
      'WorkerManager destroyed. All workers terminated.'
    )
  }

  delegateStream(req, res, payload, options = {}) {
    const worker = this.getBestWorker()
    if (!worker) return false

    const streamId = crypto.randomBytes(16).toString('hex')
    const request = {
      id: streamId,
      req,
      res,
      workerId: worker.id,
      options,
      timeout: null,
      cleaned: false
    }

    request.timeout = setTimeout(() => {
      const activeRequest = this.streamRequests.get(streamId)
      if (activeRequest) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Gateway Timeout', message: 'Stream worker timed out' }))
        this._cleanupStreamRequest(streamId, true)
      }
    }, 60000)

    this.streamRequests.set(streamId, request)

    res.on('close', () => {
      this._cleanupStreamRequest(streamId, true)
    })

    this._sendStreamCommand(worker, {
      type: 'loadStream',
      requestId: streamId,
      payload: {
        ...payload,
        streamId
      }
    })

    return true
  }

  execute(worker, type, payload, options = {}) {
    return new Promise((resolve, reject) => {
      this._executeCommand(
        worker,
        type,
        payload,
        resolve,
        reject,
        0,
        options.fast || false
      )
    })
  }

  _executeCommand(worker, type, payload, resolve, reject, retryCount, isFast) {
    const requestId = crypto.randomBytes(16).toString('hex')
    const timeoutMs = isFast ? this.fastCommandTimeout : this.commandTimeout
    const startTime = Date.now()

    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId)

      if (global.nodelink?.statsManager) {
        global.nodelink.statsManager.incrementCommandTimeout(type)
      }

      if (retryCount < this.maxRetries && worker.isConnected()) {
        logger(
          'warn',
          'Cluster',
          `Command timeout (${timeoutMs}ms) for command '${type}' with payload:`,
          payload,
          `, retrying... (${retryCount + 1}/${this.maxRetries})`
        )

        if (global.nodelink?.statsManager) {
          global.nodelink.statsManager.incrementCommandRetry(type)
        }

        setTimeout(() => {
          const newWorker = this.getBestWorker() || worker
          this._executeCommand(
            newWorker,
            type,
            payload,
            resolve,
            reject,
            retryCount + 1,
            isFast
          )
        }, 500)
      } else {
        reject(
          new Error(`Worker command timeout after ${retryCount + 1} attempts`)
        )
      }
    }, timeoutMs)

    this.pendingRequests.set(requestId, {
      resolve: (result) => {
        const duration = Date.now() - startTime
        if (global.nodelink?.statsManager) {
          global.nodelink.statsManager.recordCommandExecutionTime(
            type,
            worker.id,
            duration
          )
        }
        resolve(result)
      },
      reject,
      timeout,
      workerId: worker.id,
      type,
      payload,
      retryCount,
      isFast,
      startTime
    })

    try {
      if (!worker.isConnected()) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)

        if (retryCount < this.maxRetries) {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(
              newWorker,
              type,
              payload,
              resolve,
              reject,
              retryCount + 1,
              isFast
            )
          } else {
            reject(new Error('No workers available for retry'))
          }
        } else {
          reject(new Error('Worker disconnected and max retries reached'))
        }
        return
      }

      if (!this.workerReady.has(worker.id)) {
        logger(
          'debug',
          'Cluster',
          `Waiting for worker ${worker.id} to be ready before sending ${type}`
        )
        let attempts = 0
        const checkReady = setInterval(() => {
          attempts++
          if (this.workerReady.has(worker.id) || !worker.isConnected()) {
            clearInterval(checkReady)
            if (worker.isConnected()) {
              worker.send({ type, requestId, payload })
            }
          } else if (attempts > 50) {
            clearInterval(checkReady)
          }
        }, 100)
        return
      }

      worker.send({ type, requestId, payload })
    } catch (error) {
      clearTimeout(timeout)
      this.pendingRequests.delete(requestId)

      if (retryCount < this.maxRetries) {
        logger('error', 'Cluster', `Send error: ${error.message}, retrying...`)
        if (global.nodelink?.statsManager) {
          global.nodelink.statsManager.incrementCommandRetry(type)
        }
        setTimeout(() => {
          const newWorker = this.getBestWorker()
          if (newWorker) {
            this._executeCommand(
              newWorker,
              type,
              payload,
              resolve,
              reject,
              retryCount + 1,
              isFast
            )
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
