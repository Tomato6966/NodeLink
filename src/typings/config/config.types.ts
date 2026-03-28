/**
 * Nodelink configuration type based on config.default.js
 * @public
 */
export type NodelinkConfig = typeof import('../../../config.default.js').default

/**
 * Server configuration options
 * @public
 */
export interface ServerConfig {
  /**
   * Port number for the server to listen on
   * @remarks Must be between 1 and 65535
   */
  port: number

  /**
   * Host address to bind the server to
   * @remarks Use "0.0.0.0" to listen on all interfaces
   */
  host: string

  /**
   * Authentication password for client connections
   */
  password: string

  /**
   * Whether to use Bun's native server instead of Node.js HTTP server
   * @defaultValue false
   * @experimental
   */
  useBunServer?: boolean
}

/**
 * Cluster configuration for multi-process deployment
 * @public
 */
export interface ClusterConfig {
  /**
   * Whether cluster mode is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Number of worker processes to spawn
   * @remarks Set to 0 for automatic (CPU count)
   */
  workers: number

  /**
   * Runtime node flags for playback/source worker processes
   */
  runtime?: {
    /**
     * Max old space size (MB) for playback workers (0 disables override)
     */
    workerMaxOldSpaceMb?: number
    /**
     * Enables --expose-gc for playback workers
     */
    workerExposeGc?: boolean
    /**
     * Extra Node.js argv for playback workers
     */
    workerExecArgv?: string[] | string
    /**
     * Max old space size (MB) for source workers (0 disables override)
     */
    sourceWorkerMaxOldSpaceMb?: number
    /**
     * Enables --expose-gc for source workers
     */
    sourceWorkerExposeGc?: boolean
    /**
     * Extra Node.js argv for source workers
     */
    sourceWorkerExecArgv?: string[] | string
  }

  /**
   * Specialized worker configuration for audio sources
   */
  specializedSourceWorker?: {
    /**
     * Whether specialized source worker is enabled
     * @defaultValue false
     */
    enabled: boolean
  }
}

/**
 * Audio source configuration base
 * @public
 */
export interface SourceConfigBase {
  /**
   * Whether this audio source is enabled
   */
  enabled: boolean
}

/**
 * YouTube source configuration
 * @public
 */
export interface YouTubeSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * Spotify source configuration
 * @public
 */
export interface SpotifySourceConfig extends SourceConfigBase {
  /**
   * Client ID for official API access.
   */
  clientId?: string

  /**
   * Client secret for official API access.
   */
  clientSecret?: string

  /**
   * Optional external URL for anonymous token generation.
   */
  externalAuthUrl?: string

  /**
   * Spotify sp_dc cookie for mobile token generation.
   */
  sp_dc?: string

  /**
   * Market code for search and resolution.
   * @defaultValue "US"
   */
  market?: string

  /**
   * Playlist load limit.
   */
  playlistLoadLimit: number

  /**
   * Album load limit.
   */
  albumLoadLimit: number

  /**
   * Maximum concurrent requests during playlist loading.
   */
  playlistPageLoadConcurrency?: number

  /**
   * Maximum concurrent requests during album loading.
   */
  albumPageLoadConcurrency?: number

  /**
   * Whether to allow explicit tracks in search/recommendations.
   */
  allowExplicit?: boolean

  /**
   * Whether Spotify playlist local files should be included.
   */
  allowLocalFiles: boolean
}

/**
 * Audius source configuration
 * @public
 */
export interface AudiusSourceConfig extends SourceConfigBase {
  /**
   * App name
   */
  appName: string

  /**
   * API key
   */
  apiKey: string

  /**
   * API secret
   */
  apiSecret: string

  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * JioSaavn source configuration
 * @public
 */
export interface JioSaavnSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Artist load limit
   */
  artistLoadLimit: number
}

/**
 * Apple Music source configuration
 * @public
 */
export interface AppleMusicSourceConfig extends SourceConfigBase {
  /**
   * Media API token for authentication
   */
  mediaApiToken?: string

  /**
   * Market/country code
   */
  market?: string

  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number

  /**
   * Whether to allow explicit content
   */
  allowExplicit: boolean
}

/**
 * Amazon Music source configuration
 * @public
 */
export interface AmazonMusicSourceConfig extends SourceConfigBase {
  /**
   * Playlist load limit
   */
  playlistLoadLimit: number

  /**
   * Album load limit
   */
  albumLoadLimit: number
}

/**
 * Voice receive configuration for receiving audio from Discord
 * @public
 */
export interface VoiceReceiveConfig {
  /**
   * Whether voice receiving is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Audio format for received voice data
   * @remarks
   * - `pcm`: Raw PCM audio data
   * - `opus`: Opus-encoded audio data
   */
  format: 'pcm' | 'opus'
}

/**
 * Rate limiting configuration
 * @public
 */
export interface RateLimitConfig {
  /**
   * Duration of the rate limit window in milliseconds
   */
  duration: number

  /**
   * Maximum number of requests allowed within the window
   */
  maxRequests: number
}

/**
 * Metrics collection configuration
 * @public
 */
export interface MetricsConfig {
  /**
   * Whether metrics collection is enabled
   * @defaultValue false
   */
  enabled: boolean

  /**
   * Interval for collecting metrics in milliseconds
   * @defaultValue 5000
   */
  interval?: number
}
