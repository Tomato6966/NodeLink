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

  updateStatsMetrics(statsData) {
    if (!this.promPlayers) return // Metrics not enabled

    try {
      const stats = statsData
      // Update player metrics
      this.promPlayers.set(stats.players || 0)
      this.promPlayingPlayers.set(stats.playingPlayers || 0)

      // Update uptime
      this.promUptime.set(stats.uptime || 0)

      // Update memory metrics
      if (stats.memory) {
        this.promMemoryFree.set(stats.memory.free || 0)
        this.promMemoryUsed.set(stats.memory.used || 0)
        this.promMemoryAllocated.set(stats.memory.allocated || 0)
        this.promMemoryReservable.set(stats.memory.reservable || 0)
      }

      // Update CPU metrics
      if (stats.cpu) {
        this.promCpuCores.set(stats.cpu.cores || 0)
        this.promCpuSystemLoad.set(stats.cpu.systemLoad || 0)
        this.promCpuNodelinkLoad.set(stats.cpu.nodelinkLoad || 0)
      }

      // Update frame statistics
      if (stats.frameStats) {
        this.promFramesSent.set(stats.frameStats.sent || 0)
        this.promFramesNulled.set(stats.frameStats.nulled || 0)
        this.promFramesDeficit.set(stats.frameStats.deficit || 0)
        this.promFramesExpected.set(stats.frameStats.expected || 0)
      } else {
        // Reset to 0 if no frame stats available
        this.promFramesSent.set(0)
        this.promFramesNulled.set(0)
        this.promFramesDeficit.set(0)
        this.promFramesExpected.set(0)
      }
    } catch (error) {
      logger(
        'error',
        'StatsManager',
        `Failed to update stats metrics: ${error.message}`
      )
    }
  }
}
