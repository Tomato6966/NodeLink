/**
 * DoS protection threshold configuration.
 * @public
 */
export interface DosProtectionThresholds {
  /**
   * Maximum burst requests allowed within the time window.
   */
  burstRequests: number

  /**
   * Rolling time window in milliseconds.
   */
  timeWindowMs: number

  /**
   * Ratio of the burst limit that should trigger delay mitigation.
   * @defaultValue 0.5
   */
  warnRatio?: number

  /**
   * Maximum number of tracked IP entries.
   * @defaultValue 10000
   */
  maxEntries?: number
}

/**
 * DoS protection mitigation settings.
 * @public
 */
export interface DosProtectionMitigation {
  /**
   * Delay applied when an IP approaches the burst limit.
   */
  delayMs: number

  /**
   * Base block duration in milliseconds.
   */
  blockDurationMs: number

  /**
   * Exponential backoff multiplier applied on repeated offenses.
   * @defaultValue 2
   */
  backoffMultiplier?: number

  /**
   * Maximum block duration in milliseconds.
   * @defaultValue blockDurationMs * 8
   */
  maxBlockDurationMs?: number
}

/**
 * Ignore list configuration for DoS protection.
 * @public
 */
export interface DosProtectionIgnore {
  /**
   * User IDs to bypass DoS checks.
   */
  userIds?: string[]

  /**
   * Guild IDs to bypass DoS checks.
   */
  guildIds?: string[]

  /**
   * IP addresses to bypass DoS checks.
   */
  ips?: string[]

  /**
   * Paths to bypass DoS checks.
   */
  paths?: string[]
}

/**
 * DoS protection configuration object.
 * @public
 */
export interface DosProtectionConfig {
  /**
   * Whether DoS protection is enabled.
   */
  enabled: boolean

  /**
   * Threshold configuration.
   */
  thresholds: DosProtectionThresholds

  /**
   * Mitigation settings.
   */
  mitigation: DosProtectionMitigation

  /**
   * Ignore list configuration.
   */
  ignore?: DosProtectionIgnore

  /**
   * Whether to trust proxy headers (x-forwarded-for).
   */
  trustProxy?: boolean
}

/**
 * Runtime tracking data for a single IP address.
 * @public
 */
export interface DosProtectionEntry {
  /**
   * Requests seen in the current window.
   */
  count: number

  /**
   * Timestamp for the current window reset.
   */
  lastReset: number

  /**
   * Timestamp for the last request.
   */
  lastSeen: number

  /**
   * Timestamp until which the IP remains blocked.
   */
  blockedUntil: number

  /**
   * Number of block strikes recorded.
   */
  strikes: number
}
