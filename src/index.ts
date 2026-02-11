import cluster from 'node:cluster'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import WebSocketServer from '@performanc/pwsl-server'

import RequestHandler from './api/index.ts'
import ConnectionManager from './managers/connectionManager.ts'
import CredentialManager from './managers/credentialManager.ts'
import RoutePlannerManager from './managers/routePlannerManager.js'
import SessionManager from './managers/sessionManager.js'
import StatsManager from './managers/statsManager.ts'
import TrackCacheManager from './managers/trackCacheManager.ts'
import {
  applyEnvOverrides,
  checkForUpdates,
  cleanupHttpAgents,
  cleanupLogger,
  decodeTrack,
  getGitInfo,
  getStats,
  getVersion,
  initLogger,
  logger,
  parseClient,
  validateProperty,
  verifyDiscordID
} from './utils.ts'
import 'dotenv/config'
import type { ServerWebSocket } from 'bun'
import { GatewayEvents } from './constants.ts'
import DosProtectionManager from './managers/dosProtectionManager.ts'
import type LyricsManager from './managers/lyricsManager.js'
import type MeaningManager from './managers/meaningManager.js'
import PlayerManager from './managers/playerManager.js'
import PluginManager from './managers/pluginManager.js'
import RateLimitManager from './managers/rateLimitManager.ts'
import type SourcesManager from './managers/sourceManager.js'
import SourceWorkerManager from './managers/sourceWorkerManager.js'
import WorkerManager from './managers/workerManager.js'
import type { NodelinkConfig } from './typings/config/config.types.ts'
import type {
  AudioInterceptorExtension,
  BunSocketData,
  ConfigLoadError,
  FilterExtension,
  GitInfo,
  IBunSocketWrapper,
  NodelinkServer as INodelinkServer,
  MiddlewareExtension,
  NodelinkExtensions,
  NodelinkServerType,
  NodelinkSocketType,
  NodelinkStatistics,
  ParsedWebSocketData,
  PlayerInterceptorExtension,
  PlayerManagerConstructor,
  RequestShim,
  ResponseShim,
  RouteExtension,
  SessionSocket,
  SourceExtension,
  TrackModifierExtension,
  VoiceRelay,
  WebSocketInterceptorExtension,
  Worker
} from './typings/index.types.ts'
import type { ClientInfo, IPCMessage, ReqShim } from './typings/shared.types.ts'
import { parseVoiceFrameHeader } from './voice/voiceFrames.ts'
import { createVoiceRelay } from './voice/voiceRelay.ts'

let config: NodelinkConfig

try {
  config = (await import('../config.js')).default as unknown as NodelinkConfig
} catch (e) {
  const error = e as ConfigLoadError
  if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT') {
    try {
      config = (await import('../config.default.js'))
        .default as unknown as NodelinkConfig
      console.log(
        '[WARN] Config: config.js not found, using config.default.js. It is recommended to create a config.js file for your own configuration.'
      )
    } catch (e2) {
      console.error(
        '[ERROR] Config: Failed to load config.default.js. Please make sure it exists.'
      )
      throw e2
    }
  } else {
    throw e
  }
}

// Apply environment variable overrides after config is loaded
applyEnvOverrides(config)

const clusterEnabled =
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
  process.env['CLUSTER_ENABLED']?.toLowerCase() === 'true' ||
  (typeof config.cluster?.enabled === 'boolean' && config.cluster.enabled) ||
  false

let _configuredWorkers = 0
// biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
if (process.env['CLUSTER_WORKERS'])
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
  _configuredWorkers = Number(process.env['CLUSTER_WORKERS'])
else if (typeof config.cluster?.workers === 'number')
  _configuredWorkers = config.cluster.workers

// biome-ignore lint/suspicious/noExplicitAny: Config type alignment
initLogger(config as any)

const isBun = typeof Bun !== 'undefined'

if (!cluster.isWorker) {
  const ascii = `
   ▄   ████▄ ██▄   ▄███▄   █    ▄█    ▄   █  █▀
    █  █   █ █  █  █▀   ▀  █    ██     █  █▄█
██   █ █   █ █   █ ██▄▄    █    ██ ██   █ █▀▄   ${clusterEnabled ? 'Cluster Mode' : 'Single Process'}
█ █  █ ▀████ █  █  █▄   ▄▀ ███▄ ▐█ █ █  █ █  █  v${getVersion()}
█  █ █       ███▀  ▀███▀       ▀ ▐ █  █ █   █   Powered by PerformanC;
█   ██                             █   ██  ▀    rewritten by 1Lucas1.apk;
`
  process.stdout.write(`\x1b[32m${ascii}\x1b[0m\n`)
}

await checkForUpdates()

/**
 * Wrapper for Bun's ServerWebSocket that implements EventEmitter
 * Provides compatibility with Node.js WebSocket implementations
 */
class BunSocketWrapper extends EventEmitter implements IBunSocketWrapper {
  ws: ServerWebSocket<BunSocketData>
  remoteAddress: string

  /**
   * Creates a new BunSocketWrapper
   * @param ws - Bun ServerWebSocket instance
   */
  constructor(ws: ServerWebSocket<BunSocketData>) {
    super()
    this.ws = ws
    this.remoteAddress = ws?.data?.remoteAddress || 'unknown'
  }

  /**
   * Sends data through the WebSocket connection
   * @param data - Data to send
   * @returns True if sent successfully
   */
  /**
   * Sends data through the WebSocket connection
   * @param data - Data to send
   * @returns True if sent successfully
   * @public
   */
  send(data: string | Buffer): boolean {
    try {
      const r = this.ws.send(data)
      return r !== 0
    } catch {
      return false
    }
  }

  /**
   * Sends a WebSocket ping frame
   * @param data - Optional ping data
   * @returns True if sent successfully
   * @public
   */
  ping(data?: string | Buffer): boolean {
    try {
      this.ws.ping?.(data)
      return true
    } catch {
      return false
    }
  }

  /**
   * Closes the connection.
   *
   * Here is a list of close codes:
   * - `1000` means "normal closure" **(default)**
   * - `1009` means a message was too big and was rejected
   * - `1011` means the server encountered an error
   * - `1012` means the server is restarting
   * - `1013` means the server is too busy or the client is rate-limited
   * - `4000` through `4999` are reserved for applications (you can use it!)
   *
   * To close the connection abruptly, use `terminate()`.
   *
   * @param code The close code to send
   * @param reason The close reason to send
   * @public
   */
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }

  /**
   * Terminates the connection immediately
   * @public
   */
  terminate(): void {
    this.ws.close(1000, 'Terminated')
  }

  /**
   * Internal handler for received messages
   * @param message - Message data
   * @internal
   */
  _handleMessage(message: string | Buffer): void {
    this.emit('message', message)
  }

  /**
   * Internal handler for connection close events
   * @param code - Close code
   * @param reason - Close reason
   * @internal
   */
  _handleClose(code: number, reason: string): void {
    this.emit('close', code, reason)
  }
}

/**
 * Main NodeLink server class
 * Handles WebSocket connections, audio sources, and player management
 */
class NodelinkServer extends EventEmitter {
  options: NodelinkConfig
  logger: typeof logger
  server: NodelinkServerType
  socket: NodelinkSocketType
  _usingBunServer: boolean
  sessions: SessionManager
  sources: SourcesManager | null
  lyrics: LyricsManager | null
  meanings: MeaningManager | null
  _sourceInitPromise: Promise<void>
  routePlanner: RoutePlannerManager
  credentialManager: CredentialManager
  trackCacheManager: TrackCacheManager
  connectionManager: ConnectionManager
  statsManager: StatsManager
  rateLimitManager: RateLimitManager
  dosProtectionManager: DosProtectionManager
  pluginManager: PluginManager
  sourceWorkerManager: SourceWorkerManager | null
  workerManager: WorkerManager | null
  version: string
  gitInfo: GitInfo
  statistics: NodelinkStatistics
  extensions: NodelinkExtensions
  voiceSockets: Map<string, Set<SessionSocket>>
  voiceRelay: VoiceRelay
  _globalUpdater: NodeJS.Timeout | null
  _statsUpdater: NodeJS.Timeout | null
  supportedSourcesCache: string[] | null
  _heartbeatInterval: NodeJS.Timeout | null

  /**
   * Creates a new NodeLink server instance
   * @param options - Server configuration
   * @param PlayerManagerClass - Player manager constructor
   * @param isClusterPrimary - Whether this is the cluster primary
   */
  constructor(
    options: NodelinkConfig,
    PlayerManagerClass: PlayerManagerConstructor,
    isClusterPrimary = false
  ) {
    super()
    if (!options || Object.keys(options).length === 0)
      throw new Error('Configuration file not found or empty')
    this.options = options
    this.logger = logger
    this.server = null
    this.socket = null

    this._usingBunServer = Boolean(isBun && options?.server?.useBunServer) as
      | true
      | false

    this.sessions = new SessionManager(
      this,
      PlayerManagerClass as unknown as typeof PlayerManager
    )
    this.sources = null
    this.lyrics = null
    this.meanings = null

    this._sourceInitPromise = this._initSources(isClusterPrimary, options)

    this.routePlanner = new RoutePlannerManager(this)
    this.credentialManager = new CredentialManager(this)
    this.trackCacheManager = new TrackCacheManager(this)
    this.connectionManager = new ConnectionManager(this)
    this.statsManager = new StatsManager(this)
    this.rateLimitManager = new RateLimitManager(this)
    this.dosProtectionManager = new DosProtectionManager(this)
    this.pluginManager = new PluginManager(this)
    this.sourceWorkerManager =
      isClusterPrimary && options.cluster?.specializedSourceWorker?.enabled
        ? new SourceWorkerManager(this)
        : null
    this.workerManager = null
    this.version = String(getVersion())
    this.gitInfo = getGitInfo()
    this.statistics = {
      players: 0,
      playingPlayers: 0
    }

    this.extensions = {
      sources: new Map(),
      filters: new Map(),
      routes: [],
      middlewares: [],
      trackModifiers: [],
      wsInterceptors: [],
      audioInterceptors: [],
      playerInterceptors: []
    }

    this.voiceSockets = new Map()
    this.voiceRelay = createVoiceRelay({
      enabled: options.voiceReceive?.enabled || false,
      format: options.voiceReceive?.format || 'pcm',
      sendFrame: (frame: Buffer) => this.handleVoiceFrame(frame),
      logger
    }) as unknown as VoiceRelay

    this._globalUpdater = null
    this._statsUpdater = null
    this.supportedSourcesCache = null
    this._heartbeatInterval = null

    if (this._usingBunServer) {
      // EventEmitter used as WebSocket server shim for Bun
      this.socket = new EventEmitter()
    } else {
      this.socket = new WebSocketServer()
    }

    logger('info', 'Server', `version ${this.version}`)
    logger(
      'info',
      'Server',
      `git branch: ${this.gitInfo.branch}, commit: ${this.gitInfo.commit}, committed on: ${new Date(this.gitInfo.commitTime).toISOString()}`
    )
  }

  /**
   * Initializes source managers
   * @param isClusterPrimary - Whether this is the cluster primary
   * @param _options - Server configuration
   * @internal
   */
  async _initSources(
    isClusterPrimary: boolean,
    _options: NodelinkConfig
  ): Promise<void> {
    if (!isClusterPrimary) {
      const [
        { default: sourceMan },
        { default: lyricsMan },
        { default: meaningMan }
      ] = await Promise.all([
        import('./managers/sourceManager.js'),
        import('./managers/lyricsManager.js'),
        import('./managers/meaningManager.js')
      ])
      this.sources = new sourceMan(this)
      this.lyrics = new lyricsMan(this)
      this.meanings = new meaningMan(this)
    }
  }

  /**
   * Starts the heartbeat interval to keep WebSocket connections alive
   * @internal
   */
  _startHeartbeat() {
    if (this._heartbeatInterval) return

    this._heartbeatInterval = setInterval(() => {
      for (const session of this.sessions.activeSessions.values()) {
        if (session.socket && !session.isPaused) {
          try {
            if (typeof session.socket.sendFrame === 'function') {
              session.socket.sendFrame(Buffer.alloc(0), {
                len: 0,
                fin: true,
                opcode: 0x09
              })
            } else if (typeof session.socket.ping === 'function') {
              session.socket.ping()
            }
          } catch (_e) {
            logger(
              'debug',
              'Server',
              `Failed to send heartbeat to session ${session.id}`
            )
          }
        }
      }
    }, 45000)
  }

  /**
   * Stops the heartbeat interval
   * @internal
   */
  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
  }

  /**
   * Handles incoming voice frames and distributes them to registered sockets
   * @param frame - Voice frame buffer
   * @public
   */
  handleVoiceFrame(frame: Buffer): void {
    const header = parseVoiceFrameHeader(frame)
    if (!header?.guildId) return

    const sockets = this.voiceSockets.get(header.guildId)
    if (!sockets || sockets.size === 0) return

    for (const socket of sockets) {
      try {
        socket.send(frame)
      } catch {}
    }
  }

  /**
   * Registers a WebSocket to receive voice frames for a guild
   * @param guildId - Discord guild ID
   * @param socket - WebSocket connection
   * @public
   */
  registerVoiceSocket(guildId: string, socket: SessionSocket): void {
    if (!guildId || !socket) return

    let sockets = this.voiceSockets.get(guildId)
    if (!sockets) {
      sockets = new Set()
      this.voiceSockets.set(guildId, sockets)
    }

    sockets.add(socket)

    const cleanup = () => {
      const set = this.voiceSockets.get(guildId)
      if (!set) return
      set.delete(socket)
      if (set.size === 0) this.voiceSockets.delete(guildId)
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)
  }

  /**
   * Gets list of available sources from a worker
   * @returns Array of source names
   * @public
   */
  async getSourcesFromWorker() {
    if (!this.workerManager) {
      return []
    }
    const worker = this.workerManager.getBestWorker()
    if (!worker) {
      logger('warn', 'Server', 'No worker available to get sources from.')
      return []
    }
    const sources = await this.workerManager.execute(worker, 'getSources', {})
    return sources
  }

  /**
   * Validates the server configuration
   * @throws Error if configuration is invalid
   * @internal
   */
  _validateConfig(): void {
    const validateNonNegativeInt = (value: number, path: string): void =>
      validateProperty(
        value,
        path,
        'integer >= 0',
        (v: number) => Number.isInteger(v) && v >= 0
      )

    const validatePositiveInt = (value: number, path: string): void =>
      validateProperty(
        value,
        path,
        'integer > 0',
        (v: number) => Number.isInteger(v) && v > 0
      )

    validateProperty(
      this.options.server.port,
      'server.port',
      'integer between 1 and 65535',
      (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535
    )

    validateProperty(
      this.options.server.host,
      'server.host',
      'string',
      (value: string) => typeof value === 'string'
    )

    validateProperty(
      this.options.playerUpdateInterval,
      'playerUpdateInterval',
      'integer between 250 and 60000 (milliseconds)',
      (value: number) =>
        Number.isInteger(value) && value >= 250 && value <= 60000
    )

    validateProperty(
      this.options.maxSearchResults,
      'maxSearchResults',
      'integer between 1 and 100',
      (value: number) => Number.isInteger(value) && value >= 1 && value <= 100
    )

    validateProperty(
      this.options.maxAlbumPlaylistLength,
      'maxAlbumPlaylistLength',
      'integer between 1 and 500',
      (value: number) => Number.isInteger(value) && value >= 1 && value <= 500
    )

    validateProperty(
      this.options.trackStuckThresholdMs,
      'trackStuckThresholdMs',
      'integer >= 1000 (milliseconds)',
      (value: number) => Number.isInteger(value) && value >= 1000
    )

    validateProperty(
      this.options.zombieThresholdMs,
      'zombieThresholdMs',
      `integer > trackStuckThresholdMs (${this.options.trackStuckThresholdMs})`,
      (value: number) =>
        Number.isInteger(value) && value > this.options.trackStuckThresholdMs
    )

    validateNonNegativeInt(this.options.cluster.workers, 'cluster.workers')

    validateProperty(
      this.options.cluster.minWorkers,
      'cluster.minWorkers',
      this.options.cluster.workers === 0
        ? 'integer >= 0 (workers auto-scaled)'
        : `integer between 0 and ${this.options.cluster.workers}`,
      (value: number) =>
        Number.isInteger(value) &&
        value >= 0 &&
        (this.options.cluster.workers === 0 ||
          value <= this.options.cluster.workers)
    )

    validateProperty(
      this.options.defaultSearchSource,
      'defaultSearchSource',
      'key or array of keys of enabled sources in config.sources',
      (v: string | string[]) => {
        const sources = Array.isArray(v) ? v : [v]
        return sources.every(
          (s) =>
            typeof s === 'string' &&
            this.options.sources &&
            Boolean(
              this.options.sources[s as keyof typeof this.options.sources]
                ?.enabled
            )
        )
      }
    )

    validateProperty(
      this.options.audio.quality,
      'audio.quality',
      "one of ['high', 'medium', 'low', 'lowest']",
      (v: string) => ['high', 'medium', 'low', 'lowest'].includes(v)
    )

    validateProperty(
      this.options.audio.resamplingQuality,
      'audio.resamplingQuality',
      "one of ['best', 'medium', 'fastest', 'zero', 'linear']",
      (v: string) => ['best', 'medium', 'fastest', 'zero', 'linear'].includes(v)
    )

    validateProperty(
      this.options.audio.loudnessNormalizer,
      'audio.loudnessNormalizer',
      'boolean',
      (v: boolean) => typeof v === 'boolean'
    )

    validateProperty(
      this.options.audio.lookaheadMs,
      'audio.lookaheadMs',
      'number >= 0',
      (v: number) => typeof v === 'number' && v >= 0
    )

    validateProperty(
      this.options.audio.gateThresholdLUFS,
      'audio.gateThresholdLUFS',
      'number <= 0',
      (v: number) => typeof v === 'number' && v <= 0
    )

    validateProperty(
      this.options.routePlanner?.strategy,
      'routePlanner.strategy',
      "one of ['RotateOnBan', 'RoundRobin', 'LoadBalance']",
      (v: string) =>
        typeof v === 'string' &&
        ['RotateOnBan', 'RoundRobin', 'LoadBalance'].includes(v)
    )

    if (this.options.routePlanner?.bannedIpCooldown !== undefined) {
      validatePositiveInt(
        this.options.routePlanner.bannedIpCooldown,
        'routePlanner.bannedIpCooldown'
      )
    }

    const rateLimitSections = [
      'global',
      'perIp',
      'perUserId',
      'perGuildId'
    ] as const

    if (this.options.rateLimit?.enabled !== false) {
      for (let i = 0; i < rateLimitSections.length; i++) {
        const section = rateLimitSections[
          i
        ] as (typeof rateLimitSections)[number]
        const config = this.options.rateLimit?.[section]

        if (!config) continue

        validatePositiveInt(
          config.maxRequests,
          `rateLimit.${section}.maxRequests`
        )

        validatePositiveInt(
          config.timeWindowMs,
          `rateLimit.${section}.timeWindowMs`
        )

        if (i === 0) continue

        const parentSection = rateLimitSections[
          i - 1
        ] as (typeof rateLimitSections)[number]
        const parentConfig = this.options.rateLimit?.[parentSection]

        if (!parentConfig) continue

        validateProperty(
          config.maxRequests,
          `rateLimit.${section}.maxRequests`,
          `integer <= rateLimit.${parentSection}.maxRequests (${parentConfig.maxRequests})`,
          (value: number) =>
            Number.isInteger(value) &&
            value > 0 &&
            value <= parentConfig.maxRequests
        )
      }
    }

    const spotify = this.options.sources?.spotify
    const applemusic = this.options.sources?.applemusic
    const tidal = this.options.sources?.tidal
    const jiosaavn = this.options.sources?.jiosaavn
    const audius = this.options.sources?.audius

    if (spotify?.enabled) {
      validateNonNegativeInt(
        spotify.playlistLoadLimit,
        'sources.spotify.playlistLoadLimit'
      )

      validateNonNegativeInt(
        spotify.albumLoadLimit,
        'sources.spotify.albumLoadLimit'
      )

      validatePositiveInt(
        spotify.playlistPageLoadConcurrency,
        'sources.spotify.playlistPageLoadConcurrency'
      )

      validatePositiveInt(
        spotify.albumPageLoadConcurrency,
        'sources.spotify.albumPageLoadConcurrency'
      )

      const credsComplete =
        Boolean(spotify.clientId) === Boolean(spotify.clientSecret)

      validateProperty(
        credsComplete,
        'sources.spotify.credentials',
        'clientId and clientSecret must be set together',
        (v: boolean) => v === true
      )
    }

    if (applemusic?.enabled) {
      validateNonNegativeInt(
        applemusic.playlistLoadLimit,
        'sources.applemusic.playlistLoadLimit'
      )

      validateNonNegativeInt(
        applemusic.albumLoadLimit,
        'sources.applemusic.albumLoadLimit'
      )

      validatePositiveInt(
        applemusic.playlistPageLoadConcurrency,
        'sources.applemusic.playlistPageLoadConcurrency'
      )

      validatePositiveInt(
        applemusic.albumPageLoadConcurrency,
        'sources.applemusic.albumPageLoadConcurrency'
      )
    }

    if (tidal?.enabled) {
      validateNonNegativeInt(
        tidal.playlistLoadLimit,
        'sources.tidal.playlistLoadLimit'
      )

      validatePositiveInt(
        tidal.playlistPageLoadConcurrency,
        'sources.tidal.playlistPageLoadConcurrency'
      )

      if (tidal.token !== undefined) {
        validateProperty(
          tidal.token,
          'sources.tidal.token',
          'string (non-whitespace if provided)',
          (v: string) =>
            typeof v === 'string' && (v === '' || v.trim().length > 0)
        )
      }

      if (audius?.enabled) {
        if (
          audius?.appName !== undefined &&
          typeof audius?.appName !== 'string'
        ) {
          throw new Error('sources.audius.appName must be a string')
        }

        if (
          audius?.apiKey !== undefined &&
          typeof audius?.apiKey !== 'string'
        ) {
          throw new Error('sources.audius.apiKey must be a string')
        }

        if (
          audius?.apiSecret !== undefined &&
          typeof audius?.apiSecret !== 'string'
        ) {
          throw new Error('sources.audius.apiSecret must be a string')
        }

        validateNonNegativeInt(
          audius?.playlistLoadLimit,
          'sources.audius.playlistLoadLimit'
        )

        validateNonNegativeInt(
          audius?.albumLoadLimit,
          'sources.audius.albumLoadLimit'
        )
      }
    }

    if (jiosaavn?.enabled) {
      validateNonNegativeInt(
        jiosaavn.playlistLoadLimit,
        'sources.jiosaavn.playlistLoadLimit'
      )

      validateNonNegativeInt(
        jiosaavn.artistLoadLimit,
        'sources.jiosaavn.artistLoadLimit'
      )

      validateProperty(
        jiosaavn.playlistLoadLimit,
        'sources.jiosaavn.playlistLoadLimit',
        `integer >= artistLoadLimit (${jiosaavn.artistLoadLimit})`,
        (v: number) => v >= jiosaavn.artistLoadLimit
      )
    }
  }

  /**
   * Sets up WebSocket server event handlers
   * @internal
   */
  _setupSocketEvents() {
    if (!this.socket) return

    this.socket.on('error', (error: Error) => {
      logger('error', 'WebSocket', `WebSocket server error: ${error.message}`)
    })

    this.socket.on(
      '/v4/websocket',
      (
        socket: SessionSocket,
        request: http.IncomingMessage,
        clientInfo: ClientInfo,
        oldSessionId: string
      ) => {
        const originalOn = socket.on.bind(socket)
        socket.on = (
          event: string,
          listener: (...args: (string | number | Buffer)[]) => void
        ) => {
          if (event === 'message') {
            return originalOn(
              event,
              async (...args: (string | number | Buffer)[]) => {
                const data = args[0]
                const interceptors = this.extensions?.wsInterceptors
                if (interceptors && Array.isArray(interceptors)) {
                  let parsedData: ParsedWebSocketData
                  try {
                    const dataStr =
                      typeof data === 'string'
                        ? data
                        : (data as Buffer).toString()
                    parsedData = JSON.parse(dataStr)
                  } catch {
                    parsedData = data as string | Buffer
                  }

                  for (const interceptor of interceptors) {
                    const handled = await interceptor(
                      this as INodelinkServer,
                      socket,
                      parsedData,
                      clientInfo
                    )
                    if (handled === true) return
                  }
                }
                listener(...args)
              }
            )
          }
          return originalOn(event, listener)
        }

        logger(
          'debug',
          'Resume',
          `Processing websocket connection. oldSessionId: ${oldSessionId}`
        )
        if (oldSessionId) {
          const session = this.sessions.resume(oldSessionId, socket)

          if (session) {
            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m${
                clientInfo.version
                  ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
                  : ''
              } resumed session with ID: ${oldSessionId}`
            )
            this.statsManager.incrementSessionResume(clientInfo.name, true)

            socket.on('close', (...args: (string | number | Buffer)[]) => {
              const code = args[0] as number
              const reason = args[1] as string
              if (!this.sessions.has(oldSessionId)) return

              const session = this.sessions.get(oldSessionId)
              if (!session) return

              logger(
                'info',
                'Server',
                `\x1b[36m${clientInfo.name}\x1b[0m/\x1b[32mv${
                  clientInfo.version
                }\x1b[0m disconnected with code ${code} and reason: ${
                  reason || 'without reason'
                }`
              )

              if (session.resuming) {
                this.sessions.pause(oldSessionId)
              } else {
                this.sessions.shutdown(oldSessionId)
              }

              const sessionCount = this.sessions.activeSessions?.size || 0
              this.statsManager.setWebsocketConnections(sessionCount)
            })

            socket.send(
              JSON.stringify({
                op: 'ready',
                resumed: true,
                sessionId: oldSessionId
              })
            )

            while (session.eventQueue.length > 0) {
              const event = session.eventQueue.shift()
              socket.send(event)
            }

            for (const [
              playerKey,
              playerInfo
            ] of session.players.players.entries()) {
              if (this.workerManager) {
                const worker = this.workerManager.getWorkerForGuild(playerKey)
                if (worker) {
                  this.workerManager.execute(worker, 'playerCommand', {
                    sessionId: session.id,
                    guildId: playerInfo.guildId,
                    command: 'forceUpdate',
                    args: []
                  })
                }
              } else {
                playerInfo._sendUpdate()
              }
            }

            const sessionCount = this.sessions.activeSessions?.size || 0
            this.statsManager.setWebsocketConnections(sessionCount)
          }
        } else {
          const sessionId = this.sessions.create(request, socket, clientInfo)

          const sessionCount = this.sessions.activeSessions?.size || 0
          this.statsManager.setWebsocketConnections(sessionCount)

          socket.on('close', (...args: (string | number | Buffer)[]) => {
            const code = args[0] as number
            const reason = args[1] as string
            if (!this.sessions.has(sessionId)) return

            const session = this.sessions.get(sessionId)
            if (!session) return

            logger(
              'info',
              'Server',
              `\x1b[36m${clientInfo.name}\x1b[0m${
                clientInfo.version
                  ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
                  : ''
              } disconnected with code ${code} and reason: ${
                reason || 'without reason'
              }`
            )

            if (session.resuming) {
              this.sessions.pause(sessionId)
            } else {
              this.sessions.shutdown(sessionId)
            }

            const sessionCount = this.sessions.activeSessions?.size || 0
            this.statsManager.setWebsocketConnections(sessionCount)
          })

          socket.send(
            JSON.stringify({
              op: 'ready',
              resumed: false,
              sessionId
            })
          )
        }
      }
    )
  }

  /**
   * Creates and configures Bun HTTP server with WebSocket support
   * @internal
   */
  _createBunServer() {
    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'
    const password = this.options.server.password
    const self = this

    logger(
      'warn',
      'Server',
      'Running with Bun.serve, remember this is experimental!'
    )

    this.server = Bun.serve({
      port,
      hostname: host,
      maxRequestBodySize: 1024 * 1024 * 50,

      async fetch(req, server) {
        const url = new URL(req.url)
        const pathname = url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname

        if (pathname === '/v4/websocket') {
          const remoteAddress = server.requestIP(req)?.address || 'unknown'
          const clientAddress = `[External] (${remoteAddress})`

          const clientName = req.headers.get('client-name')
          const auth = req.headers.get('authorization')
          const userId = req.headers.get('user-id')
          const sessionId = req.headers.get('session-id')

          if (auth !== password) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${auth || 'None'}`
            )
            return new Response('Invalid password provided.', {
              status: 401,
              statusText: 'Unauthorized',
              headers: {
                'Nodelink-Api-Version': '4',
                IamNodelink: 'true'
              }
            })
          }

          if (!clientName) {
            logger(
              'warn',
              'Server',
              `Missing client-name from ${clientAddress}`
            )
            return new Response('Invalid or missing Client-Name header.', {
              status: 400,
              statusText: 'Bad Request',
              headers: {
                'Nodelink-Api-Version': '4',
                IamNodelink: 'true'
              }
            })
          }

          if (!userId || !verifyDiscordID(userId)) {
            logger('warn', 'Server', `Invalid user ID from ${clientAddress}`)
            return new Response('Invalid or missing User-Id header.', {
              status: 400,
              statusText: 'Bad Request',
              headers: {
                'Nodelink-Api-Version': '4',
                IamNodelink: 'true'
              }
            })
          }

          const clientInfo = parseClient(clientName) as ClientInfo | null
          if (!clientInfo) {
            logger(
              'warn',
              'Server',
              `Invalid client-name from ${clientAddress}`
            )
            return new Response('Invalid or missing Client-Name header.', {
              status: 400,
              statusText: 'Bad Request',
              headers: {
                'Nodelink-Api-Version': '4',
                IamNodelink: 'true'
              }
            })
          }

          const success = server.upgrade(req, {
            data: {
              clientInfo,
              sessionId,
              reqHeaders: Object.fromEntries(req.headers),
              remoteAddress,
              url: req.url
            }
          })

          if (success) return undefined
          return new Response('WebSocket upgrade failed', {
            status: 400,
            headers: {
              'Nodelink-Api-Version': '4',
              IamNodelink: 'true'
            }
          })
        }

        return new Promise((resolve) => {
          interface RequestShimInternal extends RequestShim {
            _endCb?: () => void
          }

          const reqShim: RequestShimInternal = {
            method: req.method,
            url: url.pathname + url.search,
            headers: Object.fromEntries(req.headers),
            socket: { remoteAddress: server.requestIP(req)?.address },
            on: (event: string, cb: (data: Buffer) => void) => {
              if (event === 'data') {
                req
                  .arrayBuffer()
                  .then((buf: ArrayBuffer) => {
                    cb(Buffer.from(buf))
                    if (reqShim._endCb) reqShim._endCb()
                  })
                  .catch(() => {})
              }
              if (event === 'end') {
                reqShim._endCb = cb as () => void
              }
            }
          }

          const resShim: ResponseShim = {
            _status: 200,
            _headers: {},
            _body: [],
            writeHead(
              status: number,
              headers?: Record<string, string | string[]>
            ) {
              this._status = status
              if (headers) Object.assign(this._headers, headers)
            },
            setHeader(name: string, value: string | string[]) {
              this._headers[name] = value
            },
            getHeader(name: string) {
              return this._headers[name]
            },
            end(data?: string | Buffer) {
              if (data) this._body.push(data)
              const finalBody = Buffer.concat(
                this._body.map((chunk) =>
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                )
              )

              const headers = new Headers()
              for (const [key, value] of Object.entries(this._headers)) {
                if (Array.isArray(value)) {
                  for (const v of value) headers.append(key, v)
                } else {
                  headers.set(key, value)
                }
              }

              const response = new Response(finalBody, {
                status: this._status,
                headers
              })
              resolve(response)
            },
            write(data: string | Buffer) {
              if (data) this._body.push(data)
            }
          }

          RequestHandler(self, reqShim, resShim)
        })
      },

      websocket: {
        sendPings: true,
        data: {} as BunSocketData,
        open(ws) {
          if (!ws.data) return
          const wrapper = new BunSocketWrapper(ws)
          ws.data.wrapper = wrapper

          const { clientInfo, sessionId, reqHeaders } = ws.data

          const reqShim: ReqShim = {
            headers: reqHeaders,
            url: ws.data.url,
            socket: { remoteAddress: ws.data.remoteAddress }
          }

          logger(
            'info',
            'Server',
            `\x1b[36m${clientInfo.name}\x1b[0m${
              clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''
            } connected from [External] (${ws.data.remoteAddress}) | \x1b[33mURL:\x1b[0m ${ws.data.url}`
          )

          let eventName = '/v4/websocket'
          let guildId = null
          let liveId = null
          try {
            const url = new URL(ws.data.url)
            const voiceMatch = url.pathname.match(
              /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/
            )
            const liveMatch = url.pathname.match(
              /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/
            )

            if (voiceMatch) {
              if (!self.options.voiceReceive?.enabled) {
                try {
                  wrapper.close(1008, 'Voice receive disabled')
                } catch {}
                return
              }
              eventName = '/v4/websocket/voice'
              guildId = voiceMatch[1]
            } else if (liveMatch) {
              eventName = '/v4/websocket/youtube/live'
              liveId = liveMatch[1]
            }
          } catch {}

          if (self.socket) {
            self.socket.emit(
              eventName,
              wrapper,
              reqShim,
              clientInfo,
              sessionId,
              guildId || liveId
            )
          }
        },
        message(ws: ServerWebSocket<BunSocketData>, message: string | Buffer) {
          ws.data?.wrapper?._handleMessage(message)
        },
        close(
          ws: ServerWebSocket<BunSocketData>,
          code: number,
          reason: string
        ) {
          ws.data?.wrapper?._handleClose(code, reason)
        }
      }
    })

    logger(
      'started',
      'Server',
      `Successfully listening on ${host}:${port} (Bun Native)`
    )
  }

  /**
   * Creates HTTP server (Node.js or Bun)
   * @internal
   */
  _createServer() {
    if (this._usingBunServer) {
      this._createBunServer()
      return
    }

    this.server = http.createServer(
      (req: http.IncomingMessage, res: http.ServerResponse) =>
        RequestHandler(this, req, res)
    )

    ;(this.server as http.Server).keepAliveTimeout = 65000
    ;(this.server as http.Server).headersTimeout = 66000

    ;(this.server as http.Server).on(
      'upgrade',
      (
        request: http.IncomingMessage,
        socket: import('net').Socket,
        head: Buffer
      ) => {
        const { remoteAddress, remotePort } = request.socket
        const isInternal =
          /^(::1|localhost|127\.0\.0\.1)/.test(remoteAddress || '') ||
          /^::ffff:127\.0\.0\.1/.test(remoteAddress || '')
        const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${remotePort})`

        const rejectUpgrade = (
          status: number,
          statusText: string,
          body: string
        ) => {
          socket.write(
            `HTTP/1.1 ${status} ${statusText}\r\nNodelink-Api-Version: 4\r\nIamNodelink: true\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`
          )
          socket.destroy()
        }

        const originalHeaders = request.headers
        const headers: Record<string, string | string[]> = {}
        for (const key in originalHeaders) {
          const value = originalHeaders[key]
          if (value !== undefined) {
            headers[key.toLowerCase()] = value
          }
        }

        logger(
          'debug',
          'Resume',
          `Received headers (lowercased): ${JSON.stringify(headers)}`
        )

        // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
        const authorization = headers['authorization']
        const authValue = Array.isArray(authorization)
          ? authorization[0]
          : authorization
        if (authValue !== this.options.server.password) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid password provided: ${authValue || 'None'}`
          )
          return rejectUpgrade(
            401,
            'Unauthorized',
            'Invalid password provided.'
          )
        }
        const clientNameHeader = headers['client-name']
        const clientInfo = parseClient(
          Array.isArray(clientNameHeader)
            ? clientNameHeader[0]
            : clientNameHeader
        ) as {
          name: string
          version: string | undefined
        }
        if (!clientInfo) {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid client-name provided`
          )
          return rejectUpgrade(
            400,
            'Bad Request',
            'Invalid or missing Client-Name header.'
          )
        }

        let sessionId = headers['session-id']
        logger('debug', 'Resume', `Received session-id header: ${sessionId}`)
        if (sessionId && !this.sessions.resumableSessions.has(sessionId)) {
          logger(
            'warn',
            'Server',
            `Session-ID provided by ${clientAddress} does not exist or is not resumable: ${sessionId}, creating a new session`
          )
          sessionId = undefined
        }

        const { pathname } = new URL(
          request.url || '/',
          `http://${request.headers.host || 'localhost'}`
        )
        const voiceMatch = pathname.match(
          /^\/v4\/websocket\/voice\/([A-Za-z0-9]+)\/?$/
        )
        const liveMatch = pathname.match(
          /^\/v4\/websocket\/youtube\/live\/([^/]+)\/?$/
        )

        if (pathname === '/v4/websocket' || voiceMatch || liveMatch) {
          if (!headers['user-id']) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Missing user ID`
            )
            return rejectUpgrade(
              400,
              'Bad Request',
              'User-Id header is missing.'
            )
          }
          const userIdHeader = headers['user-id']
          const userId = Array.isArray(userIdHeader)
            ? userIdHeader[0]
            : userIdHeader
          if (!userId || !verifyDiscordID(userId)) {
            logger(
              'warn',
              'Server',
              `Unauthorized connection attempt from ${clientAddress} - Invalid user ID provided`
            )
            return rejectUpgrade(400, 'Bad Request', 'Invalid User-Id header.')
          }

          if (voiceMatch && !this.options.voiceReceive?.enabled) {
            return rejectUpgrade(
              404,
              'Not Found',
              'Voice websocket endpoint is disabled.'
            )
          }

          for (const key in headers) {
            const value = headers[key]
            if (typeof value === 'string') {
              request.headers[key] = value
            }
          }

          logger(
            'info',
            'Server',
            `\x1b[36m${clientInfo.name}\x1b[0m${
              clientInfo.version ? `/\x1b[32mv${clientInfo.version}\x1b[0m` : ''
            } connected from ${clientAddress} | \x1b[33mURL:\x1b[0m ${request.url}`
          )

          let eventName = '/v4/websocket'
          let routeId = null

          if (voiceMatch) {
            eventName = '/v4/websocket/voice'
            routeId = voiceMatch[1]
          } else if (liveMatch) {
            eventName = '/v4/websocket/youtube/live'
            routeId = liveMatch[1]
          }

          if (isBun && !this._usingBunServer && this.socket) {
            ;(this.socket as WebSocketServer).handleUpgrade(
              request,
              socket,
              head,
              null,
              (ws) => {
                this.socket?.emit(
                  eventName,
                  ws as SessionSocket,
                  request,
                  clientInfo,
                  sessionId,
                  routeId
                )
              }
            )
          } else {
            ;(this.socket as WebSocketServer | undefined)?.handleUpgrade(
              request,
              socket,
              head,
              null,
              (ws) =>
                this.socket?.emit(
                  eventName,
                  ws as SessionSocket,
                  request,
                  clientInfo,
                  sessionId,
                  routeId
                )
            )
          }
        } else {
          logger(
            'warn',
            'Server',
            `Unauthorized connection attempt from ${clientAddress} - Invalid path provided`
          )
          return rejectUpgrade(
            404,
            'Not Found',
            'Invalid path for WebSocket upgrade.'
          )
        }
      }
    )

    this.socket?.on(
      '/v4/websocket/voice',
      (
        socket: SessionSocket,
        request: RequestShim,
        _clientInfo: ClientInfo,
        _sessionId: string,
        guildId: string
      ) => {
        if (!this.options.voiceReceive?.enabled) {
          try {
            socket.close(1008, 'Voice receive disabled')
          } catch {}
          return
        }

        logger(
          'info',
          'Voice',
          `Voice websocket connected from ${request.socket?.remoteAddress || 'unknown'} | guild ${guildId}`
        )

        this.registerVoiceSocket(guildId, socket)
      }
    )

    this.socket?.on(
      '/v4/websocket/youtube/live',
      (
        socket: SessionSocket,
        request: RequestShim,
        _clientInfo: ClientInfo,
        _sessionId: string,
        id: string
      ) => {
        let videoId = id

        if (/^\d{17,20}$/.test(id)) {
          const player = this.sessions.getPlayer(id)
          if (player?.track?.info?.sourceName?.includes('youtube')) {
            videoId = player.track.info.identifier
          }
        } else if (id.length > 50) {
          try {
            const decoded = decodeTrack(id)
            if (decoded?.info?.sourceName?.includes('youtube')) {
              videoId = decoded.info.identifier
            }
          } catch (_e) {}
        }

        if (!this.sourceWorkerManager) {
          const yt = this.sources?.getSource('youtube')
          if (!yt) {
            socket.close(1008, 'YouTube source not enabled')
            return
          }
          yt.handleLiveChat(socket, videoId)
          return
        }

        logger(
          'info',
          'YouTube-LiveChat',
          `Delegating live chat for video: ${videoId} to worker`
        )

        const resShim = {
          headersSent: false,
          send: (data: string | Buffer) => {
            const payload = Buffer.isBuffer(data)
              ? data
              : Buffer.from(String(data))
            socket.sendFrame?.(payload, {
              len: payload.length,
              fin: true,
              opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
            })
          },
          writeHead: (status: number) => {
            if (status !== 200) socket.close(1011, 'Worker failed')
          },
          write: (data: string | Buffer) => {
            const payload = Buffer.isBuffer(data)
              ? data
              : Buffer.from(String(data))
            socket.sendFrame?.(payload, {
              len: payload.length,
              fin: true,
              opcode: Buffer.isBuffer(data) ? 0x02 : 0x01
            })
          },
          end: () => socket.close(1000, 'Finished'),
          on: (
            event: string,
            cb: (...args: (string | Buffer | number)[]) => void
          ) => socket.on(event, cb)
        }

        this.sourceWorkerManager.delegate(
          request,
          resShim,
          'loadLiveChat',
          { videoId },
          { isWebSocket: true }
        )
      }
    )
  }

  /**
   * Starts listening on configured port and host
   * @internal
   */
  _listen(): void {
    if (
      !this.server ||
      typeof (this.server as http.Server).listen !== 'function'
    )
      return

    const port = this.options.server.port
    const host = this.options.server.host || '0.0.0.0'

    logger(
      'info',
      'Server',
      `Attempting to listen on host: ${host}, port: ${port}`
    )

    ;(this.server as http.Server).on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger('error', 'Server', `Port ${port} is already in use.`)
      } else if (err.code === 'EADDRNOTAVAIL') {
        logger(
          'error',
          'Server',
          `The address ${host} is not available on this machine.`
        )
        logger(
          'error',
          'Server',
          'Please check your `host` configuration. Use "0.0.0.0" to listen on all available interfaces.'
        )
      } else {
        logger('error', 'Server', `Failed to start server: ${err.message}`)
      }
      process.exit(1)
    })

    ;(this.server as http.Server).listen(port, host, () => {
      logger(
        'started',
        'Server',
        `Successfully listening on host ${host}, port ${port}`
      )
    })
  }

  /**
   * Starts global player state updater interval
   * @internal
   */
  _startGlobalUpdater() {
    if (this._globalUpdater) return
    const updateInterval = Math.max(
      1,
      this.options?.playerUpdateInterval ?? 5000
    )
    const statsSendInterval = Math.max(
      1,
      this.options?.statsUpdateInterval ?? 30000
    )
    const metricsInterval = this.options?.metrics?.enabled
      ? 5000
      : statsSendInterval
    const zombieThreshold = this.options?.zombieThresholdMs ?? 60000

    this._globalUpdater = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          if (player?.track && !player.isPaused && player.connection) {
            if (
              player._lastStreamDataTime > 0 &&
              Date.now() - player._lastStreamDataTime >= zombieThreshold
            ) {
              logger(
                'warn',
                'Player',
                `Player for guild ${player.guildId} detected as zombie (no stream data).`
              )
              player.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: player.guildId,
                track: player.track,
                reason: 'no_stream_data',
                thresholdMs: zombieThreshold
              })
            }
            player._sendUpdate()
          }
        }
      }
    }, updateInterval)

    let lastStatsSendTime = 0
    this._statsUpdater = setInterval(() => {
      const now = Date.now()
      let localPlayers = 0
      let localPlayingPlayers = 0
      let voiceConnections = 0

      for (const session of this.sessions.values()) {
        if (!session.players) continue
        for (const player of session.players.players.values()) {
          localPlayers++
          if (!player.isPaused && player.track) {
            localPlayingPlayers++
          }
          if (player.connection) {
            voiceConnections++
          }
        }
      }

      this.statsManager.setVoiceConnections(voiceConnections)

      if (clusterEnabled && cluster.isWorker) {
        // fishy ports to typescript 🙃
        process.send?.({
          type: 'workerStats',
          stats: {
            players: localPlayers,
            playingPlayers: localPlayingPlayers
          }
        })
      } else if (!clusterEnabled) {
        this.statistics.players = localPlayers
        this.statistics.playingPlayers = localPlayingPlayers
      }

      const stats = getStats(this)
      const workerMetrics = this.workerManager
        ? this.workerManager.getWorkerMetrics()
        : null
      this.statsManager.updateStatsMetrics(
        stats,
        (workerMetrics ?? undefined) as null | undefined
      )

      if (now - lastStatsSendTime >= statsSendInterval) {
        lastStatsSendTime = now
        const statsPayload = JSON.stringify({ op: 'stats', ...stats })

        for (const session of this.sessions.values()) {
          if (session.socket) {
            session.socket.send(statsPayload)
          }
        }
      }
    }, metricsInterval)
  }

  /**
   * Stops global player updater interval
   * @internal
   */
  _stopGlobalPlayerUpdater() {
    if (this._globalUpdater) {
      clearInterval(this._globalUpdater)
      this._globalUpdater = null
    }
    if (this._statsUpdater) {
      clearInterval(this._statsUpdater)
      this._statsUpdater = null
    }
  }

  /**
   * Cleans up WebSocket server resources
   * @internal
   */
  async _cleanupWebSocketServer(): Promise<void> {
    if (this._usingBunServer && this.server) {
      try {
        logger('info', 'WebSocket', 'Stopping Bun server...')
        await (
          this.server as {
            stop: (force: boolean) => Promise<void>
            unref: () => void
          }
        ).stop(true)
        ;(
          this.server as {
            stop: (force: boolean) => Promise<void>
            unref: () => void
          }
        ).unref()
        logger('info', 'WebSocket', 'Bun server stopped successfully')
      } catch (e) {
        const error = e as Error
        logger(
          'error',
          'WebSocket',
          `Error stopping Bun server: ${error?.message ?? String(e)}`
        )
      }
      return
    }

    if (this.socket) {
      try {
        let closedCount = 0

        for (const session of this.sessions.activeSessions.values()) {
          if (session.socket) {
            try {
              session.socket.close(1000, 'Server shutdown')
              closedCount++
            } catch (_e) {
              try {
                session.socket.destroy?.()
              } catch (_destroyErr) {
                logger(
                  'debug',
                  'WebSocket',
                  `Failed to close/destroy socket for session ${session.id}`
                )
              }
            }
          }
        }

        this.sessions.activeSessions.clear()
        this.sessions.resumableSessions.clear()

        logger(
          'info',
          'WebSocket',
          `Closed ${closedCount} WebSocket connection(s) successfully`
        )
      } catch (error) {
        const err = error as Error
        logger(
          'error',
          'WebSocket',
          `Error closing WebSocket connections: ${err.message}`
        )
      }
    }
  }

  /**
   * Handles IPC messages from workers
   * @param msg - IPC message
   * @public
   */
  handleIPCMessage(msg: IPCMessage): void {
    if (msg.type === 'playerEvent') {
      const { sessionId, data } = msg.payload
      const session = this.sessions.get(sessionId)
      session?.socket?.send(data)
    } else if (msg.type === 'workerStats') {
      if (this.workerManager) {
        const worker = this.workerManager.workers.find(
          (w: Worker) => w.process.pid === msg.pid
        )
        if (worker) {
          this.workerManager.workerLoad.set(worker.id, msg.stats.players)
        }
      }
    } else if (msg.type === 'workerFailed') {
      const { workerId, affectedGuilds } = msg.payload
      logger(
        'warn',
        'Cluster',
        `Worker ${workerId} failed. Notifying clients for affected players: ${affectedGuilds.join(', ')}`
      )

      const sessionsToNotify = new Map()

      for (const playerKey of affectedGuilds) {
        const [sessionId, guildId] = playerKey.split(':')
        if (!sessionsToNotify.has(sessionId)) {
          sessionsToNotify.set(sessionId, new Set())
        }
        sessionsToNotify.get(sessionId).add(guildId)
      }

      for (const [sessionId, guildsInSession] of sessionsToNotify.entries()) {
        const session = this.sessions.get(sessionId)
        if (session?.socket) {
          const affected = Array.from(guildsInSession)
          session.socket.send(
            JSON.stringify({
              op: 'event',
              type: 'WorkerFailedEvent',
              affectedGuilds: affected,
              message: `Players for guilds ${affected.join(', ')} lost due to worker failure.`
            })
          )
          for (const guildId of affected) {
            session.socket.send(
              JSON.stringify({
                op: 'event',
                type: GatewayEvents.WEBSOCKET_CLOSED,
                guildId,
                code: 5001,
                reason: 'worker_failed',
                byRemote: false
              })
            )
          }
        }
      }
    }
  }

  /**
   * Starts the NodeLink server
   * @param startOptions - Cluster start options
   * @returns Server instance
   * @public
   */
  async start(
    startOptions: { isClusterPrimary?: boolean; isClusterWorker?: boolean } = {}
  ): Promise<NodelinkServer> {
    this._validateConfig()

    await this.credentialManager.load()
    await this.trackCacheManager.load()
    await this.statsManager.initialize()

    // Ensure sources are initialized before proceeding
    if (this._sourceInitPromise) await this._sourceInitPromise

    await this.pluginManager.load('master')

    if (this.sourceWorkerManager) {
      await this.sourceWorkerManager.start()
    }

    const specEnabled = this.options.cluster?.specializedSourceWorker?.enabled

    if (!startOptions.isClusterPrimary) {
      await this.pluginManager.load('worker')
    }

    if (this.sources && (!startOptions.isClusterPrimary || !specEnabled)) {
      await this.sources?.loadFolder()
      await this.lyrics?.loadFolder()
      await this.meanings?.loadFolder()
    }

    this._setupSocketEvents()
    this._createServer()

    if (startOptions.isClusterWorker) {
      logger(
        'info',
        'Server',
        'Running as cluster worker — waiting for sockets from master.'
      )
      process.on('message', (msg: IPCMessage | { type: string }, handle) => {
        if (!msg || msg.type !== 'sticky-session') return
        if (!handle) return
        try {
          try {
            // @ts-expect-error - handle.pause is from Node.js internal
            handle.pause?.()
          } catch (_e) {}
          ;(this.server as http.Server).emit('connection', handle)
        } catch (err) {
          const error = err as Error
          logger(
            'error',
            'Server',
            `Failed to inject socket from master: ${error.message}`
          )
          try {
            // @ts-expect-error - handle.destroy is from Node.js internal
            handle.destroy?.()
          } catch (_e) {}
        }
      })
    } else {
      this._listen()
    }

    if (startOptions.isClusterPrimary) {
      this._startMasterMetricsUpdater()
    } else {
      this._startGlobalUpdater()
    }

    if (!startOptions.isClusterPrimary || clusterEnabled) {
      this._startHeartbeat()
    }

    this.connectionManager.start()
    return this
  }

  /**
   * Starts metrics updater for cluster master process
   * @internal
   */
  _startMasterMetricsUpdater() {
    if (this._globalUpdater) return
    const statsSendInterval = Math.max(
      1,
      this.options?.statsUpdateInterval ?? 30000
    )
    const metricsInterval = this.options?.metrics?.enabled
      ? 5000
      : statsSendInterval

    let lastStatsSendTime = 0

    this._globalUpdater = setInterval(() => {
      const now = Date.now()
      const stats = getStats(this)
      const workerMetrics = this.workerManager
        ? this.workerManager.getWorkerMetrics()
        : null
      this.statsManager.updateStatsMetrics(
        stats,
        (workerMetrics ?? undefined) as null | undefined
      )

      const sessionCount = this.sessions.activeSessions?.size || 0
      this.statsManager.setWebsocketConnections(sessionCount)

      if (now - lastStatsSendTime >= statsSendInterval) {
        lastStatsSendTime = now
        const statsPayload = JSON.stringify({ op: 'stats', ...stats })
        for (const session of this.sessions.values()) {
          if (session.socket) {
            session.socket.send(statsPayload)
          }
        }
      }
    }, metricsInterval)
  }

  /**
   * Registers a custom source extension
   * @param name - Source name
   * @param source - Source extension implementation
   * @public
   */
  registerSource(name: string, source: SourceExtension): void {
    if (!this.sources) {
      logger(
        'warn',
        'Server',
        'Cannot register source in this context (sources manager not available).'
      )
      return
    }
    this.sources.sources.set(name, source)
    logger('info', 'Server', `Registered custom source: ${name}`)
  }

  /**
   * Registers a custom filter extension
   * @param name - Filter name
   * @param filter - Filter extension implementation
   * @public
   */
  registerFilter(name: string, filter: FilterExtension): void {
    this.extensions.filters.set(name, filter)
    logger('info', 'Server', `Registered custom filter: ${name}`)
  }

  /**
   * Registers a custom HTTP route
   * @param method - HTTP method
   * @param path - Route path
   * @param handler - Route handler function
   * @public
   */
  registerRoute(
    method: string,
    path: string,
    handler: RouteExtension['handler']
  ): void {
    this.extensions.routes.push({ method, path, handler })
    logger('info', 'Server', `Registered custom route: ${method} ${path}`)
  }

  /**
   * Registers a middleware extension
   * @param fn - Middleware function
   * @public
   */
  registerMiddleware(fn: MiddlewareExtension): void {
    this.extensions.middlewares.push(fn)
    logger('info', 'Server', 'Registered custom REST interceptor (middleware)')
  }

  /**
   * Registers a track modifier extension
   * @param fn - Track modifier function
   * @public
   */
  registerTrackModifier(fn: TrackModifierExtension): void {
    this.extensions.trackModifiers.push(fn)
    logger('info', 'Server', 'Registered custom track info modifier')
  }

  /**
   * Registers a WebSocket interceptor extension
   * @param fn - WebSocket interceptor function
   * @public
   */
  registerWebSocketInterceptor(fn: WebSocketInterceptorExtension): void {
    this.extensions.wsInterceptors.push(fn)
    logger('info', 'Server', 'Registered custom WebSocket interceptor')
  }

  /**
   * Registers an audio interceptor extension
   * @param interceptor - Audio interceptor function
   * @public
   */
  registerAudioInterceptor(interceptor: AudioInterceptorExtension): void {
    if (!this.extensions.audioInterceptors)
      this.extensions.audioInterceptors = []
    this.extensions.audioInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom audio interceptor')
  }

  /**
   * Registers a player interceptor extension
   * @param interceptor - Player interceptor function
   * @public
   */
  registerPlayerInterceptor(interceptor: PlayerInterceptorExtension): void {
    this.extensions.playerInterceptors.push(interceptor)
    logger('info', 'Server', 'Registered custom player interceptor')
  }
}

if (clusterEnabled && cluster.isPrimary) {
  if (config.sources?.youtube?.getOAuthToken) {
    // dynamicly import OAuth (if enabled)
    const OAuth = (
      await import('./sources/youtube/OAuth.js').catch((e) => {
        logger(
          'error',
          'youtube',
          `\x1b[1m\x1b[31mOAuth class not found Error: ${e.message}\x1b[0m`
        )
        process.exit(1)
      })
    ).default

    const mockNodelink: {
      options: NodelinkConfig
      credentialManager: CredentialManager
    } = {
      options: config,
      credentialManager: null as unknown as CredentialManager
    }
    mockNodelink.credentialManager = new CredentialManager(
      mockNodelink as unknown as INodelinkServer
    )
    const validator = new OAuth(mockNodelink as unknown as INodelinkServer)
    await validator.validateCurrentTokens()

    try {
      await OAuth.acquireRefreshToken()
      process.exit(0)
    } catch (error) {
      const err = error as Error
      logger(
        'error',
        'OAuth',
        `YouTube OAuth token acquisition failed: ${err.message}`
      )
      process.exit(1)
    }
  }

  const workerManager = new WorkerManager(config)

  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(
      config,
      PlayerManager as unknown as PlayerManagerConstructor,
      true
    )
    nserver.workerManager = workerManager

    await nserver.start({ isClusterPrimary: true })
    ;(global as typeof globalThis & { nodelink?: NodelinkServer }).nodelink =
      nserver

    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true

      if (nserver.workerManager) nserver.workerManager.isDestroying = true
      nserver.emit('shutdown')

      process.stdout.write(
        '\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n'
      )

      logger(
        'info',
        'Server',
        'Shutdown signal received. Cleaning up resources...'
      )

      nserver._stopHeartbeat()

      await nserver.credentialManager.forceSave()
      await nserver.trackCacheManager.forceSave()

      workerManager.destroy()

      await nserver._cleanupWebSocketServer()

      if ((nserver.server as http.Server)?.listening) {
        await new Promise((resolve) =>
          (nserver.server as http.Server).close(resolve)
        )
        logger('info', 'Server', 'HTTP server closed.')
      }

      cleanupHttpAgents()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
      cleanupLogger()

      process.exit(0)
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    return nserver
  })()

  await serverInstancePromise.catch((err) => {
    logger(
      'error',
      'Server',
      `Fatal error during primary startup: ${err.message}`,
      err
    )
    process.exit(1)
  })
} else if (clusterEnabled && cluster.isWorker) {
  await import('./workers/main.ts')
} else {
  const serverInstancePromise = (async () => {
    const nserver = new NodelinkServer(
      config,
      PlayerManager as unknown as PlayerManagerConstructor,
      false
    )
    await nserver.start()
    ;(global as typeof globalThis & { nodelink?: NodelinkServer }).nodelink =
      nserver

    logger(
      'info',
      'Server',
      `Single-process server running (PID ${process.pid})`
    )

    let isShuttingDown = false
    const shutdown = async () => {
      if (isShuttingDown) return
      isShuttingDown = true

      logger(
        'info',
        'Server',
        'Shutdown signal received. Cleaning up resources...'
      )

      nserver._stopHeartbeat()

      await nserver.credentialManager.forceSave()
      await nserver.trackCacheManager.forceSave()

      await nserver._cleanupWebSocketServer()

      if ((nserver.server as http.Server)?.listening) {
        await new Promise((resolve) =>
          (nserver.server as http.Server).close(resolve)
        )
        logger('info', 'Server', 'HTTP server closed.')
      }

      cleanupHttpAgents()
      nserver.rateLimitManager.destroy()
      nserver.dosProtectionManager.destroy()
      cleanupLogger()

      process.stdout.write(
        '\n  \x1b[32m💚 Thank you for using NodeLink!\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[37mIf you have ideas, suggestions or want to report bugs, join us on Discord:\x1b[0m\n'
      )
      process.stdout.write(
        '  \x1b[1m\x1b[34m➜\x1b[0m \x1b[36mhttps://discord.gg/fzjksWS65v\x1b[0m\n\n'
      )

      process.exit(0)
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)

    return nserver
  })()

  await serverInstancePromise.catch((err) => {
    logger(
      'error',
      'Server',
      `Fatal error during single-process startup: ${err.message}`,
      err
    )
    process.exit(1)
  })
}
