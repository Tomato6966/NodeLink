/**
 * Connection quality status categories.
 * @public
 */
export type ConnectionStatus =
  | 'unknown'
  | 'good'
  | 'average'
  | 'bad'
  | 'disconnected'

/**
 * Download speed metrics.
 * @public
 */
export interface ConnectionSpeedMetrics {
  /** Bytes per second. */
  bps: number
  /** Kilobits per second. */
  kbps: number
  /** Megabits per second. */
  mbps: number
}

/**
 * Test endpoint definition used by the connection checker.
 * @public
 */
export interface ConnectionEndpoint {
  /** Human-friendly endpoint name. */
  name: string
  /** Endpoint URL. */
  url: string
  /** Expected payload size in bytes (optional). */
  expectedSizeBytes?: number
}

/**
 * Network interface details inferred from the OS.
 * @public
 */
export interface NetworkInfo {
  /** Whether a non-internal interface was found. */
  isConnected: boolean
  /** Connection type guess based on interface naming. */
  connectionType: 'wifi' | 'ethernet' | 'mobile' | 'unknown'
  /** Wi-Fi SSID if available. */
  wifiName?: string
  /** Primary IPv4 address. */
  ipAddress?: string
  /** Default gateway if detected. */
  gateway?: string
  /** DNS servers configured on the host. */
  dnsServers?: string[]
  /** Network interface name. */
  interfaceName?: string
}

/**
 * Result of a DNS connectivity check.
 * @public
 */
export interface ConnectivityTestResult {
  /** True when at least one host responds. */
  isOnline: boolean
  /** Target host used in the successful check. */
  host?: string
  /** Lookup latency in milliseconds. */
  latencyMs?: number
  /** Error message if all checks failed. */
  error?: string
}

/**
 * Result of a ping test.
 * @public
 */
export interface PingResult {
  /** Host tested. */
  host: string
  /** Whether the host responded. */
  alive: boolean
  /** Minimum latency in milliseconds. */
  minMs?: number
  /** Maximum latency in milliseconds. */
  maxMs?: number
  /** Average latency in milliseconds. */
  avgMs?: number
  /** Packet loss percentage. */
  packetLoss?: number
  /** Error message on failure. */
  error?: string
}

/**
 * Connection metrics published to clients.
 * @public
 */
export interface ConnectionMetrics {
  /** Speed metrics for the last successful test. */
  speed?: ConnectionSpeedMetrics
  /** Total downloaded bytes during the last test. */
  downloadedBytes?: number
  /** Duration of the last speed test in seconds. */
  durationSeconds?: number
  /** Time to first byte in milliseconds. */
  latencyMs?: number
  /** Endpoint used for the last speed test. */
  endpoint?: ConnectionEndpoint
  /** DNS connectivity result. */
  dns?: ConnectivityTestResult
  /** Ping test result. */
  ping?: PingResult
  /** Local network information. */
  network?: NetworkInfo
  /** Error message if checks failed. */
  error?: string
  /** Timestamp in milliseconds. */
  timestamp: number
}

/**
 * Connection manager configuration options.
 * @public
 */
export interface ConnectionConfig {
  /** Whether to log all checks, not only status changes. */
  logAllChecks?: boolean
  /** Interval between checks in milliseconds. */
  interval?: number
  /** Request timeout in milliseconds. */
  timeout?: number
  /** Thresholds for status classification in Mbps. */
  thresholds?: {
    bad?: number
    average?: number
  }
  /** Optional endpoints for speed tests. */
  testEndpoints?: ConnectionEndpoint[]
  /** Hosts used for DNS connectivity checks. */
  dnsHosts?: string[]
  /** Hosts used for ping checks. */
  pingHosts?: string[]
  /** Maximum bytes to download per speed test. */
  maxDownloadBytes?: number
  /** Maximum duration for speed tests in milliseconds. */
  maxTestDurationMs?: number
}
