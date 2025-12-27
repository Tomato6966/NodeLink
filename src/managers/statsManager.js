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

      this.promWorkerEventLoopLag = new Gauge({
        name: 'nodelink_worker_event_loop_lag_ms',
        help: 'Worker event loop lag in milliseconds',
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

      this.promTotalWorkers = new Gauge({
        name: 'nodelink_total_workers',
        help: 'Total number of active workers',
        registers: [this.promRegister]
      })

      this.promWorkerRestarts = new Counter({
        name: 'nodelink_worker_restarts_total',
        help: 'Total number of worker restarts',
        labelNames: ['worker_id'],
        registers: [this.promRegister]
      })

      this.promWorkerFailures = new Counter({
        name: 'nodelink_worker_failures_total',
        help: 'Total number of worker failures',
        labelNames: ['worker_id', 'exit_code'],
        registers: [this.promRegister]
      })

      this.promCommandQueueSize = new Gauge({
        name: 'nodelink_command_queue_size',
        help: 'Total size of command queue across all workers',
        registers: [this.promRegister]
      })

      this.promCommandExecutionTime = new Gauge({
        name: 'nodelink_command_execution_time_ms',
        help: 'Command execution time in milliseconds',
        labelNames: ['command_type', 'worker_id'],
        registers: [this.promRegister]
      })

      this.promCommandTimeouts = new Counter({
        name: 'nodelink_command_timeouts_total',
        help: 'Total number of command timeouts',
        labelNames: ['command_type'],
        registers: [this.promRegister]
      })

      this.promCommandRetries = new Counter({
        name: 'nodelink_command_retries_total',
        help: 'Total number of command retries',
        labelNames: ['command_type'],
        registers: [this.promRegister]
      })

      this.promPlayerRestorations = new Counter({
        name: 'nodelink_player_restorations_total',
        help: 'Total number of player restorations',
        labelNames: ['worker_id'],
        registers: [this.promRegister]
      })

      this.promPlayerDestructions = new Counter({
        name: 'nodelink_player_destructions_total',
        help: 'Total number of player destructions',
        labelNames: ['session_id', 'reason'],
        registers: [this.promRegister]
      })

      this.promTrackLoads = new Counter({
        name: 'nodelink_track_loads_total',
        help: 'Total number of track loads',
        labelNames: ['source', 'status'],
        registers: [this.promRegister]
      })

      this.promTrackLoadDuration = new Gauge({
        name: 'nodelink_track_load_duration_ms',
        help: 'Track load duration in milliseconds',
        labelNames: ['source'],
        registers: [this.promRegister]
      })

      this.promStreamErrors = new Counter({
        name: 'nodelink_stream_errors_total',
        help: 'Total number of stream errors',
        labelNames: ['error_type', 'source'],
        registers: [this.promRegister]
      })

      this.promPlayerStuck = new Counter({
        name: 'nodelink_player_stuck_total',
        help: 'Total number of stuck players',
        labelNames: ['guild_id', 'reason'],
        registers: [this.promRegister]
      })

      this.promVoiceConnections = new Gauge({
        name: 'nodelink_voice_connections',
        help: 'Number of active voice connections',
        registers: [this.promRegister]
      })

      this.promVoiceConnectionErrors = new Counter({
        name: 'nodelink_voice_connection_errors_total',
        help: 'Total number of voice connection errors',
        labelNames: ['error_type'],
        registers: [this.promRegister]
      })

      this.promWebsocketConnections = new Gauge({
        name: 'nodelink_websocket_connections',
        help: 'Number of active WebSocket connections',
        registers: [this.promRegister]
      })

      this.promWebsocketMessages = new Counter({
        name: 'nodelink_websocket_messages_total',
        help: 'Total number of WebSocket messages',
        labelNames: ['direction', 'op_type'],
        registers: [this.promRegister]
      })

      this.promSessionResumes = new Counter({
        name: 'nodelink_session_resumes_total',
        help: 'Total number of session resumes',
        labelNames: ['client_name', 'success'],
        registers: [this.promRegister]
      })

      this.promRoutePlannerIps = new Gauge({
        name: 'nodelink_route_planner_ips',
        help: 'Number of available IPs in route planner',
        registers: [this.promRegister]
      })

      this.promRoutePlannerBannedIps = new Gauge({
        name: 'nodelink_route_planner_banned_ips',
        help: 'Number of banned IPs in route planner',
        registers: [this.promRegister]
      })

      this.promLyricsRequests = new Counter({
        name: 'nodelink_lyrics_requests_total',
        help: 'Total number of lyrics requests',
        labelNames: ['provider', 'status'],
        registers: [this.promRegister]
      })

      this.promFilterUsage = new Counter({
        name: 'nodelink_filter_usage_total',
        help: 'Total number of filter usage',
        labelNames: ['filter_type'],
        registers: [this.promRegister]
      })

      this.promHttpRequestDuration = new Gauge({
        name: 'nodelink_http_request_duration_ms',
        help: 'HTTP request duration in milliseconds',
        labelNames: ['endpoint', 'method', 'status_code'],
        registers: [this.promRegister]
      })

      this.promRateLimitHits = new Counter({
        name: 'nodelink_rate_limit_hits_total',
        help: 'Total number of rate limit hits',
        labelNames: ['endpoint', 'ip'],
        registers: [this.promRegister]
      })

      this.promDosProtectionBlocks = new Counter({
        name: 'nodelink_dos_protection_blocks_total',
        help: 'Total number of DoS protection blocks',
        labelNames: ['ip', 'reason'],
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

  _sanitizeEndpoint(endpoint) {
    return endpoint
      .replace(/\/sessions\/[A-Za-z0-9]+/g, '/sessions/:sessionId')
      .replace(/\/players\/[0-9]+/g, '/players/:guildId')
      .replace(/\/tracks\/[A-Za-z0-9_-]+/g, '/tracks/:identifier')
  }

  incrementApiRequest(endpoint) {
    const sanitized = this._sanitizeEndpoint(endpoint)
    
    if (Object.keys(this.stats.api.requests).length > 500 && !this.stats.api.requests[sanitized]) {
      this.stats.api.requests['others'] = (this.stats.api.requests['others'] || 0) + 1
    } else {
      this.stats.api.requests[sanitized] = (this.stats.api.requests[sanitized] || 0) + 1
    }

    if (this.promApiRequests) {
      this.promApiRequests.inc({ endpoint: sanitized })
    }
  }

  incrementApiError(endpoint) {
    const sanitized = this._sanitizeEndpoint(endpoint)
    
    if (Object.keys(this.stats.api.errors).length > 500 && !this.stats.api.errors[sanitized]) {
      this.stats.api.errors['others'] = (this.stats.api.errors['others'] || 0) + 1
    } else {
      this.stats.api.errors[sanitized] = (this.stats.api.errors[sanitized] || 0) + 1
    }

    if (this.promApiErrors) {
      this.promApiErrors.inc({ endpoint: sanitized })
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
      const totalQueueSize = Object.values(workerMetrics).reduce(
        (sum, w) => sum + (w.stats.commandQueueLength || 0),
        0
      )

      if (this.promCommandQueueSize) {
        this.promCommandQueueSize.set(totalQueueSize)
      }

      if (this.promTotalWorkers) {
        this.promTotalWorkers.set(Object.keys(workerMetrics).length)
      }

      for (const [uniqueWorkerId, workerData] of Object.entries(workerMetrics)) {
        const { pid, stats, health, uptime } = workerData
        const labels = { worker_id: String(uniqueWorkerId), worker_pid: String(pid) }

        this.promWorkerPlayers.set(labels, stats.players || 0)
        this.promWorkerPlayingPlayers.set(labels, stats.playingPlayers || 0)

        if (stats.memory) {
          this.promWorkerMemoryUsed.set(labels, stats.memory.used || 0)
          this.promWorkerMemoryAllocated.set(labels, stats.memory.allocated || 0)
        }

        if (stats.cpu) {
          this.promWorkerCpuLoad.set(labels, stats.cpu.nodelinkLoad || 0)
        }

        if (stats.eventLoopLag !== undefined && this.promWorkerEventLoopLag) {
          this.promWorkerEventLoopLag.set(labels, stats.eventLoopLag || 0)
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

  incrementWorkerRestart(workerId) {
    if (this.promWorkerRestarts && workerId) {
      this.promWorkerRestarts.inc({ worker_id: String(workerId) })
    }
  }

  incrementWorkerFailure(workerId, exitCode) {
    if (this.promWorkerFailures && workerId) {
      this.promWorkerFailures.inc({
        worker_id: String(workerId),
        exit_code: String(exitCode || 'unknown')
      })
    }
  }

  recordCommandExecutionTime(commandType, workerId, durationMs) {
    if (this.promCommandExecutionTime && commandType && workerId && typeof durationMs === 'number') {
      this.promCommandExecutionTime.set(
        { command_type: commandType, worker_id: String(workerId) },
        durationMs
      )
    }
  }

  incrementCommandTimeout(commandType) {
    if (this.promCommandTimeouts && commandType) {
      this.promCommandTimeouts.inc({ command_type: commandType })
    }
  }

  incrementCommandRetry(commandType) {
    if (this.promCommandRetries && commandType) {
      this.promCommandRetries.inc({ command_type: commandType })
    }
  }

  incrementPlayerRestoration(workerId) {
    if (this.promPlayerRestorations && workerId) {
      this.promPlayerRestorations.inc({ worker_id: String(workerId) })
    }
  }

  incrementPlayerDestruction(sessionId, reason) {
    if (this.promPlayerDestructions && sessionId) {
      const sanitizedSessionId = 'session_' + sessionId.substring(0, 4) + '...'
      this.promPlayerDestructions.inc({
        session_id: sanitizedSessionId,
        reason: reason || 'unknown'
      })
    }
  }

  incrementTrackLoad(source, status) {
    if (this.promTrackLoads && source && status) {
      this.promTrackLoads.inc({ source, status })
    }
  }

  recordTrackLoadDuration(source, durationMs) {
    if (this.promTrackLoadDuration && source && typeof durationMs === 'number') {
      this.promTrackLoadDuration.set({ source }, durationMs)
    }
  }

  incrementStreamError(errorType, source) {
    if (this.promStreamErrors && errorType && source) {
      this.promStreamErrors.inc({ error_type: errorType, source })
    }
  }

  incrementPlayerStuck(guildId, reason) {
    if (this.promPlayerStuck && guildId && reason) {
      const sanitizedGuildId = 'guild_' + guildId.substring(0, 4) + '...'
      this.promPlayerStuck.inc({ guild_id: sanitizedGuildId, reason })
    }
  }

  setVoiceConnections(count) {
    if (this.promVoiceConnections && typeof count === 'number') {
      this.promVoiceConnections.set(count)
    }
  }

  incrementVoiceConnectionError(errorType) {
    if (this.promVoiceConnectionErrors && errorType) {
      this.promVoiceConnectionErrors.inc({ error_type: errorType })
    }
  }

  setWebsocketConnections(count) {
    if (this.promWebsocketConnections && typeof count === 'number') {
      this.promWebsocketConnections.set(count)
    }
  }

  incrementWebsocketMessage(direction, opType) {
    if (this.promWebsocketMessages && direction && opType) {
      this.promWebsocketMessages.inc({ direction, op_type: opType })
    }
  }

  incrementSessionResume(clientName, success) {
    if (this.promSessionResumes && clientName) {
      this.promSessionResumes.inc({
        client_name: clientName,
        success: success ? 'true' : 'false'
      })
    }
  }

  setRoutePlannerIps(available, banned) {
    if (this.promRoutePlannerIps && typeof available === 'number') {
      this.promRoutePlannerIps.set(available)
    }
    if (this.promRoutePlannerBannedIps && typeof banned === 'number') {
      this.promRoutePlannerBannedIps.set(banned)
    }
  }

  incrementLyricsRequest(provider, status) {
    if (this.promLyricsRequests && provider && status) {
      this.promLyricsRequests.inc({ provider, status })
    }
  }

  incrementFilterUsage(filterType) {
    if (this.promFilterUsage && filterType) {
      this.promFilterUsage.inc({ filter_type: filterType })
    }
  }

  recordHttpRequestDuration(endpoint, method, statusCode, durationMs) {
    if (this.promHttpRequestDuration && endpoint && method && statusCode && typeof durationMs === 'number') {
      const sanitized = this._sanitizeEndpoint(endpoint)
      this.promHttpRequestDuration.set(
        { endpoint: sanitized, method, status_code: String(statusCode) },
        durationMs
      )
    }
  }

  incrementRateLimitHit(endpoint, ip) {
    if (this.promRateLimitHits && endpoint && ip) {
      const sanitized = this._sanitizeEndpoint(endpoint)
      const sanitizedIp = ip.includes(':') ? '[IPv6]' : ip.split('.').slice(0, 2).join('.') + '.xxx.xxx'
      this.promRateLimitHits.inc({ endpoint: sanitized, ip: sanitizedIp })
    }
  }

  incrementDosProtectionBlock(ip, reason) {
    if (this.promDosProtectionBlocks && ip && reason) {
      const sanitizedIp = ip.includes(':') ? '[IPv6]' : ip.split('.').slice(0, 2).join('.') + '.xxx.xxx'
      this.promDosProtectionBlocks.inc({ ip: sanitizedIp, reason })
    }
  }
}
