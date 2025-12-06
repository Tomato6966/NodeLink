import { logger } from '../utils.js'

export default class StatsManager {
  /**
   *
   * @param {import('../index').NodelinkServer} nodelink
   */
  constructor(nodelink) {
    this.nodelink = nodelink
    this.stats = {
      api: {
        requests: {}, // { '/v4/loadtracks': 10, ... }
        errors: {}
      },
      sources: {}, // { youtube: { success: 10, failure: 1 }, ... }
      playback: {
        events: {} // { TrackStartEvent: 10, ... }
      }
    }
      
    logger('info', 'StatsManager', 'Initialized.')
  }

  async initialize() {
    // Initialize Prometheus metrics only if enabled
    const metricsEnabled = this.nodelink.options.metrics?.enabled ?? false

    if (metricsEnabled) {
      let promClient
      try {
        promClient = await import('prom-client')
      } catch (e) {
        logger(
          'error',
          'StatsManager',
          "Metrics are enabled in config but 'prom-client' is not installed."
        )
        logger(
          'error',
          'StatsManager',
          "Please install it using 'npm install prom-client' or disable metrics in config."
        )
        throw new Error("Optional dependency 'prom-client' is missing.")
      }

      const { collectDefaultMetrics, Registry, Counter, Gauge } = promClient

      this.promRegister = new Registry()
      this.promCollectedStats = collectDefaultMetrics({
        register: this.promRegister
      })

      // API Request Counter - tracks total API requests by endpoint
      this.promApiRequests = new Counter({
        name: 'nodelink_api_requests_total',
        help: 'Total number of API requests',
        labelNames: ['endpoint'],
        registers: [this.promRegister]
      })

      // API Error Counter - tracks total API errors by endpoint
      this.promApiErrors = new Counter({
        name: 'nodelink_api_errors_total',
        help: 'Total number of API errors',
        labelNames: ['endpoint'],
        registers: [this.promRegister]
      })

      // Source Request Counter - tracks source requests by source and status
      this.promSourceRequests = new Counter({
        name: 'nodelink_source_requests_total',
        help: 'Total number of source requests',
        labelNames: ['source', 'status'],
        registers: [this.promRegister]
      })

      // Playback Event Counter - tracks playback events by event type
      this.promPlaybackEvents = new Counter({
        name: 'nodelink_playback_events_total',
        help: 'Total number of playback events',
        labelNames: ['event_type'],
        registers: [this.promRegister]
      })

      // Player Gauges - current player statistics
      this.promPlayers = new Gauge({
        name: 'nodelink_players',
        help: 'Total number of players',
        registers: [this.promRegister]
      })

      this.promPlayingPlayers = new Gauge({
        name: 'nodelink_playing_players',
        help: 'Number of currently playing players',
        registers: [this.promRegister]
      })

      // Uptime Gauge - server uptime in milliseconds
      this.promUptime = new Gauge({
        name: 'nodelink_uptime_ms',
        help: 'Server uptime in milliseconds',
        registers: [this.promRegister]
      })

      // Memory Gauges - memory statistics in bytes
      this.promMemoryFree = new Gauge({
        name: 'nodelink_memory_free_bytes',
        help: 'Free system memory in bytes',
        registers: [this.promRegister]
      })

      this.promMemoryUsed = new Gauge({
        name: 'nodelink_memory_used_bytes',
        help: 'Used memory in bytes',
        registers: [this.promRegister]
      })

      this.promMemoryAllocated = new Gauge({
        name: 'nodelink_memory_allocated_bytes',
        help: 'Allocated memory in bytes',
        registers: [this.promRegister]
      })

      this.promMemoryReservable = new Gauge({
        name: 'nodelink_memory_reservable_bytes',
        help: 'Reservable memory in bytes',
        registers: [this.promRegister]
      })

      // CPU Gauges - CPU statistics
      this.promCpuCores = new Gauge({
        name: 'nodelink_cpu_cores',
        help: 'Number of CPU cores',
        registers: [this.promRegister]
      })

      this.promCpuSystemLoad = new Gauge({
        name: 'nodelink_cpu_system_load',
        help: 'System CPU load average',
        registers: [this.promRegister]
      })

      this.promCpuNodelinkLoad = new Gauge({
        name: 'nodelink_cpu_nodelink_load',
        help: 'NodeLink CPU load',
        registers: [this.promRegister]
      })

      // Frame Statistics Gauges - audio frame statistics
      this.promFramesSent = new Gauge({
        name: 'nodelink_frames_sent',
        help: 'Total number of audio frames sent',
        registers: [this.promRegister]
      })

      this.promFramesNulled = new Gauge({
        name: 'nodelink_frames_nulled',
        help: 'Total number of nulled audio frames',
        registers: [this.promRegister]
      })

      this.promFramesDeficit = new Gauge({
        name: 'nodelink_frames_deficit',
        help: 'Audio frame deficit',
        registers: [this.promRegister]
      })

      this.promFramesExpected = new Gauge({
        name: 'nodelink_frames_expected',
        help: 'Total number of expected audio frames',
        registers: [this.promRegister]
      })

      this.promWorkerPlayers = new Gauge({
        name: 'nodelink_worker_players',
        help: 'Number of players per worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerPlayingPlayers = new Gauge({
        name: 'nodelink_worker_playing_players',
        help: 'Number of playing players per worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerMemoryUsed = new Gauge({
        name: 'nodelink_worker_memory_used_bytes',
        help: 'Worker memory used in bytes',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerMemoryAllocated = new Gauge({
        name: 'nodelink_worker_memory_allocated_bytes',
        help: 'Worker memory allocated in bytes',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerCpuLoad = new Gauge({
        name: 'nodelink_worker_cpu_load',
        help: 'Worker CPU load',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerCommandQueueLength = new Gauge({
        name: 'nodelink_worker_command_queue_length',
        help: 'Worker command queue length',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerFramesSent = new Gauge({
        name: 'nodelink_worker_frames_sent',
        help: 'Audio frames sent by worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerFramesNulled = new Gauge({
        name: 'nodelink_worker_frames_nulled',
        help: 'Audio frames nulled by worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerFramesDeficit = new Gauge({
        name: 'nodelink_worker_frames_deficit',
        help: 'Audio frame deficit by worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerFramesExpected = new Gauge({
        name: 'nodelink_worker_frames_expected',
        help: 'Audio frames expected by worker',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerUptime = new Gauge({
        name: 'nodelink_worker_uptime_seconds',
        help: 'Worker uptime in seconds',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      this.promWorkerHealth = new Gauge({
        name: 'nodelink_worker_health',
        help: 'Worker health status (1 = healthy, 0 = unhealthy)',
        labelNames: ['worker_id', 'worker_pid'],
        registers: [this.promRegister]
      })

      logger('info', 'StatsManager', 'Prometheus metrics initialized.')
    }
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.stats))
  }

  _initSource(source) {
    if (!this.stats.sources[source]) {
      this.stats.sources[source] = { success: 0, failure: 0 }
    }
  }

  incrementApiRequest(endpoint) {
    this.stats.api.requests[endpoint] =
      (this.stats.api.requests[endpoint] || 0) + 1
    if (this.promApiRequests) {
      this.promApiRequests.inc({ endpoint })
    }
  }

  incrementApiError(endpoint) {
    this.stats.api.errors[endpoint] = (this.stats.api.errors[endpoint] || 0) + 1
    if (this.promApiErrors) {
      this.promApiErrors.inc({ endpoint })
    }
  }

  incrementSourceSuccess(source) {
    this._initSource(source)
    this.stats.sources[source].success++
    if (this.promSourceRequests) {
      this.promSourceRequests.inc({ source, status: 'success' })
    }
  }

  incrementSourceFailure(source) {
    this._initSource(source)
    this.stats.sources[source].failure++
    if (this.promSourceRequests) {
      this.promSourceRequests.inc({ source, status: 'failure' })
    }
  }

  incrementPlaybackEvent(eventType) {
    this.stats.playback.events[eventType] =
      (this.stats.playback.events[eventType] || 0) + 1
    if (this.promPlaybackEvents) {
      this.promPlaybackEvents.inc({ event_type: eventType })
    }
  }

  updateStatsMetrics(statsData, workerMetrics = null) {
    if (!this.promPlayers) return

    try {
      const stats = statsData
      this.promPlayers.set(stats.players || 0)
      this.promPlayingPlayers.set(stats.playingPlayers || 0)

      this.promUptime.set(stats.uptime || 0)

      if (stats.memory) {
        this.promMemoryFree.set(stats.memory.free || 0)
        this.promMemoryUsed.set(stats.memory.used || 0)
        this.promMemoryAllocated.set(stats.memory.allocated || 0)
        this.promMemoryReservable.set(stats.memory.reservable || 0)
      }

      if (stats.cpu) {
        this.promCpuCores.set(stats.cpu.cores || 0)
        this.promCpuSystemLoad.set(stats.cpu.systemLoad || 0)
        this.promCpuNodelinkLoad.set(stats.cpu.nodelinkLoad || 0)
      }

      if (stats.frameStats) {
        this.promFramesSent.set(stats.frameStats.sent || 0)
        this.promFramesNulled.set(stats.frameStats.nulled || 0)
        this.promFramesDeficit.set(stats.frameStats.deficit || 0)
        this.promFramesExpected.set(stats.frameStats.expected || 0)
      } else {
        this.promFramesSent.set(0)
        this.promFramesNulled.set(0)
        this.promFramesDeficit.set(0)
        this.promFramesExpected.set(0)
      }

      if (workerMetrics && this.promWorkerPlayers) {
        this._updateWorkerMetrics(workerMetrics)
      }
    } catch (error) {
      logger(
        'error',
        'StatsManager',
        `Failed to update stats metrics: ${error.message}`
      )
    }
  }

  _updateWorkerMetrics(workerMetrics) {
    if (!this.promWorkerPlayers) return

    try {
      for (const [workerId, workerData] of Object.entries(workerMetrics)) {
        const { pid, stats, health, uptime } = workerData
        const labels = { worker_id: String(workerId), worker_pid: String(pid) }

        this.promWorkerPlayers.set(labels, stats.players || 0)
        this.promWorkerPlayingPlayers.set(labels, stats.playingPlayers || 0)

        if (stats.memory) {
          this.promWorkerMemoryUsed.set(labels, stats.memory.used || 0)
          this.promWorkerMemoryAllocated.set(labels, stats.memory.allocated || 0)
        }

        if (stats.cpu) {
          this.promWorkerCpuLoad.set(labels, stats.cpu.nodelinkLoad || 0)
        }

        if (stats.commandQueueLength !== undefined) {
          this.promWorkerCommandQueueLength.set(labels, stats.commandQueueLength || 0)
        }

        if (stats.frameStats) {
          this.promWorkerFramesSent.set(labels, stats.frameStats.sent || 0)
          this.promWorkerFramesNulled.set(labels, stats.frameStats.nulled || 0)
          this.promWorkerFramesDeficit.set(labels, stats.frameStats.deficit || 0)
          this.promWorkerFramesExpected.set(labels, stats.frameStats.expected || 0)
        }

        if (uptime !== undefined) {
          this.promWorkerUptime.set(labels, uptime)
        }

        if (health !== undefined) {
          this.promWorkerHealth.set(labels, health ? 1 : 0)
        }
      }
    } catch (error) {
      logger(
        'error',
        'StatsManager',
        `Failed to update worker metrics: ${error.message}`
      )
    }
  }
}
