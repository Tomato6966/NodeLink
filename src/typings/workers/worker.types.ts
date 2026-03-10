import type { Readable } from 'node:stream'
import type {
  LoggerFn,
  LyricsManagerLike,
  NodeLink,
  PlayerVoiceState,
  PlayPayload,
  SourceManagerLike,
  StatsManagerLike,
  TrackInfoExtended
} from '../playback/player.types.ts'
import type {
  CredentialManager as CredentialManagerLike,
  MeaningManager as MeaningManagerLike,
  RoutePlannerManager as RoutePlannerManagerLike,
  SourceInstance as SourceInstanceBase,
  SourceManager as SourceManagerBase,
  TrackCacheManager as TrackCacheManagerLike,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult
} from '../sources/source.types.ts'

/**
 * NodeLink configuration shape.
 */
export type NodeLinkConfig = typeof import('../../../config.default.js').default

/**
 * Logger signature used by worker components.
 */
export type WorkerLogger = LoggerFn

/**
 * Worker's IPC or TCP command payload.
 */
export type WorkerCommandPayload = Record<string, unknown> | undefined

/**
 * Command queued for processing.
 */
export interface WorkerCommand {
  type: string
  requestId: string
  payload: WorkerCommandPayload
}

/**
 * Per-guild command queue entry.
 */
export interface GuildQueueEntry {
  queue: WorkerCommand[]
  processing: boolean
}

/**
 * Worker command interceptor.
 */
export type WorkerInterceptor = (
  type: string,
  payload: WorkerCommandPayload
) => boolean | Promise<boolean>

/**
 * Audio interceptor signature.
 */
export type AudioInterceptor = (stream: Readable) => unknown

/**
 * Registered worker extensions.
 */
export interface WorkerExtensions extends Record<string, unknown> {
  workerInterceptors: WorkerInterceptor[]
  audioInterceptors: AudioInterceptor[]
  filters?: Map<string, unknown>
}

/**
 * Runtime context shared across worker components.
 */
export interface WorkerNodeLink extends NodeLink {
  options: NodeLinkConfig & NodeLink['options']
  logger: WorkerLogger
  voiceRelay?: NodeLink['voiceRelay']
  statsManager: WorkerStatsManager
  credentialManager: CredentialManagerLike
  trackCacheManager: TrackCacheManagerLike
  sources: WorkerSourceManager
  lyrics: WorkerLyricsManager | null
  meanings: MeaningManagerLike | null
  routePlanner: RoutePlannerManagerLike
  connectionManager: ConnectionManagerLike
  pluginManager: PluginManagerLike
  extensions: WorkerExtensions
  registerWorkerInterceptor: (fn: WorkerInterceptor) => void
  registerSource: (name: string, source: SourceInstanceBase) => void
  registerFilter: (name: string, filter: unknown) => void
  registerAudioInterceptor: (fn: AudioInterceptor) => void
  getLyricsManager: () => Promise<WorkerLyricsManager>
  getMeaningManager: () => Promise<MeaningManagerLike>
  [key: string]: unknown
}

/**
 * PCM stream returned by the stream processor.
 */
export type PCMStream = TrackStreamResult['stream'] & {
  destroyed?: boolean
}

/**
 * Active stream entry used for cancellation and cleanup.
 */
export interface ActiveStreamEntry {
  pcmStream: PCMStream
  fetched: TrackStreamResult & { type?: string }
  cancelled: boolean
}

/**
 * Player surface used inside the worker (avoids reliance on private members).
 */
export type WorkerPlayer = {
  track: unknown
  isPaused: boolean
  connection?: {
    statistics?: {
      packetsSent?: number
      packetsLost?: number
      packetsExpected?: number
    }
  }
  guildId: string
  session?: {
    id?: string
    userId?: string
    isPaused?: boolean
    eventQueue?: string[]
  }
  emitEvent: (type: string, payload?: Record<string, unknown>) => void
  _sendUpdate: () => boolean
  _lastStreamDataTime?: number
  _isRestoring?: boolean
  updateVoice: (voice: PlayerVoiceState) => void
  volume: (volume: number) => void
  setFilters: (filters: Record<string, unknown>) => void
  pause: (pause: boolean) => void
  play: (track: PlayPayload) => Promise<unknown>
  destroy: (disconnect?: boolean) => void
} & Record<string, unknown>

/**
 * Source manager interface with worker-only helpers.
 */
export type WorkerSourceManager = SourceManagerBase

/**
 * Stats manager used in workers.
 */
export type WorkerStatsManager = StatsManagerLike & {
  initialize: () => Promise<void>
}

/**
 * Lyrics manager with loader lifecycle.
 */
export type WorkerLyricsManager = LyricsManagerLike & {
  loadFolder: () => Promise<void>
}

/**
 * Minimal connection manager interface.
 */
export interface ConnectionManagerLike {
  start: () => void
  stop: () => void
}

/**
 * Minimal plugin manager interface.
 */
export interface PluginManagerLike {
  load: (scope: string) => Promise<void>
}

/**
 * Payload used to create players.
 */
export interface CreatePlayerPayload {
  sessionId: string
  guildId: string
  userId: string
  voice?: PlayerVoiceState
}

/**
 * Payload used to restore players from snapshots.
 */
export interface RestorePlayerPayload {
  snapshot: {
    guildId: string
    sessionId: string
    userId: string
    track?: PlayPayload & { track?: string }
    position?: number
    isPaused?: boolean
    volume?: number
    filters?: Record<string, unknown>
    voice?: PlayerVoiceState
  }
}

/**
 * Payload used to play or fetch streams.
 */
export interface LoadStreamPayload {
  decodedTrackInfo?: TrackInfo
  guildId?: string
  streamId?: string
  position?: number
  volume?: number
  filters?: Record<string, unknown>
}
