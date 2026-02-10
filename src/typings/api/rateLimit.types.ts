/**
 * Rate limit rule configuration.
 * @public
 */
export interface RateLimitRule {
  /**
   * Maximum number of requests allowed in the window.
   */
  maxRequests: number

  /**
   * Rolling time window in milliseconds.
   */
  timeWindowMs: number
}

/**
 * Ignore list configuration for rate limiting.
 * @public
 */
export interface RateLimitIgnore {
  /**
   * User IDs to bypass rate limits.
   */
  userIds?: string[]

  /**
   * Guild IDs to bypass rate limits.
   */
  guildIds?: string[]

  /**
   * IPs to bypass rate limits.
   */
  ips?: string[]

  /**
   * Paths to bypass rate limits.
   */
  paths?: string[]
}

/**
 * Rate limit configuration shape.
 * @public
 */
export interface RateLimitConfig {
  /**
   * Whether rate limiting is enabled.
   */
  enabled: boolean

  /**
   * Global rate limit rule.
   */
  global: RateLimitRule

  /**
   * Per-IP rate limit rule.
   */
  perIp: RateLimitRule

  /**
   * Per-user rate limit rule.
   */
  perUserId?: RateLimitRule

  /**
   * Per-guild rate limit rule.
   */
  perGuildId?: RateLimitRule

  /**
   * Paths to bypass rate limits.
   */
  ignorePaths?: string[]

  /**
   * Ignore list configuration.
   */
  ignore?: RateLimitIgnore

  /**
   * Whether to trust proxy headers for IP resolution.
   */
  trustProxy?: boolean

  /**
   * Maximum number of tracked keys.
   */
  maxEntries?: number
}

/**
 * Runtime tracking data for a rate limit key.
 * @public
 */
export interface RateLimitEntry {
  /**
   * Timestamp list for requests in the current window.
   */
  requests: number[]

  /**
   * Index of the first valid timestamp in the requests array.
   */
  head: number

  /**
   * Last time the key was seen.
   */
  lastSeen: number
}
