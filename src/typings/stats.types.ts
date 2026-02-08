/**
 * Counters keyed by endpoint with an optional overflow bucket.
 * @public
 */
export interface EndpointCounters {
  [key: string]: number | undefined

  /**
   * Overflow bucket when endpoint cardinality is capped.
   */
  others?: number
}

/**
 * API request and error counters grouped by endpoint.
 * @public
 */
export interface ApiStatsCounters {
  /**
   * Request totals per endpoint.
   */
  requests: EndpointCounters

  /**
   * Error totals per endpoint.
   */
  errors: EndpointCounters
}

/**
 * Per-source success/failure counters.
 * @public
 */
export interface SourceStatsEntry {
  /**
   * Successful requests for the source.
   */
  success: number

  /**
   * Failed requests for the source.
   */
  failure: number
}

/**
 * Playback event counters by event type.
 * @public
 */
export interface PlaybackStats {
  /**
   * Playback events keyed by event type.
   */
  events: Record<string, number>
}

/**
 * Snapshot of in-memory stats counters.
 * @public
 */
export interface StatsSnapshot {
  /**
   * API request/error counters.
   */
  api: ApiStatsCounters

  /**
   * Per-source success/failure counters.
   */
  sources: Record<string, SourceStatsEntry>

  /**
   * Playback event counters.
   */
  playback: PlaybackStats
}

/**
 * Memory statistics for a NodeLink instance.
 * @public
 */
export interface MemoryStats {
  /** Free system memory in bytes. */
  free?: number
  /** Used memory in bytes. */
  used?: number
  /** Allocated heap memory in bytes. */
  allocated?: number
  /** Total reservable system memory in bytes. */
  reservable?: number
}

/**
 * CPU statistics for a NodeLink instance.
 * @public
 */
export interface CpuStats {
  /** CPU core count. */
  cores?: number
  /** System load average. */
  systemLoad?: number
  /** Average NodeLink CPU load. */
  nodelinkLoad?: number
}

/**
 * Audio frame statistics for playback.
 * @public
 */
export interface FrameStats {
  /** Frames sent to the voice connection. */
  sent?: number
  /** Frames filled with silence. */
  nulled?: number
  /** Expected frames not sent. */
  deficit?: number
  /** Expected frames based on timing. */
  expected?: number
}

/**
 * Aggregated stats payload sent to the metrics manager.
 * @public
 */
export interface StatsMetricsPayload {
  /** Total active players. */
  players?: number
  /** Total playing players. */
  playingPlayers?: number
  /** Server uptime in milliseconds. */
  uptime?: number
  /** Memory usage snapshot. */
  memory?: MemoryStats
  /** CPU usage snapshot. */
  cpu?: CpuStats
  /** Audio frame stats. */
  frameStats?: FrameStats | null
}

/**
 * Worker-specific statistics payload.
 * @public
 */
export interface WorkerStatsPayload {
  /** Active players on the worker. */
  players?: number
  /** Active playing players on the worker. */
  playingPlayers?: number
  /** Length of the worker command queue. */
  commandQueueLength?: number
  /** CPU usage snapshot for the worker. */
  cpu?: {
    /** Average NodeLink CPU load. */
    nodelinkLoad?: number
  }
  /** Memory usage snapshot for the worker. */
  memory?: {
    /** Used heap memory in bytes. */
    used?: number
    /** Allocated heap memory in bytes. */
    allocated?: number
  }
  /** Event loop lag in milliseconds. */
  eventLoopLag?: number
  /** Audio frame stats for the worker. */
  frameStats?: FrameStats
}

/**
 * Full worker metrics entry sent to the metrics manager.
 * @public
 */
export interface WorkerMetricsEntry {
  /** Worker cluster identifier. */
  clusterId?: number
  /** Worker process ID. */
  pid?: number
  /** Worker stats payload. */
  stats: WorkerStatsPayload
  /** Worker health status. */
  health?: boolean
  /** Worker uptime in seconds. */
  uptime?: number
}

/**
 * Dictionary of worker metrics keyed by worker ID.
 * @public
 */
export type WorkerMetricsPayload = Record<string, WorkerMetricsEntry>
