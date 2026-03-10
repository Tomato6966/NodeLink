import type { Readable } from 'node:stream'
import { SeekError } from '@ecliptia/seekable-stream'
import discordVoice, {
  type VoiceAudioStream,
  type VoiceConnection,
  type VoiceConnectionState,
  type VoicePlayerState
} from '@performanc/voice'
import { EndReasons, GatewayEvents } from '../constants.ts'
import type {
  AudioMixer,
  AudioOptionsWithTransitions,
  AudioResource,
  AutomixConfig,
  CreateAudioResource,
  CreateSeekeableAudioResource,
  CrossfadeConfig,
  CrossfadeMode,
  DeezerApiTrackResponse,
  DeezerMetadataConfig,
  DeezerTrackMetadata,
  ExtendedAudioStream,
  FadeTimers,
  FadingConfig,
  FadingSection,
  FilterStateEntry,
  FiltersState,
  FilterTransitionsConfig,
  LyricsLine,
  LyricsPayload,
  NodeLink,
  PlayerOptions,
  PlayerPluginInfo,
  PlayerStateJSON,
  PlayerTrack,
  PlayerVoiceState,
  PlayPayload,
  Session,
  StreamInfo,
  TrackFormat,
  TrackInfoExtended,
  TrackKeyResult
} from '../typings/playback/player.types.ts'
import type { TrackUrlResult } from '../typings/sources/source.types.ts'
import { logger, makeRequest } from '../utils.ts'
import type {
  AutoMixDecision,
  AutoMixMode
} from './processing/automixController.ts'

export type GatewayEventName =
  (typeof GatewayEvents)[keyof typeof GatewayEvents]
export type EndReason = (typeof EndReasons)[keyof typeof EndReasons]

let createAudioResource: CreateAudioResource | null = null
let createSeekeableAudioResource: CreateSeekeableAudioResource | null = null
const env = process.env as NodeJS.ProcessEnv & {
  NODELINK_TRACK_FINISH_MEMORY_TRACE?: string
  NODELINK_TRACK_FINISH_FORCE_GC?: string
}
const trackFinishMemoryTraceEnabled =
  env.NODELINK_TRACK_FINISH_MEMORY_TRACE?.toLowerCase() === 'true'
const trackFinishForceGcEnabled =
  env.NODELINK_TRACK_FINISH_FORCE_GC?.toLowerCase() === 'true'

async function getStreamProcessor(): Promise<void> {
  if (createAudioResource && createSeekeableAudioResource) return

  const processor = await import('./processing/streamProcessor.ts')
  createAudioResource = processor.createAudioResource as CreateAudioResource
  createSeekeableAudioResource =
    processor.createSeekeableAudioResource as CreateSeekeableAudioResource
}

let _automixModule: typeof import('./processing/automixController.ts') | null =
  null
async function getAutomixController() {
  if (_automixModule) return _automixModule.default
  _automixModule = await import('./processing/automixController.ts')
  return _automixModule.default
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAutoMixMode(mode: string | undefined): AutoMixMode {
  switch (mode) {
    case 'fusion':
    case 'dj_fx':
    case 'radio':
    case 'turntable':
      return mode
    default:
      return 'smart'
  }
}

/**
 * Core audio player responsible for voice connection management, stream handling,
 * filter application, fading, lyrics synchronization, mix layers, and stuck-track recovery.
 *
 * @remarks
 * - Establishes and monitors the Discord voice connection via @performanc/voice.
 * - Fetches stream URLs from sources, builds audio resources, and handles gapless playback.
 * - Applies filters, fading, loudness normalization, and PCM mixing through AudioMixer.
 * - Manages lyrics subscription, timing, and drift correction for synced events.
 * - Emits gateway events for all lifecycle transitions (start, end, pause, seek, exceptions).
 */
export class Player {
  private readonly nodelink: NodeLink
  private readonly session: Session
  public readonly guildId: string

  private track: PlayerTrack | null = null
  private holoTrack: PlayerTrack | null = null
  private nextTrack: PlayerTrack | null = null
  private nextResource: AudioResource | null = null
  private nextStreamInfo: StreamInfo = null
  private nextCrossfadeTrack: PlayerTrack | null = null
  private nextCrossfadeResource: AudioResource | null = null
  private nextCrossfadePcm: AudioResource | null = null
  private nextCrossfadeStreamInfo: StreamInfo = null
  public isPaused = false
  public volumePercent: number
  public filters: FiltersState = {}
  public position = 0
  public connStatus: VoiceConnectionState['status'] = 'disconnected'
  public connection: VoiceConnection | null = null
  public voice: PlayerVoiceState = {
    sessionId: null,
    token: null,
    endpoint: null,
    channelId: null
  }
  public streamInfo: StreamInfo = null
  public profilerStreamStats: {
    downloadedBytes: number
    totalBytes: number | null
    lastChunkAt: number | null
  } = {
    downloadedBytes: 0,
    totalBytes: null,
    lastChunkAt: null
  }
  public lastManualReconnect = 0
  public audioMixer: AudioMixer | null = null
  public fading?: FadingConfig
  public crossfade?: CrossfadeConfig
  public loudnessNormalizer: boolean
  private _fadeTimers: FadeTimers = { trackEnd: null, pause: null, stop: null }
  private _crossfadeTimer: NodeJS.Timeout | null = null
  private _silenceWatchdog: NodeJS.Timeout | null = null
  private _crossfadeEndTimer: NodeJS.Timeout | null = null
  private _crossfadeCompletionWatcher: NodeJS.Timeout | null = null
  private _crossfadeCompletionDeadline = 0
  private _crossfadeEndsAt = 0
  private _crossfadeCompletionRemainingMs = 0
  private _crossfadeCompletionContext: {
    token: number
    previousTrack: PlayerTrack
    startPositionMs: number
    endPositionMs: number
  } | null = null
  private _crossfadeCompleting = false
  private _crossfadeIgnoreIdle = false
  private _crossfadeBlendStartedAt = 0
  private _preAutomixFilters: Record<string, unknown> | null = null
  private _automixPreLeadTimer: NodeJS.Timeout | null = null
  private _pendingTriggerAutomix: (() => void) | null = null
  private _automixDeezerCache = new Map<
    string,
    {
      bpm: number | null
      gain: number | null
      expiresAt: number
    }
  >()
  private _preAutomixUserVolume: number | undefined
  private _crossfadeToken = 0
  private _crossfadePrepared = false
  private _crossfadeStartRetryToken = 0
  private _crossfadeStartRetryCount = 0
  private _isResuming = false
  private _pendingTrackStartFade = false
  private _pendingPreload: PlayerTrack | null = null
  private _ignoreIdleStoppedUntil = 0
  private _lastStaleBridgeStarvationLogAt = 0
  private _lyricsBasePosition = 0
  private _lyricsBasePackets = 0
  private _lyricsMarkerTimer: NodeJS.Timeout | null = null
  private _audioMixerInitPromise: Promise<void> | null = null

  public isLyricsSubscribed = false
  public currentLyrics: LyricsPayload | null = null
  public lyricsLineIndex = -1
  public skipTrackSource = false

  public emitEvent: (
    type: GatewayEventName | string,
    payload?: Record<string, unknown>
  ) => void
  public waitEvent: <T>(
    event: string,
    filter?: (payload: T) => boolean,
    timeout?: number
  ) => Promise<T>

  private _lastPosition = 0
  private _stuckTime = 0
  private _lastStreamDataTime = 0
  private _lastCrossfadeCompletedAt = 0
  private _isRecovering = false
  public destroying = false
  public isUpdatingTrack = false
  private _isRestoring = false
  private _isSeeking = false
  private _isStopping = false

  constructor(options: PlayerOptions) {
    if (
      !options.nodelink ||
      !options.session?.socket ||
      !options.session.userId ||
      !options.guildId
    ) {
      throw new Error('Missing required options')
    }

    this.nodelink = options.nodelink
    this.session = options.session
    this.guildId = options.guildId
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
    this.fading = this.nodelink.options?.audio?.fading
    this.crossfade = this.nodelink.options?.audio?.crossfade
    this.loudnessNormalizer =
      this.nodelink.options?.audio?.loudnessNormalizer ?? false

    logger(
      'debug',
      'Player',
      `New player created for guild ${this.guildId} in session ${this.session.id}`
    )

    this.emitEvent = (type, payload = {}) => {
      this.nodelink.statsManager.incrementPlaybackEvent(type)
      const eventData = JSON.stringify({
        op: 'event',
        type,
        guildId: this.guildId,
        ...payload
      })

      if (this.session.isPaused) {
        this.session.eventQueue.push(eventData)
        logger(
          'debug',
          'Player',
          `Queued event ${type} for paused session ${this.session.id}`
        )
        return
      }

      try {
        this.session.socket.send(eventData)
      } catch {}
    }

    this.emitEvent(GatewayEvents.PLAYER_CREATED, {
      guildId: this.guildId,
      player: this.toJSON()
    })

    this.waitEvent = (
      event,
      filter,
      timeout = this.nodelink.options.eventTimeoutMs ?? 15000
    ) =>
      new Promise((resolve, reject) => {
        const handler = (_: unknown, payload: unknown) => {
          const typedPayload = payload as unknown as Record<string, unknown>
          if (!filter || filter(typedPayload as never)) {
            clearTimeout(timeoutId)
            this.connection?.off(event, handler)
            resolve(typedPayload as never)
          }
        }

        const timeoutId = setTimeout(() => {
          this.connection?.off(event, handler)
          reject(
            new Error(
              `Event ${event} timed out after ${timeout}ms for guild ${this.guildId}`
            )
          )
        }, timeout)

        this.connection?.on(event, handler)
      })
  }

  private _getAudioOptions(): AudioOptionsWithTransitions | undefined {
    return this.nodelink.options.audio as
      | AudioOptionsWithTransitions
      | undefined
  }

  private _getAutomixConfig(): AutomixConfig | undefined {
    return this._getAudioOptions()?.automix
  }

  private _getFilterTransitions(): FilterTransitionsConfig | undefined {
    return this._getAudioOptions()?.filterTransitions
  }

  private _getAudioStream(): ExtendedAudioStream | null {
    return (this.connection?.audioStream as ExtendedAudioStream | null) ?? null
  }

  private _getPluginInfo(track: PlayerTrack | null): PlayerPluginInfo {
    return (track?.pluginInfo || {}) as PlayerPluginInfo
  }

  /**
   * Whether the crossfade bridge is draining without any pending next track.
   *
   * In this state, stuck-recovery seek attempts can restart/loop playback near
   * the tail because the current stream is already finishing naturally.
   */
  private _isBridgeDrainWithoutPendingNext(): boolean {
    const audioStream = this._getAudioStream()
    const bridgeDraining =
      typeof audioStream?.isBridgeDraining === 'function' &&
      audioStream.isBridgeDraining()

    if (!bridgeDraining) return false

    const hasPendingNext = Boolean(
      this.nextCrossfadeTrack ||
        this.nextCrossfadePcm ||
        this.nextTrack ||
        this.nextResource ||
        this._pendingPreload
    )

    return !hasPendingNext
  }

  /**
   * Installs bridge-starvation rescue for the active crossfade token.
   *
   * The crossfade bridge can enter starvation when Track A ends before
   * crossfade initialization has started. This handler forces the pending
   * automix trigger (or direct crossfade fallback) immediately.
   */
  private _bindBridgeStarvationRescue(token: number): void {
    const crossfadeCtrl = this._getAudioStream()?.crossfadeController
    if (
      !crossfadeCtrl ||
      typeof crossfadeCtrl.onBridgeStarving === 'undefined'
    ) {
      return
    }

    const onBridgeStarving = () => {
      if (token !== this._crossfadeToken) {
        // This callback belongs to an older crossfade token. Detach it from
        // this controller to avoid starvation-spam loops on stale bridges.
        if (crossfadeCtrl.onBridgeStarving === onBridgeStarving) {
          crossfadeCtrl.onBridgeStarving = null
        }
        const now = Date.now()
        if (now - this._lastStaleBridgeStarvationLogAt > 1500) {
          this._lastStaleBridgeStarvationLogAt = now
          logger(
            'debug',
            'AutoMix',
            `Ignoring stale bridge starvation callback for guild ${this.guildId} (callback token: ${token}, current token: ${this._crossfadeToken})`
          )
        }
        return
      }

      logger(
        'warn',
        'AutoMix',
        `Bridge starvation rescue for guild ${this.guildId} — forcing transition start`
      )

      if (this._pendingTriggerAutomix) {
        const fn = this._pendingTriggerAutomix
        this._pendingTriggerAutomix = null
        fn()
        return
      }

      const crossfadeConfig = this._getCrossfadeConfig()
      if (
        crossfadeConfig &&
        this.track &&
        this.nextCrossfadeTrack &&
        this.nextCrossfadePcm
      ) {
        this._startCrossfade(token, crossfadeConfig.durationMs, crossfadeConfig)
        return
      }

      logger(
        'debug',
        'AutoMix',
        `Bridge starvation fallback for guild ${this.guildId}: no pending next track; draining bridge.`
      )

      this._getAudioStream()?.clearCrossfade?.()
    }

    crossfadeCtrl.onBridgeStarving = onBridgeStarving
  }

  /**
   * Initializes the audio mixer instance used for mix layers and fading.
   */
  private async _initAudioMixer(): Promise<void> {
    if (this.audioMixer) return

    const { AudioMixer: Mixer } = await import('./processing/AudioMixer.ts')
    this.audioMixer = new Mixer(
      this.nodelink.options?.mix ?? {
        enabled: true,
        defaultVolume: 0.8,
        maxLayersMix: 5,
        autoCleanup: true
      }
    ) as AudioMixer

    this.audioMixer.on('mixStarted', (data) => {
      this.emitEvent(GatewayEvents.MIX_STARTED, {
        mixId: data.id,
        track: data.track,
        volume: data.volume
      })
    })

    this.audioMixer.on('mixEnded', (data) => {
      this.emitEvent(GatewayEvents.MIX_ENDED, {
        mixId: data.id,
        reason: data.reason
      })
    })

    this.audioMixer.on('mixError', (data) => {
      const errorMessage = data.error ? data.error.message : 'Unknown mix error'
      logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`)
    })
  }

  /**
   * Ensures the audio mixer is initialized only once on demand.
   */
  private async _ensureAudioMixer(): Promise<void> {
    if (this.audioMixer) return
    if (!this._audioMixerInitPromise) {
      this._audioMixerInitPromise = this._initAudioMixer()
        .catch((err) => {
          this._audioMixerInitPromise = null
          throw err
        })
        .then(() => {
          this._audioMixerInitPromise = null
        })
    }
    await this._audioMixerInitPromise
  }

  /**
   * Establishes the voice connection and attaches event listeners.
   */
  private _initConnection(): void {
    if (this.connection || this.destroying) return
    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      channelId: this.voice.channelId || this.guildId,
      encryption: this.nodelink.options?.audio?.encryption ?? null
    })
    this.connection.on(
      'stateChange',
      (_: VoiceConnectionState | null, s: VoiceConnectionState) => {
        logger(
          'debug',
          'Player',
          `Voice connection state change for guild ${this.guildId} in session ${this.session.id}: ${s.status}`
        )
        this._onConn(s)
      }
    )
    this.connection.on(
      'playerStateChange',
      (_: VoicePlayerState | null, s: VoicePlayerState & { reason?: string }) =>
        this._onPlay(s)
    )
    this.connection.on('error', (err) => {
      logger(
        'error',
        'Player',
        `Voice connection error for guild ${this.guildId} in session ${this.session.id}:`,
        err
      )
      this._onError(err)
    })
    this.connection.on('audioStream', (audioStream: VoiceAudioStream) => {
      audioStream.on('data', () => {
        this._lastStreamDataTime = Date.now()
        if (this.isLyricsSubscribed && !this.isPaused && this.track) {
          this._syncLyrics()
        }
      })
    })

    if (this.nodelink.voiceRelay?.attach) {
      this.nodelink.voiceRelay.attach(this.connection, this.guildId)
    }
  }

  /**
   * Handles connection state transitions.
   */
  private _onConn(state: VoiceConnectionState): void {
    if (this.destroying) return
    this.connStatus = state.status
    if (state.status === 'connected') {
      logger(
        'info',
        'Player',
        `Voice connection established for guild ${this.guildId} in session ${this.session.id}`
      )
      this.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
        guildId: this.guildId,
        voice: { ...this.voice }
      })
      if (this.track && this.isPaused && this.connection?.audioStream) {
        this.isPaused = false
        this.connection.unpause?.('reconnected')
        logger(
          'debug',
          'Player',
          `Unpaused track on reconnection for guild ${this.guildId}`
        )
      }
    } else if (state.status === 'reconnecting') {
      logger(
        'info',
        'Player',
        `Voice connection is reconnecting for guild ${this.guildId}`
      )
      this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
        guildId: this.guildId,
        voice: { ...this.voice }
      })
    } else if (state.status === 'disconnected') {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: state.code,
        reason: state.closeReason,
        byRemote: true
      })
    } else if (state.status === 'destroyed') {
      logger(
        'warn',
        'Player',
        `Voice connection destroyed for guild ${this.guildId}`
      )
    }
    this._sendUpdate()
  }

  /**
   * Handles player state changes emitted by the voice connection.
   */
  private _onPlay(state: VoicePlayerState & { reason?: string }): void {
    if (this.destroying) return
    logger(
      'debug',
      'Player',
      `Player state change for guild ${this.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`
    )

    const endReason = state.reason as EndReason | undefined
    const endingReasons: EndReason[] = [
      EndReasons.STOPPED,
      EndReasons.FINISHED,
      EndReasons.LOAD_FAILED
    ]

    if (
      state.status === 'idle' &&
      endReason === EndReasons.STOPPED &&
      Date.now() < this._ignoreIdleStoppedUntil &&
      this._isResuming
    ) {
      logger(
        'debug',
        'Player',
        `Ignoring internal idle/stopped during stream swap for guild ${this.guildId}`
      )
      return
    }

    if (state.status === 'idle' && state.reason === 'stuck') {
      logger(
        'warn',
        'Player',
        `Track became stuck for guild ${this.guildId}. Triggering immediate recovery.`
      )
      this._stuckTime = this.nodelink.options.trackStuckThresholdMs + 1
      this._sendUpdate()
      return
    }

    if (state.status === 'idle' && this.isUpdatingTrack) {
      if (endReason === EndReasons.STOPPED) {
        logger(
          'debug',
          'Player',
          `Processing stop completion during track update for guild ${this.guildId}`
        )
      } else {
        logger(
          'debug',
          'Player',
          `Ignoring idle event during track replacement for guild ${this.guildId}. Reason: ${state.reason}`
        )
        return
      }
    }

    if (
      state.status === 'idle' &&
      this.track &&
      endReason &&
      endingReasons.includes(endReason)
    ) {
      if (
        this._crossfadeCompletionContext &&
        (state.reason === EndReasons.FINISHED ||
          state.reason === EndReasons.STOPPED)
      ) {
        const MIN_BLEND_WALL_MS = 2000
        const blendElapsed =
          this._crossfadeBlendStartedAt > 0
            ? Date.now() - this._crossfadeBlendStartedAt
            : 0
        if (blendElapsed < MIN_BLEND_WALL_MS) {
          logger(
            'debug',
            'Crossfade',
            `Ignoring premature idle:${state.reason} during crossfade for guild ${this.guildId} (blend elapsed: ${blendElapsed}ms)`
          )
          return
        }

        const context = this._crossfadeCompletionContext
        this._triggerCrossfadeCompletion(
          context.token,
          context.previousTrack,
          `idle:${state.reason}`
        )
        return
      }

      if (this._crossfadeIgnoreIdle && state.reason === EndReasons.FINISHED) {
        this._crossfadeIgnoreIdle = false
        return
      }
      if (
        state.reason === EndReasons.FINISHED &&
        this.nextResource &&
        this.nextTrack
      ) {
        let resource = this.nextResource

        if (this.nextCrossfadePcm === resource && createAudioResource) {
          if (!resource.stream) {
            this.stop()
            return
          }

          resource = createAudioResource(
            resource.stream as unknown as Readable,
            'pcm',
            this.nodelink,
            this.filters,
            this.volumePercent / 100,
            this.audioMixer,
            false,
            this.loudnessNormalizer
          )
          this.nextCrossfadePcm = null
          this.nextResource = resource
        }

        const nextTrack = this.nextTrack
        const nextStreamInfo = this.nextStreamInfo

        this._emitTrackEnd(EndReasons.GAPLESS)

        this.track = nextTrack
        this.nextTrack = null
        this.nextResource = null
        this.streamInfo = nextStreamInfo
        this.nextStreamInfo = null

        this.position = 0
        this._lyricsBasePosition = 0
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0

        this.connection?.play(resource as unknown)

        return
      }

      if (
        (this.isUpdatingTrack || this._isSeeking) &&
        state.reason === 'finished'
      ) {
        logger(
          'debug',
          'Player',
          `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.guildId}.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Track ended for guild ${this.guildId}. Reason: ${state.reason}. Current position: ${this._realPosition()}`
      )
      this._traceTrackFinishMemory('before-cleanup')
      this._cleanupCurrentAudioStream('track-end')

      this._emitTrackEnd(endReason)
      this._resetTrack()
      this._traceTrackFinishMemory('after-reset')
      this._scheduleTrackFinishGcProbe()
    } else if (
      state.status === 'playing' &&
      this.track &&
      !this._isSeeking &&
      (['requested', 'reconnected', 'seamless_bridge'].includes(
        state.reason ?? ''
      ) ||
        this._pendingTrackStartFade)
    ) {
      const wasResuming = this._isResuming
      this._isResuming = false
      this.isPaused = false

      if (wasResuming && state.reason !== 'seamless_bridge') {
        logger(
          'debug',
          'Crossfade',
          `Playback resumed; rearming crossfade/end schedule for guild ${this.guildId}`
        )
        this._resumeCrossfadeCompletionTimer()
        this._fading('trackEndSchedule', {
          startPosition: this._realPosition()
        })
      } else if (!this._isRestoring) {
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0
        this._fading('trackStart')
        this._emitTrackStart().catch((err) => this._onError(err))
      }
    } else if (state.status === 'paused') {
      this.isPaused = true
    }
  }

  /**
   * Handles playback errors and emits exception events.
   */
  private _onError(error: Error): void {
    if (this.destroying) return
    if (this.track) {
      let severity: string = 'fault'
      let cause = 'UNKNOWN_ERROR'
      let shouldStop = true
      logger(
        'debug',
        'Player',
        `Handling player error for guild ${this.guildId}: ${error.message}`
      )

      if (error.message.includes('ECONNRESET')) {
        const now = Date.now()
        const reconnectCooldown = 5000

        if (now - (this.lastManualReconnect || 0) < reconnectCooldown) {
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Manual reconnect on cooldown. Relying on library.`
          )
        } else {
          this.lastManualReconnect = now
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Attempting to manually reconnect.`
          )
          this.updateVoice(this.voice, true)
        }

        severity = 'suspicious'
        cause = 'VOICE_CONNECTION_RESET'
        shouldStop = false
      } else if (
        error.message.includes('stream') ||
        error.message.includes('timeout') ||
        error.name === 'AbortError'
      ) {
        logger(
          'warn',
          'Player',
          `Stream error detected for guild ${this.guildId}. Stopping playback.`
        )
        severity = 'common'
        cause = 'STREAM_ERROR'
        shouldStop = true
      } else if (error instanceof SeekError) {
        logger(
          'error',
          'Player',
          `Seek error for guild ${this.guildId}: ${error.message}. Stopping playback.`
        )
        severity = 'fault'
        cause = 'SEEK_ERROR'
        shouldStop = true
      } else {
        logger(
          'error',
          'Player',
          `Unhandled player error for guild ${this.guildId}:`,
          error
        )
        severity = 'fault'
        cause = `${error.name || 'Error'}: ${error.message}`
        shouldStop = true
      }

      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: error.message,
          severity: severity,
          cause: cause
        }
      })

      if (shouldStop) {
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        this.stop()
      }
    }
  }

  /**
   * Resets track and lyric state after a track ends.
   */
  private _resetTrack(): void {
    this._clearCrossfade()
    this._isStopping = false
    this._pendingPreload = null
    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
      this.nextStreamInfo = null
    }

    this.track = null
    this.holoTrack = null
    this.isPaused = false
    this.position = 0
    this.currentLyrics = null
    this.lyricsLineIndex = -1
    this._fading('reset')
    this._lyricsBasePosition = 0
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0
    if (this._lyricsMarkerTimer) {
      clearTimeout(this._lyricsMarkerTimer)
      this._lyricsMarkerTimer = null
    }
  }

  /**
   * Logs memory snapshot for track-finish diagnostics when enabled.
   */
  private _traceTrackFinishMemory(stage: string): void {
    if (!trackFinishMemoryTraceEnabled) return
    const m = process.memoryUsage()
    const toMB = (value: number): string => (value / 1024 / 1024).toFixed(2)
    logger(
      'debug',
      'Player',
      `[MEM][TrackFinish][${this.guildId}] ${stage} rss=${toMB(m.rss)}MB heapUsed=${toMB(
        m.heapUsed
      )}MB heapTotal=${toMB(m.heapTotal)}MB external=${toMB(m.external)}MB arrayBuffers=${toMB(
        m.arrayBuffers
      )}MB`
    )
  }

  /**
   * Destroys and dereferences current audio stream to avoid lingering references.
   */
  private _cleanupCurrentAudioStream(context: string): void {
    const conn = this.connection as
      | (VoiceConnection & { audioStream?: VoiceAudioStream | null })
      | null
      | undefined
    const audioStream = conn?.audioStream as
      | (AudioResource & { destroyed?: boolean })
      | undefined
      | null

    if (!audioStream) return

    try {
      audioStream.destroy?.()
    } catch (err) {
      logger(
        'debug',
        'Player',
        `Failed to destroy audio stream during ${context} for guild ${this.guildId}: ${
          (err as Error)?.message ?? String(err)
        }`
      )
    }

    if (conn) conn.audioStream = null
  }

  /**
   * Optionally runs forced GC after finish for leak diagnostics.
   */
  private _scheduleTrackFinishGcProbe(): void {
    if (!trackFinishForceGcEnabled) return
    const gcFn = global.gc
    if (typeof gcFn !== 'function') return

    const timer = setTimeout(() => {
      try {
        gcFn()
        gcFn()
      } catch {}
      this._traceTrackFinishMemory('after-gc')
    }, 0)
    timer.unref?.()
  }

  /**
   * Emits TRACK_START and related events after resolving Holo tracks.
   */
  private async _emitTrackStart(): Promise<void> {
    const trackToEmit = await this._resolveTrackForEvent(this.track)
    this.holoTrack = trackToEmit

    const format = this.streamInfo?.format
    const playingQuality =
      format && typeof format === 'object' && 'itag' in format
        ? ((format as { itag?: number }).itag ?? null)
        : null

    this.emitEvent(GatewayEvents.TRACK_START, {
      track: trackToEmit,
      playingQuality
    })

    if (trackToEmit?.info?.sourceName === 'eternalbox') {
      const info = trackToEmit.info
      const pluginInfo = (trackToEmit.pluginInfo ?? {}) as {
        spotify?: { url?: string }
        analysisUrl?: string | null
        streamUrl?: string | null
        ogAudioSource?: string | null
        service?: string | null
        analysisSummary?: string | null
      }
      const spotify = pluginInfo.spotify
      const links = {
        jukeboxPage: `https://eternalboxmirror.xyz/jukebox_go.html?id=${info.identifier}`,
        analysisUrl: pluginInfo.analysisUrl || null,
        streamUrl: pluginInfo.streamUrl || null,
        ogAudioSource: pluginInfo.ogAudioSource || null,
        spotifyUrl: spotify?.url || info.uri || null
      }

      this.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
        track: trackToEmit,
        eternalbox: {
          id: info.identifier,
          service: pluginInfo.service || null,
          analysisSummary: pluginInfo.analysisSummary || null,
          spotify: pluginInfo.spotify || null,
          links
        }
      })
    }

    if (this.isLyricsSubscribed) {
      await this._loadLyrics()
    }
  }

  /**
   * Emits TRACK_END event and cleans up mixer layers.
   */
  private _emitTrackEnd(
    reason: EndReason,
    extra: Record<string, unknown> = {}
  ): void {
    const trackToEmit = this.holoTrack || this.track
    this.emitEvent(GatewayEvents.TRACK_END, {
      track: trackToEmit,
      reason: reason,
      ...extra
    })

    if (this.audioMixer?.autoCleanup) {
      this.audioMixer.clearLayers('MAIN_ENDED')
    }
  }

  /**
   * Normalizes the crossfade configuration.
   *
   * @remarks
   * Returns null when crossfade is disabled or the duration is invalid.
   */
  private _getCrossfadeConfig(): {
    enabled: boolean
    durationMs: number
    curve: string
    mode: CrossfadeMode
    minBufferMs: number
    bufferMs: number
  } | null {
    const config = this.crossfade
    if (!config || config.enabled !== true) return null

    const durationMs =
      Number.isFinite(config.duration) && (config.duration as number) > 0
        ? Math.max(0, config.duration as number)
        : 0
    if (durationMs <= 0) return null

    const curve = typeof config.curve === 'string' ? config.curve : 'sinusoidal'
    const mode: CrossfadeMode = config.mode === 'stream' ? 'stream' : 'preload'
    const minBufferMs =
      Number.isFinite(config.minBufferMs) && (config.minBufferMs as number) > 0
        ? Math.max(0, config.minBufferMs as number)
        : durationMs
    const bufferMs =
      Number.isFinite(config.bufferMs) && (config.bufferMs as number) > 0
        ? Math.max(minBufferMs, config.bufferMs as number)
        : durationMs

    const SCAN_AHEAD_MS = 20_000
    const effectiveBufferMs = Math.max(bufferMs, durationMs + SCAN_AHEAD_MS)

    return {
      enabled: true,
      durationMs,
      curve,
      mode,
      minBufferMs,
      bufferMs: effectiveBufferMs
    }
  }

  private _normalizeIsrc(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().replace(/-/g, '').toUpperCase()
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null
  }

  private async _ensureAutomixDeezerMetadata(
    track: PlayerTrack | null,
    deezerMetadataCfg: DeezerMetadataConfig | undefined
  ): Promise<void> {
    if (!track || deezerMetadataCfg?.enabled !== true) return

    const pluginInfo = this._getPluginInfo(track)
    const existingMeta = (pluginInfo.deezer || pluginInfo.deezerMetadata) as
      | DeezerTrackMetadata
      | undefined

    const hasBpm = Number.isFinite(Number(existingMeta?.bpm))
    const hasGain = Number.isFinite(Number(existingMeta?.gain))
    const needsBpm = deezerMetadataCfg.useBpm !== false && !hasBpm
    const needsGain = deezerMetadataCfg.useGain !== false && !hasGain
    if (!needsBpm && !needsGain) return

    const isrc = this._normalizeIsrc(track.info?.isrc)
    if (!isrc) return

    const now = Date.now()
    const cached = this._automixDeezerCache.get(isrc)
    if (cached && cached.expiresAt > now) {
      const merged = {
        ...(existingMeta || {}),
        bpm: cached.bpm,
        gain: cached.gain
      }
      track.pluginInfo = {
        ...pluginInfo,
        deezer: merged
      }
      return
    }

    const requestTimeoutMs = deezerMetadataCfg.requestTimeoutMs
    const timeout =
      typeof requestTimeoutMs === 'number' &&
      Number.isInteger(requestTimeoutMs) &&
      requestTimeoutMs > 0
        ? requestTimeoutMs
        : 2500

    try {
      const { body, error } = await makeRequest(
        `https://api.deezer.com/2.0/track/isrc:${isrc}`,
        {
          method: 'GET',
          timeout
        }
      )
      const deezerBody = body as DeezerApiTrackResponse

      if (error || deezerBody?.error) return

      const bpm = Number(deezerBody?.bpm)
      const gain = Number(deezerBody?.gain)
      const normalized = {
        bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
        gain: Number.isFinite(gain) ? gain : null
      }

      logger(
        'debug',
        'AutoMix',
        `Deezer metadata for ISRC ${isrc}: BPM=${normalized.bpm ?? 'N/A'}, gain=${normalized.gain ?? 'N/A'}`
      )

      this._automixDeezerCache.set(isrc, {
        ...normalized,
        expiresAt: now + 6 * 60 * 60 * 1000
      })

      track.pluginInfo = {
        ...pluginInfo,
        deezer: {
          ...(existingMeta || {}),
          ...normalized
        }
      }
    } catch {}
  }

  private async _primeAutomixMetadata(
    trackA: PlayerTrack | null,
    trackB: PlayerTrack | null,
    deezerMetadataCfg: DeezerMetadataConfig | undefined
  ): Promise<void> {
    if (deezerMetadataCfg?.enabled !== true) return
    await Promise.all([
      this._ensureAutomixDeezerMetadata(trackA, deezerMetadataCfg),
      this._ensureAutomixDeezerMetadata(trackB, deezerMetadataCfg)
    ])
  }

  private _getAutomixLiveSignals(
    stream?: ExtendedAudioStream | null
  ): {
    liveBpmA?: number
    liveBpmB?: number
    liveBpmAConfidence?: number
    liveBpmBConfidence?: number
  } {
    const audioStream = stream ?? this._getAudioStream()
    if (!audioStream) return {}

    const beatA = audioStream.getRealtimeBeatState?.() ?? null
    const beatB = audioStream.getNextTrackBeatState?.() ?? null
    const bpmA = audioStream.getMainTrackBpm?.() ?? null
    const bpmB = audioStream.getNextTrackBpm?.() ?? null

    const liveBpmA = Number.isFinite(bpmA) && (bpmA as number) > 0
      ? Number(bpmA)
      : undefined
    const liveBpmB = Number.isFinite(bpmB) && (bpmB as number) > 0
      ? Number(bpmB)
      : undefined

    const liveBpmAConfidence = beatA
      ? Math.max(0, Math.min(1, beatA.confidence))
      : liveBpmA != null
        ? 0.55
        : undefined
    const liveBpmBConfidence = beatB
      ? Math.max(0, Math.min(1, beatB.confidence))
      : liveBpmB != null
        ? 0.50
        : undefined

    return {
      liveBpmA,
      liveBpmB,
      liveBpmAConfidence,
      liveBpmBConfidence
    }
  }

  /**
   * Triggers an immediate crossfade to the preloaded next track.
   * Useful for manual "/automix start" bot commands.
   *
   * @param durationMs - Optional override for crossfade duration.
   * @returns True if crossfade started, false otherwise.
   */
  public async triggerCrossfade(durationMs?: number): Promise<boolean> {
    if (!this.track || !this.nextCrossfadeTrack || !this.nextCrossfadePcm) {
      logger(
        'warn',
        'Crossfade',
        `Cannot trigger crossfade manually for guild ${this.guildId} (missing next track buffer)`
      )
      return false
    }

    const config = this._getCrossfadeConfig()
    if (!config) {
      logger(
        'warn',
        'Crossfade',
        `Cannot trigger crossfade manually for guild ${this.guildId} (crossfade is disabled)`
      )
      return false
    }

    if (this._crossfadeTimer) {
      clearTimeout(this._crossfadeTimer)
      this._crossfadeTimer = null
    }

    const automixConfig = this._getAutomixConfig()
    let automixDecision: AutoMixDecision | null = null
    if (automixConfig?.enabled) {
      try {
        await this._primeAutomixMetadata(
          this.track,
          this.nextCrossfadeTrack,
          automixConfig.deezerMetadata
        )
        const Controller = await getAutomixController()
        const audioStream = this._getAudioStream()
        const energy = audioStream?.getMainEnergy?.()
        const bEnergy = audioStream?.getNextTrackOpeningEnergy?.() ?? 0
        automixDecision = Controller.analyze(
          this.track,
          this.nextCrossfadeTrack,
          durationMs || config.durationMs,
          normalizeAutoMixMode(automixConfig.mode),
          {
            deezerMetadata: automixConfig.deezerMetadata,
            trackAEnergy: energy?.rms,
            trackBOpeningEnergy: bEnergy,
            ...this._getAutomixLiveSignals(audioStream)
          }
        )
      } catch (e) {
        logger(
          'warn',
          'AutoMix',
          `Failed to analyze manual crossfade: ${(e as Error).message}`
        )
      }
    }

    const token = ++this._crossfadeToken
    logger(
      'info',
      'Crossfade',
      `Manual crossfade triggered for guild ${this.guildId}`
    )
    this._startCrossfade(
      token,
      durationMs || config.durationMs,
      config,
      automixDecision
    )
    return true
  }

  /**
   * Clears any scheduled or active crossfade state.
   *
   * @param options - Controls which buffered resources to dispose.
   */
  private _clearCrossfade(
    options: { clearNext?: boolean; clearPcm?: boolean; force?: boolean } = {}
  ): void {
    const { clearNext = true, clearPcm = true, force = false } = options
    logger(
      'debug',
      'Crossfade',
      `Clearing crossfade for guild ${this.guildId}`,
      {
        clearNext,
        clearPcm,
        token: this._crossfadeToken
      }
    )
    if (force) this._pendingPreload = null
    if (this._crossfadeTimer) {
      clearTimeout(this._crossfadeTimer)
      this._crossfadeTimer = null
    }
    if (this._silenceWatchdog) {
      clearInterval(this._silenceWatchdog)
      clearTimeout(this._silenceWatchdog)
      this._silenceWatchdog = null
    }
    if (this._automixPreLeadTimer) {
      clearTimeout(this._automixPreLeadTimer)
      this._automixPreLeadTimer = null
    }
    this._pendingTriggerAutomix = null
    if (this._preAutomixFilters !== null) {
      if (force) {
        logger(
          'debug',
          'AutoMix',
          `Force-restoring pre-automix filters for guild ${this.guildId}`
        )
        this.filters = {
          ...this.filters,
          filters: { ...this._preAutomixFilters }
        } as FiltersState
      } else {
        logger(
          'debug',
          'AutoMix',
          `Restoring pre-automix filters for guild ${this.guildId}`
        )
        this.setFilters({ filters: this._preAutomixFilters } as FiltersState)
      }
    }
    this._preAutomixFilters = null
    if (this._crossfadeEndTimer) {
      clearTimeout(this._crossfadeEndTimer)
      this._crossfadeEndTimer = null
    }
    if (this._crossfadeCompletionWatcher) {
      clearInterval(this._crossfadeCompletionWatcher)
      this._crossfadeCompletionWatcher = null
    }
    this._crossfadeCompletionDeadline = 0
    this._crossfadeEndsAt = 0
    this._crossfadeCompletionRemainingMs = 0
    this._crossfadeCompletionContext = null
    this._crossfadeCompleting = false
    this._crossfadeIgnoreIdle = false
    this._crossfadeBlendStartedAt = 0
    this._crossfadePrepared = false
    this._crossfadeStartRetryToken = 0
    this._crossfadeStartRetryCount = 0
    this._crossfadeToken += 1

    const audioStream = this._getAudioStream()

    const streamInBridge =
      !force &&
      ((typeof audioStream?.isBridgeDraining === 'function' &&
        audioStream.isBridgeDraining()) ||
        (typeof audioStream?.isBridgeMode === 'function' &&
          audioStream.isBridgeMode()))
    const crossfadeCtrl = audioStream?.crossfadeController
    if (crossfadeCtrl) {
      crossfadeCtrl.onBridgeDrained = null
      crossfadeCtrl.onBridgeStarving = null
    }
    if (force || (!this._crossfadeCompletionContext && !streamInBridge)) {
      audioStream?.clearCrossfade?.()
    }
    audioStream?.setIncomingGain?.(1.0)

    if (clearPcm && this.nextCrossfadePcm) {
      this.nextCrossfadePcm.destroy()
      this.nextCrossfadePcm = null
    }
    if (clearNext && this.nextCrossfadeResource) {
      this.nextCrossfadeResource.destroy()
      this.nextCrossfadeResource = null
    }
    if (clearNext) {
      this.nextCrossfadeTrack = null
      this.nextCrossfadeStreamInfo = null
    }
    logger('debug', 'Crossfade', `Crossfade cleared for guild ${this.guildId}`)
  }

  /**
   * Prepares the next track PCM buffer for crossfade.
   */
  private _prepareCrossfadeBuffer(config: {
    durationMs: number
    minBufferMs: number
    bufferMs: number
  }): void {
    if (this._crossfadePrepared) {
      logger(
        'debug',
        'Crossfade',
        `Crossfade buffer already prepared for guild ${this.guildId}`
      )
      return
    }
    const pcmResource = this.nextCrossfadePcm
    const audioStream = this._getAudioStream()
    if (!pcmResource?.stream || !audioStream?.prepareCrossfade) {
      logger(
        'debug',
        'Crossfade',
        `Crossfade buffer preparation skipped for guild ${this.guildId} (missing stream/hook)`
      )
      return
    }

    if (
      typeof audioStream?.isFlushed === 'function' &&
      audioStream.isFlushed()
    ) {
      logger(
        'debug',
        'Crossfade',
        `Crossfade buffer preparation skipped for guild ${this.guildId} (pipeline flushed)`
      )
      return
    }

    logger(
      'debug',
      'Crossfade',
      `Preparing crossfade buffer for guild ${this.guildId}`,
      {
        durationMs: config.durationMs,
        minBufferMs: config.minBufferMs,
        bufferMs: config.bufferMs
      }
    )

    const prepared = audioStream.prepareCrossfade(
      pcmResource.stream as unknown as Readable,
      {
        durationMs: config.durationMs,
        minBufferMs: config.minBufferMs,
        bufferMs: config.bufferMs
      }
    )
    if (!prepared) {
      logger(
        'warn',
        'Crossfade',
        `Crossfade buffer prepare failed for guild ${this.guildId}.`
      )
      return
    }
    this._crossfadePrepared = true
    logger(
      'debug',
      'Crossfade',
      `Crossfade buffer prepared for guild ${this.guildId}`
    )
  }

  /**
   * Arms or re-arms deferred completion for an active crossfade.
   */
  private _armCrossfadeCompletionTimer(delayMs: number): void {
    if (!this._crossfadeCompletionContext) return

    if (this._crossfadeCompletionWatcher) {
      clearInterval(this._crossfadeCompletionWatcher)
      this._crossfadeCompletionWatcher = null
    }

    const boundedDelay = Math.max(0, delayMs)
    this._crossfadeCompletionRemainingMs = boundedDelay
    this._crossfadeEndsAt = Date.now() + boundedDelay
    this._crossfadeCompletionDeadline =
      Date.now() + Math.max(4000, boundedDelay * 3, boundedDelay + 1500)
    logger(
      'debug',
      'Crossfade',
      `Armed crossfade completion timer for guild ${this.guildId}`,
      {
        delayMs: boundedDelay,
        endsAt: this._crossfadeEndsAt,
        deadline: this._crossfadeCompletionDeadline
      }
    )

    this._crossfadeCompletionWatcher = setInterval(() => {
      if (this.isPaused) return

      const context = this._crossfadeCompletionContext
      if (!context) {
        if (this._crossfadeCompletionWatcher) {
          clearInterval(this._crossfadeCompletionWatcher)
          this._crossfadeCompletionWatcher = null
        }
        return
      }

      const audioStream = this._getAudioStream()
      const state = audioStream?.getCrossfadeState?.()
      const currentPosition = this._realPosition()
      const isPositionReached = currentPosition >= context.endPositionMs - 40

      const isBridgeReady =
        typeof audioStream?.isBridgeMode === 'function' &&
        audioStream.isBridgeMode()
      const isBlendComplete = state
        ? state.isFinished === true
        : isPositionReached
      const timedOut = Date.now() >= this._crossfadeCompletionDeadline

      const MIN_BLEND_WALL_MS = 2000
      const elapsedSinceBlend = Date.now() - this._crossfadeBlendStartedAt
      if (elapsedSinceBlend < MIN_BLEND_WALL_MS && !timedOut) return

      if (
        !(isPositionReached && (isBridgeReady || isBlendComplete)) &&
        !timedOut
      )
        return

      if (this._crossfadeCompletionWatcher) {
        clearInterval(this._crossfadeCompletionWatcher)
        this._crossfadeCompletionWatcher = null
      }
      this._crossfadeEndTimer = null
      this._crossfadeEndsAt = 0
      this._crossfadeCompletionRemainingMs = 0
      this._crossfadeCompletionDeadline = 0
      this._crossfadeCompletionContext = null

      if (timedOut && !(isBridgeReady || isBlendComplete)) {
        logger(
          'warn',
          'Crossfade',
          `Crossfade completion watchdog timed out for guild ${this.guildId}; forcing transition.`,
          {
            token: context.token,
            state,
            isBridgeReady,
            isBlendComplete,
            currentPosition,
            endPositionMs: context.endPositionMs
          }
        )
      } else {
        logger(
          'debug',
          'Crossfade',
          `Crossfade completion detected by stream state for guild ${this.guildId}`,
          {
            token: context.token,
            state,
            isBridgeReady,
            isBlendComplete,
            currentPosition,
            endPositionMs: context.endPositionMs
          }
        )
      }

      this._triggerCrossfadeCompletion(
        context.token,
        context.previousTrack,
        timedOut ? 'watchdog-timeout' : 'watchdog-state'
      )
    }, 50)
  }

  /**
   * Ensures crossfade completion is executed only once per transition.
   */
  private _triggerCrossfadeCompletion(
    token: number,
    previousTrack: PlayerTrack,
    source: string
  ): void {
    if (this._crossfadeCompleting) return
    this._crossfadeCompleting = true
    logger(
      'debug',
      'Crossfade',
      `Triggering crossfade completion for guild ${this.guildId} via ${source}`,
      { token, previousTrack: previousTrack.info.identifier }
    )
    this._completeCrossfade(token, previousTrack)
      .catch((err) => this._onError(err as Error))
      .finally(() => {
        this._crossfadeCompleting = false
      })
  }

  /**
   * Freezes crossfade completion while playback is paused.
   */
  private _pauseCrossfadeCompletionTimer(): void {
    if (!this._crossfadeCompletionContext || !this._crossfadeCompletionWatcher)
      return

    const remaining = Math.max(0, this._crossfadeEndsAt - Date.now())
    clearInterval(this._crossfadeCompletionWatcher)
    this._crossfadeCompletionWatcher = null
    this._crossfadeEndsAt = 0
    this._crossfadeCompletionRemainingMs = remaining
    this._crossfadeCompletionDeadline = 0
    logger(
      'debug',
      'Crossfade',
      `Paused crossfade completion timer for guild ${this.guildId}`,
      {
        remainingMs: remaining
      }
    )
  }

  /**
   * Resumes deferred crossfade completion once playback is active again.
   */
  private _resumeCrossfadeCompletionTimer(): void {
    if (
      !this._crossfadeCompletionContext ||
      this._crossfadeCompletionWatcher ||
      this.isPaused
    )
      return

    logger(
      'debug',
      'Crossfade',
      `Resuming crossfade completion timer for guild ${this.guildId}`,
      { delayMs: this._crossfadeCompletionRemainingMs || 1 }
    )
    this._armCrossfadeCompletionTimer(this._crossfadeCompletionRemainingMs || 1)
  }

  /**
   * Schedules a crossfade transition when possible.
   *
   * @param startPosition - Current playback position in milliseconds.
   */
  private _scheduleCrossfade(startPosition = 0): void {
    const config = this._getCrossfadeConfig()
    if (
      !config ||
      !this.track ||
      !this.nextCrossfadeTrack ||
      !this.nextCrossfadePcm
    )
      return

    logger(
      'info',
      'Crossfade',
      `Scheduling crossfade for guild ${this.guildId}`,
      {
        startPosition,
        durationMs: config.durationMs,
        mode: config.mode,
        curve: config.curve
      }
    )

    if (config.mode === 'preload' && this.track.info.isStream) {
      logger(
        'debug',
        'Crossfade',
        `Crossfade skipped for guild ${this.guildId} because track is a stream.`
      )
      return
    }

    const total =
      this.track.endTime && this.track.endTime > 0
        ? this.track.endTime
        : this.track.info.length || 0

    if (!Number.isFinite(total) || total <= 0) {
      if (config.mode !== 'stream') return
    }

    const durationMs = config.durationMs
    if (durationMs <= 0) return

    if (this._crossfadeCompletionContext) {
      logger(
        'debug',
        'Crossfade',
        `Crossfade scheduling deferred for guild ${this.guildId} (pipeline is transitioning).`
      )
      return
    }

    const currentAudioStream = this._getAudioStream()
    const _bridgeDrain =
      typeof currentAudioStream?.isBridgeDraining === 'function' &&
      currentAudioStream.isBridgeDraining()

    if (config.mode !== 'stream' && total > 0 && !_bridgeDrain) {
      const remaining = Math.max(0, total - startPosition)
      if (remaining < durationMs) {
        logger(
          'debug',
          'Crossfade',
          `Crossfade skipped for guild ${this.guildId} (remaining ${Math.round(
            remaining
          )}ms < ${durationMs}ms).`
        )
        if (this._crossfadePrepared) {
          currentAudioStream?.clearCrossfade?.()
          this._crossfadePrepared = false
        }
        return
      }
    }

    this._prepareCrossfadeBuffer({
      durationMs,
      minBufferMs: config.minBufferMs,
      bufferMs: config.bufferMs
    })

    if (this._crossfadeTimer) {
      clearTimeout(this._crossfadeTimer)
      this._crossfadeTimer = null
    }

    const delay =
      config.mode === 'stream' || _bridgeDrain
        ? 0
        : Math.max(0, Math.max(0, total - startPosition) - durationMs)
    this._crossfadeToken += 1
    const token = this._crossfadeToken
    this._crossfadeStartRetryToken = token
    this._crossfadeStartRetryCount = 0
    this._bindBridgeStarvationRescue(token)
    logger(
      'debug',
      'Crossfade',
      `Crossfade timer armed for guild ${this.guildId}`,
      {
        token,
        delayMs: delay
      }
    )

    let automixDecision: AutoMixDecision | null = null
    const automixConfig = this._getAutomixConfig()
    if (automixConfig?.enabled && this.track && this.nextCrossfadeTrack) {
      const trackA = this.track
      const trackB = this.nextCrossfadeTrack
      void this._primeAutomixMetadata(
        trackA,
        trackB,
        automixConfig.deezerMetadata
      )
        .then(() => getAutomixController())
        .then((Controller) => {
          if (this._crossfadeToken !== token) return
          const audioStream = this._getAudioStream()
          const energy = audioStream?.getMainEnergy?.()
          const bEnergy = audioStream?.getNextTrackOpeningEnergy?.() ?? 0
          automixDecision = Controller.analyze(
            trackA,
            trackB,
            durationMs,
            normalizeAutoMixMode(automixConfig.mode),
            {
              deezerMetadata: automixConfig.deezerMetadata,
              trackAEnergy: energy?.rms,
              trackBOpeningEnergy: bEnergy,
              ...this._getAutomixLiveSignals(audioStream)
            }
          )
          logger(
            'info',
            'AutoMix',
            `Decision for guild ${this.guildId}`,
            automixDecision
          )
        })
        .catch((e) =>
          logger(
            'warn',
            'AutoMix',
            `Failed to analyze: ${(e as Error).message}`
          )
        )
    }

    const ANALYSIS_WINDOW_MS = 120_000 // Start monitoring 120s before end
    const MIN_REMAINING_MS = 28_000 // Fallback at 28s remaining
    const SMART_ZONE_MS = 35_000 // Only trigger sensitive strategies in the last 35s
    const ENERGY_POLL_MS = 200 // Faster polling to catch beat anchors reliably
    const ENERGY_HISTORY_SIZE = 100 // 20 seconds of history (100 × 200ms)
    const ENERGY_DROP_RATIO = 0.5 // Trigger when energy < 50% of average (was 70% — too eager)
    const ENERGY_MATCH_TOLERANCE = 0.2 // Trigger when A is within 20% of B's energy (was 40%)
    const MIN_RMS_FLOOR = 0.015 // Ignore strategies if energy is below 1.5%

    const analysisWindowStart = Math.max(
      0,
      total - ANALYSIS_WINDOW_MS - startPosition
    )
    const fallbackDelay = Math.max(0, total - startPosition - MIN_REMAINING_MS)

    const triggerAutomix = (reason: string) => {
      if (this._crossfadeToken !== token) return

      this._pendingTriggerAutomix = null

      this._crossfadeIgnoreIdle = true

      if (this._silenceWatchdog) {
        clearInterval(this._silenceWatchdog)
        this._silenceWatchdog = null
      }
      if (this._automixPreLeadTimer) {
        clearTimeout(this._automixPreLeadTimer)
        this._automixPreLeadTimer = null
      }
      if (this._crossfadeTimer) {
        clearTimeout(this._crossfadeTimer)
        this._crossfadeTimer = null
      }

      if (!automixDecision || automixDecision.transition === 'gapless') {
        logger(
          'info',
          'AutoMix',
          `Triggering gapless for guild ${this.guildId} (${reason})`
        )
        this._startCrossfade(
          token,
          automixDecision?.transitionDurationMs ?? durationMs,
          config,
          automixDecision,
          reason
        )
        return
      }

      if (reason === 'bridge_starving') {
        const transitionMs = automixDecision.transitionDurationMs || 10000
        logger(
          'info',
          'AutoMix',
          `Triggering bridge-starving rescue for guild ${this.guildId} (skip preLeadMs, transitionMs=${transitionMs})`
        )
        this._startCrossfade(
          token,
          transitionMs,
          config,
          automixDecision,
          reason
        )
        return
      }

      let transitionMs = automixDecision.transitionDurationMs || 10000
      let preLeadMs = Math.min(5000, Math.round(transitionMs * 0.4))
      const fusionLikeTransition =
        automixDecision.transition === 'fusion_morph' ||
        automixDecision.transition === 'harmonic_weave'
      const fallbackFusion =
        reason.includes('fallback') && fusionLikeTransition

      if (fusionLikeTransition) {
        const fusionFloorMs =
          normalizeAutoMixMode(automixConfig?.mode) === 'fusion'
            ? 16000
            : 14000
        transitionMs = Math.max(transitionMs, fusionFloorMs)
      }

      const physicalEffectMs = Math.max(
        automixDecision.scratchA?.durationMs || 0,
        automixDecision.tapeStopA?.durationMs || 0
      )

      if (physicalEffectMs > 0) {
        preLeadMs = Math.max(
          Math.min(5000, Math.round(transitionMs * 0.6)), // min 60% transition if physical
          Math.min(
            Math.round(transitionMs * 0.85),
            Math.round(physicalEffectMs * 0.8) // start blend at 80% mark
          )
        )
        preLeadMs = Math.max(1200, preLeadMs)
      }

      if (fallbackFusion) {
        transitionMs = Math.max(transitionMs, 13500)
        preLeadMs = Math.max(preLeadMs, Math.round(transitionMs * 0.52), 4800)
      } else if (fusionLikeTransition) {
        preLeadMs = Math.max(preLeadMs, Math.round(transitionMs * 0.46), 3600)
      }

      // Smoother filter ramps: filters should reach their target at the END of the blend,
      // not early. This preserves energy during the transition.
      const filterRampMs = Math.round(preLeadMs + transitionMs * 0.95)

      logger(
        'info',
        'AutoMix',
        `Triggering "${automixDecision.transition}" for guild ${this.guildId} (${reason})`,
        {
          transitionMs,
          preLeadMs,
          filterRampMs
        }
      )

      const audioStream = this._getAudioStream()
      if (typeof audioStream?.startShowcaseRecording === 'function') {
        audioStream.startShowcaseRecording(
          10000,
          preLeadMs + transitionMs,
          10000,
          automixDecision.transition
        )
      }

      const currentFiltersPayload = this.filters.filters as
        | Record<string, unknown>
        | undefined
      this._preAutomixFilters = currentFiltersPayload
        ? JSON.parse(JSON.stringify(currentFiltersPayload))
        : {}

      const preLeadFilters: Record<string, unknown> & {
        lowpass?: Record<string, unknown>
        highpass?: Record<string, unknown>
        echo?: Record<string, unknown>
        reverb?: Record<string, unknown>
        timescale?: Record<string, unknown>
        karaoke?: Record<string, unknown>
        phaser?: Record<string, unknown>
        tremolo?: Record<string, unknown>
      } = {
        ...((this.filters.filters as Record<string, unknown>) || {})
      }
      if (automixDecision.lowpassA) {
        preLeadFilters.lowpass = {
          smoothing: automixDecision.lowpassA.smoothing,
          transition: {
            durationMs: filterRampMs,
            curve: 'sinusoidal'
          }
        }
      }
      if (automixDecision.highpassA) {
        preLeadFilters.highpass = {
          smoothing: automixDecision.highpassA.smoothing,
          transition: {
            durationMs: filterRampMs,
            curve: 'sinusoidal'
          }
        }
      }
      if (automixDecision.echoA) {
        const { rampMs: _echoRamp, ...echoParams } = automixDecision.echoA
        preLeadFilters.echo = {
          ...echoParams,
          ...(automixDecision.echoA.rampMs
            ? {
                transition: {
                  durationMs: automixDecision.echoA.rampMs,
                  curve: 'sinusoidal'
                }
              }
            : {})
        }
      }
      if (automixDecision.reverbA) {
        const { rampMs: _reverbRamp, ...reverbParams } = automixDecision.reverbA
        preLeadFilters.reverb = {
          ...reverbParams,
          ...(automixDecision.reverbA.rampMs
            ? {
                transition: {
                  durationMs: automixDecision.reverbA.rampMs,
                  curve: 'sinusoidal'
                }
              }
            : {})
        }
      }
      if (automixDecision.timescaleA?.speed) {
        const currentTimescale =
          (this.filters.filters?.timescale as
            | Record<string, unknown>
            | undefined) || {}
        preLeadFilters.timescale = {
          ...currentTimescale,
          speed: automixDecision.timescaleA.speed,
          ...(automixDecision.timescaleA.pitch != null
            ? { pitch: automixDecision.timescaleA.pitch }
            : {}),
          transition: {
            durationMs: automixDecision.timescaleA.durationMs || preLeadMs,
            curve: automixDecision.timescaleA.curve || 'sinusoidal'
          }
        }
      }
      if (automixDecision.karaokeA) {
        const { rampMs: _karaokeRamp, ...karaokeParams } =
          automixDecision.karaokeA
        preLeadFilters.karaoke = {
          ...karaokeParams,
          ...(automixDecision.karaokeA.rampMs
            ? {
                transition: {
                  durationMs: automixDecision.karaokeA.rampMs,
                  curve: 'sinusoidal'
                }
              }
            : {})
        }
      }
      if (automixDecision.phaserA) {
        const { rampMs: _phaserRamp, ...phaserParams } = automixDecision.phaserA
        preLeadFilters.phaser = {
          ...phaserParams,
          ...(automixDecision.phaserA.rampMs
            ? {
                transition: {
                  durationMs: automixDecision.phaserA.rampMs,
                  curve: 'sinusoidal'
                }
              }
            : {})
        }
      }
      if (automixDecision.tremoloA) {
        const { rampMs: _tremoloRamp, ...tremoloParams } =
          automixDecision.tremoloA
        preLeadFilters.tremolo = {
          ...tremoloParams,
          ...(automixDecision.tremoloA.rampMs
            ? {
                transition: {
                  durationMs: automixDecision.tremoloA.rampMs,
                  curve: 'sinusoidal'
                }
              }
            : {})
        }
      }
      this.setFilters({ filters: preLeadFilters } as FiltersState, true)

      const activeStreamForPreLead = this._getAudioStream()
      this._preAutomixUserVolume = undefined
      if (typeof activeStreamForPreLead?.setFadeVolume === 'function') {
        if (
          typeof this.volumePercent === 'number' &&
          this.volumePercent !== 100
        ) {
          this._preAutomixUserVolume = this.volumePercent
        }
        activeStreamForPreLead.setFadeVolume(1.0)
      }
      if (typeof activeStreamForPreLead?.setFilterBypass === 'function') {
        activeStreamForPreLead.setFilterBypass(false)
      }

      const audioStreamForEffects = this._getAudioStream()
      if (automixDecision.tapeStopA && audioStreamForEffects?.tapeTo) {
        const tapeDuration = Math.round(automixDecision.tapeStopA.durationMs)
        audioStreamForEffects.tapeTo(
          tapeDuration,
          'stop',
          automixDecision.tapeStopA.curve || 'sinusoidal'
        )
        logger(
          'info',
          'AutoMix',
          `Pre-lead: tape stop (${tapeDuration}ms, ${automixDecision.tapeStopA.curve || 'sinusoidal'}) for guild ${this.guildId}`
        )
      }
      if (automixDecision.scratchA && audioStreamForEffects?.scratchTo) {
        const scratchDuration = Math.round(automixDecision.scratchA.durationMs)
        audioStreamForEffects.scratchTo(
          scratchDuration,
          automixDecision.scratchA.style
        )
        logger(
          'info',
          'AutoMix',
          `Pre-lead: scratch ${automixDecision.scratchA.style} (${scratchDuration}ms) for guild ${this.guildId}`
        )
      }

      const hasPhysicalPreLead = !!(
        automixDecision.tapeStopA || automixDecision.scratchA
      )
      if (
        hasPhysicalPreLead &&
        typeof audioStreamForEffects?.fadeTo === 'function'
      ) {
        if (typeof audioStreamForEffects.setFadeVolume === 'function') {
          audioStreamForEffects.setFadeVolume(1.0)
        }
        audioStreamForEffects.fadeTo(0.0, preLeadMs, 'exponential')
      }

      const blendMs = hasPhysicalPreLead
        ? Math.min(transitionMs, 3000)
        : transitionMs
      this._automixPreLeadTimer = setTimeout(() => {
        if (this._crossfadeToken !== token) return
        logger(
          'info',
          'Crossfade',
          `Crossfade blend starting for guild ${this.guildId}`,
          {
            token,
            transitionMs: blendMs
          }
        )
        this._startCrossfade(token, blendMs, config, automixDecision, reason)
        if (
          this._preAutomixUserVolume !== undefined &&
          typeof this.volume === 'function'
        ) {
          this.volume(this._preAutomixUserVolume)
          this._preAutomixUserVolume = undefined
        }
      }, preLeadMs)
    }

    this._pendingTriggerAutomix = () => {
      if (this._crossfadeToken !== token) return
      triggerAutomix('bridge_starving')
    }

    if (automixConfig?.enabled && total > 0 && !this.track?.info.isStream) {
      const energyHistory: number[] = []
      let triggered = false
      let trackBEnergy = 0
      let prevSlope = 0 // For derivative tracking
      let steadyCount = 0 // For plateau detection

      const patienceMs = 8000 + Math.round(Math.random() * 12000)
      const effectivePatienceMs = Math.min(
        patienceMs,
        Math.max(3000, fallbackDelay - 1500)
      )

      const windowDelay = Math.max(0, analysisWindowStart)
      this._silenceWatchdog = setTimeout(() => {
        if (this._crossfadeToken !== token) return

        const audioStream = this._getAudioStream()
        trackBEnergy = audioStream?.getNextTrackOpeningEnergy?.() ?? 0

        logger(
          'info',
          'AutoMix',
          `Analysis window open for guild ${this.guildId}`,
          {
            trackBOpeningEnergy: `${(trackBEnergy * 100).toFixed(1)}%`
          }
        )

        const initialLiveSignals = this._getAutomixLiveSignals(audioStream)
        let bpmFallbackTriggered = Boolean(
          initialLiveSignals.liveBpmA || initialLiveSignals.liveBpmB
        )
        if (bpmFallbackTriggered) {
          logger(
            'info',
            'AutoMix',
            `Live tempo signals ready for guild ${this.guildId} (A: ${initialLiveSignals.liveBpmA?.toFixed(1) ?? 'N/A'}, B: ${initialLiveSignals.liveBpmB?.toFixed(1) ?? 'N/A'})`
          )
        }

        let keyA: TrackKeyResult | null =
          audioStream?.getMainTrackKey?.() ?? null
        let keyB: TrackKeyResult | null =
          audioStream?.getNextTrackKey?.() ?? null
        if (keyA) {
          logger(
            'info',
            'AutoMix',
            `Key for Track A [${this.track?.info.title}]: ${keyA.key} (${keyA.camelot}, confidence: ${(keyA.confidence * 100).toFixed(0)}%)`
          )
        }
        if (keyB) {
          logger(
            'info',
            'AutoMix',
            `Key for Track B [${this.nextCrossfadeTrack?.info.title}]: ${keyB.key} (${keyB.camelot}, confidence: ${(keyB.confidence * 100).toFixed(0)}%)`
          )
        }

        if (
          (trackBEnergy > 0 || bpmFallbackTriggered || keyA || keyB) &&
          automixDecision &&
          this.track &&
          this.nextCrossfadeTrack
        ) {
          const currentTrack = this.track
          const queuedTrack = this.nextCrossfadeTrack
          const currentDecision = automixDecision
          if (!currentDecision) return
          void getAutomixController()
            .then((Controller) => {
              if (this._crossfadeToken !== token) return
              const energy = this._getAudioStream()?.getMainEnergy?.()
              const refined = Controller.analyze(
                currentTrack,
                queuedTrack,
                durationMs,
                normalizeAutoMixMode(automixConfig.mode),
                {
                  deezerMetadata: automixConfig.deezerMetadata,
                  trackAEnergy: energy?.rms,
                  trackBOpeningEnergy: trackBEnergy,
                  keyA,
                  keyB,
                  ...this._getAutomixLiveSignals(this._getAudioStream())
                }
              )
              if (refined.transition !== currentDecision.transition) {
                logger(
                  'info',
                  'AutoMix',
                  `Decision refined with Track B energy for guild ${this.guildId}: ${currentDecision.transition} → ${refined.transition}`
                )
              }
              automixDecision = refined
            })
            .catch(() => {})
        }

        this._silenceWatchdog = setInterval(() => {
          if (this._crossfadeToken !== token || triggered) return

          const stream = this._getAudioStream()
          const energy = stream?.getMainEnergy?.()
          if (!energy) return

          const currentTotal =
            this.track?.endTime && this.track.endTime > 0
              ? this.track.endTime
              : this.track?.info.length || 0
          const remainingMs =
            currentTotal -
            (startPosition + energyHistory.length * ENERGY_POLL_MS)

          if (trackBEnergy <= 0) {
            trackBEnergy = stream?.getNextTrackOpeningEnergy?.() ?? 0
            if (trackBEnergy > 0) {
              logger(
                'info',
                'AutoMix',
                `Track B energy captured for guild ${this.guildId}: ${(trackBEnergy * 100).toFixed(1)}%`
              )

              if (automixDecision && this.track && this.nextCrossfadeTrack) {
                if (!keyB) keyB = stream?.getNextTrackKey?.() ?? null
                if (!keyA) keyA = stream?.getMainTrackKey?.() ?? null
                const currentTrack = this.track
                const queuedTrack = this.nextCrossfadeTrack
                const currentDecision = automixDecision
                if (!currentDecision) return
                void getAutomixController()
                  .then((Controller) => {
                    if (this._crossfadeToken !== token) return
                    const refined = Controller.analyze(
                      currentTrack,
                      queuedTrack,
                      durationMs,
                      normalizeAutoMixMode(automixConfig.mode),
                      {
                        deezerMetadata: automixConfig.deezerMetadata,
                        trackAEnergy: energy.rms,
                        trackBOpeningEnergy: trackBEnergy,
                        keyA,
                        keyB,
                        ...this._getAutomixLiveSignals(stream)
                      }
                    )
                    if (refined.transition !== currentDecision.transition) {
                      logger(
                        'info',
                        'AutoMix',
                        `Decision refined with Track B energy for guild ${this.guildId}: ${currentDecision.transition} → ${refined.transition}`
                      )
                    }
                    automixDecision = refined
                  })
                  .catch(() => {})
              }
            }
          }

          energyHistory.push(energy.rms)
          if (energyHistory.length > ENERGY_HISTORY_SIZE) {
            energyHistory.shift()
          }

          if (!bpmFallbackTriggered) {
            const liveSignals = this._getAutomixLiveSignals(stream)
            if (liveSignals.liveBpmA || liveSignals.liveBpmB) {
              bpmFallbackTriggered = true
              logger(
                'info',
                'AutoMix',
                `Live tempo detected during polling for guild ${this.guildId} (A: ${liveSignals.liveBpmA?.toFixed(1) ?? 'N/A'}, B: ${liveSignals.liveBpmB?.toFixed(1) ?? 'N/A'})`
              )
              if (automixDecision && this.track && this.nextCrossfadeTrack) {
                if (!keyA) keyA = stream?.getMainTrackKey?.() ?? null
                if (!keyB) keyB = stream?.getNextTrackKey?.() ?? null
                const currentTrack = this.track
                const queuedTrack = this.nextCrossfadeTrack
                const currentDecision = automixDecision
                void getAutomixController()
                  .then((Controller) => {
                    if (this._crossfadeToken !== token) return
                    const eng = this._getAudioStream()?.getMainEnergy?.()
                    const refined = Controller.analyze(
                      currentTrack,
                      queuedTrack,
                      durationMs,
                      normalizeAutoMixMode(automixConfig.mode),
                      {
                        deezerMetadata: automixConfig.deezerMetadata,
                        trackAEnergy: eng?.rms,
                        trackBOpeningEnergy: trackBEnergy,
                        keyA,
                        keyB,
                        ...this._getAutomixLiveSignals(this._getAudioStream())
                      }
                    )
                    if (
                      refined.transition !== currentDecision.transition ||
                      refined.timescaleA !== currentDecision.timescaleA
                    ) {
                      logger(
                        'info',
                        'AutoMix',
                        `Decision refined with live tempo for guild ${this.guildId}: ${currentDecision.transition} → ${refined.transition}${refined.timescaleA ? ` (timescale: ${refined.timescaleA.speed.toFixed(3)})` : ''}`
                      )
                    }
                    automixDecision = refined
                  })
                  .catch(() => {})
              }
            }
          }

          if (energyHistory.length < 16) return
          if (energyHistory.length * ENERGY_POLL_MS < effectivePatienceMs) return

          const avg =
            energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length
          const current = energy.rms

          const beatState = stream?.getRealtimeBeatState?.() ?? null
          const beatLocked = Boolean(
            beatState &&
              beatState.locked &&
              beatState.bpm > 0 &&
              beatState.confidence >= 0.55
          )
          const isFusionMode = automixConfig.mode === 'fusion'
          if (
            beatLocked &&
            trackBEnergy > 0.015 &&
            remainingMs < SMART_ZONE_MS &&
            remainingMs > Math.max(8000, MIN_REMAINING_MS * 0.35)
          ) {
            const nearDownbeat =
              (isFusionMode
                ? beatState!.phase <= 0.18 ||
                  beatState!.phase >= 0.82 ||
                  beatState!.lastBeatAgeSec <= 0.16
                : beatState!.phase <= 0.12 ||
                  beatState!.phase >= 0.88 ||
                  beatState!.lastBeatAgeSec <= 0.12)

            // For Fusion mode, we prioritize structural alignment over energy matching.
            // We allow triggering on intro beats that might be quieter than the body.
            const minEnergy = isFusionMode
              ? Math.max(MIN_RMS_FLOOR * 0.85, avg * 0.55, trackBEnergy * 0.45)
              : Math.max(MIN_RMS_FLOOR * 1.2, avg * 0.78, trackBEnergy * 0.72)

            if (nearDownbeat && current > minEnergy) {
              triggered = true
              triggerAutomix(
                `fusion phase trigger: bpm=${beatState!.bpm.toFixed(1)} phase=${beatState!.phase.toFixed(2)} mode=${automixConfig.mode}`
              )
              return
            }
          }

          if (
            isFusionMode &&
            remainingMs < SMART_ZONE_MS &&
            remainingMs > Math.max(7000, MIN_REMAINING_MS * 0.3)
          ) {
            const recent = energyHistory.slice(-10)
            const recentAvg =
              recent.reduce((sum, v) => sum + v, 0) / Math.max(1, recent.length)
            const variance =
              recent.reduce((sum, v) => sum + Math.abs(v - recentAvg), 0) /
              Math.max(1, recent.length)
            const continuityFloor = Math.max(
              MIN_RMS_FLOOR * 0.7,
              trackBEnergy * 0.33,
              avg * 0.44
            )
            const phaseFriendly = !beatLocked
              ? true
              : !!beatState &&
                (beatState.phase <= 0.2 ||
                  beatState.phase >= 0.8 ||
                  beatState.lastBeatAgeSec <= 0.16)
            if (
              phaseFriendly &&
              current >= continuityFloor &&
              variance <= Math.max(0.0045, recentAvg * 0.24)
            ) {
              triggered = true
              triggerAutomix(
                `fusion continuity trigger: A=${(current * 100).toFixed(1)}% B=${(trackBEnergy * 100).toFixed(1)}% var=${(variance * 100).toFixed(2)}%`
              )
              return
            }
          }

          if (
            trackBEnergy > 0.02 &&
            current > 0.02 &&
            remainingMs < SMART_ZONE_MS
          ) {
            const ratio = current / trackBEnergy
            if (
              ratio > 1 - ENERGY_MATCH_TOLERANCE &&
              ratio < 1 + ENERGY_MATCH_TOLERANCE
            ) {
              triggered = true
              triggerAutomix(
                `energy match with Track B: A=${(current * 100).toFixed(1)}% ≈ B=${(trackBEnergy * 100).toFixed(1)}%`
              )
              return
            }
          }

          if (
            avg > MIN_RMS_FLOOR &&
            current < avg * ENERGY_DROP_RATIO &&
            remainingMs < SMART_ZONE_MS
          ) {
            triggered = true
            triggerAutomix(
              `energy drop: ${(current * 100).toFixed(1)}% < ${(avg * ENERGY_DROP_RATIO * 100).toFixed(1)}%`
            )
            return
          }

          if (energyHistory.length >= 16 && remainingMs < SMART_ZONE_MS) {
            const recentSlice = energyHistory.slice(-12)
            const first = recentSlice[0] ?? 0
            const last = recentSlice[recentSlice.length - 1] ?? first
            const slope = (last - first) / Math.max(1, recentSlice.length - 1)
            if (prevSlope > 0.004 && slope < -0.004) {
              triggered = true
              triggerAutomix(
                `peak detected (derivative reversal): slope ${(prevSlope * 1000).toFixed(1)} → ${(slope * 1000).toFixed(1)}`
              )
              return
            }
            prevSlope = slope
          }

          if (energyHistory.length >= 16 && remainingMs < SMART_ZONE_MS) {
            const windowMin = Math.min(...energyHistory)
            if (current <= windowMin && current < avg * 0.55) {
              triggered = true
              triggerAutomix(
                `local minimum: ${(current * 100).toFixed(1)}% (lowest in ${energyHistory.length * 0.5}s window)`
              )
              return
            }
          }

          if (energyHistory.length >= 12 && remainingMs < SMART_ZONE_MS) {
            const recent = energyHistory.slice(-20)
            const recentAvg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length)
            const variance =
              recent.reduce((sum, v) => sum + Math.abs(v - recentAvg), 0) / Math.max(1, recent.length)
            if (variance < recentAvg * 0.04) {
              steadyCount++
            } else {
              if (steadyCount >= 25) {
                triggered = true
                triggerAutomix(
                  `plateau exit: energy changing after ${(steadyCount * ENERGY_POLL_MS / 1000).toFixed(1)}s stability`
                )
                return
              }
              steadyCount = 0
            }
          }

          if (remainingMs < SMART_ZONE_MS && stream?.isSilent?.()) {
            triggered = true
            triggerAutomix('silence detected')
            return
          }
        }, ENERGY_POLL_MS)
      }, windowDelay)

      this._crossfadeTimer = setTimeout(() => {
        if (triggered || this._crossfadeToken !== token) return
        triggered = true
        triggerAutomix('fallback (no optimal point found)')
      }, fallbackDelay)
    } else {
      const triggerStartCrossfade = () => {
        if (this._crossfadeTimer) {
          clearTimeout(this._crossfadeTimer)
          this._crossfadeTimer = null
        }
        logger(
          'info',
          'Crossfade',
          `Crossfade starting for guild ${this.guildId}`,
          {
            token,
            durationMs
          }
        )
        this._startCrossfade(token, durationMs, config, null)
      }

      this._crossfadeTimer = setTimeout(triggerStartCrossfade, delay)
    }
  }

  /**
   * Starts the crossfade mix and emits events for the new track.
   *
   * @param token - Current crossfade token for race protection.
   * @param durationMs - Crossfade duration in milliseconds.
   * @param config - Crossfade mode/curve metadata.
   */
  private _startCrossfade(
    token: number,
    durationMs: number,
    config: { curve: string; mode: CrossfadeMode },
    automixDecision?: AutoMixDecision | null,
    triggerReason?: string | null
  ): void {
    if (token !== this._crossfadeToken) return
    if (!this.track || !this.nextCrossfadeTrack) return
    if (this._crossfadeStartRetryToken !== token) {
      this._crossfadeStartRetryToken = token
      this._crossfadeStartRetryCount = 0
    }

    const CROSSFADE_COOLDOWN_MS = 3000
    const sinceLastCompletion = Date.now() - this._lastCrossfadeCompletedAt
    if (
      this._lastCrossfadeCompletedAt > 0 &&
      sinceLastCompletion < CROSSFADE_COOLDOWN_MS
    ) {
      const waitMs = CROSSFADE_COOLDOWN_MS - sinceLastCompletion
      logger(
        'debug',
        'Crossfade',
        `Crossfade start deferred ${waitMs}ms (cooldown after previous completion) for guild ${this.guildId}`
      )
      setTimeout(() => {
        this._startCrossfade(
          token,
          durationMs,
          config,
          automixDecision,
          triggerReason
        )
      }, waitMs)
      return
    }

    logger(
      'info',
      'Crossfade',
      `Starting crossfade for guild ${this.guildId}`,
      {
        token,
        durationMs,
        mode: config.mode,
        curve: config.curve
      }
    )

    const audioStream = this._getAudioStream()
    const state = audioStream?.getCrossfadeState?.()
    let bufferedMs = state?.bufferedMs ?? 0
    if (!audioStream || !audioStream.startCrossfade || bufferedMs <= 0) {
      const canRetry =
        !!audioStream &&
        !!this.nextCrossfadePcm &&
        !!this.nextCrossfadeTrack &&
        this._crossfadeStartRetryCount < 6

      if (canRetry) {
        this._crossfadeStartRetryCount += 1

        const crossfadeConfig = this._getCrossfadeConfig()
        if (crossfadeConfig) {
          this._crossfadePrepared = false
          this._prepareCrossfadeBuffer({
            durationMs: crossfadeConfig.durationMs,
            minBufferMs: crossfadeConfig.minBufferMs,
            bufferMs: crossfadeConfig.bufferMs
          })
        }

        const retryInMs = 180 + this._crossfadeStartRetryCount * 120
        logger(
          'debug',
          'Crossfade',
          `Crossfade start waiting for buffer for guild ${this.guildId}`,
          {
            token,
            retry: this._crossfadeStartRetryCount,
            retryInMs,
            bufferedMs
          }
        )
        setTimeout(() => {
          if (token !== this._crossfadeToken) return
          this._startCrossfade(
            token,
            durationMs,
            config,
            automixDecision,
            triggerReason
          )
        }, retryInMs)
        return
      }

      logger(
        'warn',
        'Crossfade',
        `Crossfade could not start for guild ${this.guildId} (missing buffer).`,
        {
          token,
          retries: this._crossfadeStartRetryCount,
          bufferedMs
        }
      )
      this._clearCrossfade({ clearNext: false, clearPcm: false })
      return
    }

    this._crossfadeStartRetryCount = 0

    if (bufferedMs < durationMs) {
      if (bufferedMs < 2000) {
        logger(
          'warn',
          'Crossfade',
          `Crossfade skipped for guild ${this.guildId} (buffered ${Math.round(
            bufferedMs
          )}ms is too small).`
        )
        this._clearCrossfade({ clearNext: false, clearPcm: false })
        return
      }
      logger(
        'info',
        'Crossfade',
        `Crossfade duration capped for guild ${this.guildId} (${durationMs}ms → ${Math.round(bufferedMs)}ms, buffer limit).`
      )
      durationMs = Math.floor(bufferedMs)
    }

    if (this._fadeTimers.trackEnd) {
      clearTimeout(this._fadeTimers.trackEnd)
      this._fadeTimers.trackEnd = null
    }

    if (automixDecision) {
      logger(
        'info',
        'AutoMix',
        `Blend phase: "${automixDecision.transition}" for guild ${this.guildId}`
      )

      if (typeof audioStream.setIncomingGain === 'function') {
        audioStream.setIncomingGain(1.0)
      }

      if (
        Number.isFinite(automixDecision.incomingGainMultiplier) &&
        typeof audioStream.setIncomingGain === 'function'
      ) {
        const gain = Math.max(
          0.5,
          Math.min(1.5, Number(automixDecision.incomingGainMultiplier))
        )
        audioStream.setIncomingGain(gain)
      }

      if (automixDecision.transition === 'gapless') {
        durationMs = Math.min(
          durationMs,
          automixDecision.transitionDurationMs || 500
        )
      } else {
        if (automixDecision.highpassSweepB) {
          if (typeof audioStream.setIncomingHighpass === 'function') {
            audioStream.setIncomingHighpass(
              true,
              automixDecision.highpassSweepAlpha
            )
          }
        }

        if (automixDecision.lowpassSweepB) {
          if (typeof audioStream.setIncomingLowpass === 'function') {
            audioStream.setIncomingLowpass(
              true,
              automixDecision.lowpassSweepAlpha,
              automixDecision.lowpassSweepCompletionRatio
            )
          }
        }

        if (automixDecision.stereoPanB) {
          if (typeof audioStream.setIncomingPan === 'function') {
            audioStream.setIncomingPan(
              true,
              automixDecision.incomingPanCompletionRatio
            )
          }
        }

        if (automixDecision.echoB) {
          if (typeof audioStream.setIncomingEcho === 'function') {
            audioStream.setIncomingEcho(
              true,
              automixDecision.echoB.delay,
              automixDecision.echoB.mix,
              automixDecision.echoB.feedback,
              automixDecision.incomingEchoCompletionRatio
            )
          }
        }

        if (automixDecision.stereoPanA) {
          if (typeof audioStream.setOutgoingPan === 'function') {
            audioStream.setOutgoingPan(
              true,
              automixDecision.outgoingPanCompletionRatio
            )
          }
        }

        if (automixDecision.tapeStopA) {
          if (typeof audioStream.tapeTo === 'function') {
            audioStream.tapeTo(0, 'start', 'exponential')
            logger(
              'debug',
              'AutoMix',
              `Blend start: tape rate reset (instant) for guild ${this.guildId}`
            )
          }
        }
        if (automixDecision.scratchA) {
          if (typeof audioStream.scratchTo === 'function') {
            audioStream.scratchTo(0, 'start')
            logger(
              'debug',
              'AutoMix',
              `Blend start: scratch rate reset (instant) for guild ${this.guildId}`
            )
          }
        }
      }
    }

    const hasPhysicalReset =
      automixDecision && (automixDecision.tapeStopA || automixDecision.scratchA)
    if (audioStream.setFadeVolume) {
      if (hasPhysicalReset && typeof audioStream.fadeTo === 'function') {
        audioStream.setFadeVolume(0.0)
        audioStream.fadeTo(1.0, Math.min(1200, durationMs * 0.4), 's-curve')
      } else {
        audioStream.setFadeVolume(1.0)
      }
    }

    const inBridge =
      typeof audioStream.isBridgeDraining === 'function' &&
      audioStream.isBridgeDraining()
    const transition = automixDecision?.transition ?? null
    const fallbackReason = (triggerReason ?? '').toLowerCase().includes(
      'fallback'
    )
    const fusionLikeTransition =
      transition === 'fusion_morph' || transition === 'harmonic_weave'
    if (!inBridge && typeof audioStream.seekToEnergyMatch === 'function') {
      const energy = audioStream.getMainEnergy?.()
      if (energy && energy.rms > 0) {
        let targetRms = energy.rms
        const hardCap =
          transition === 'cinema_lift' || transition === 'pulse_tunnel'
            ? 0.15
            : transition === 'filter_sweep' ||
                transition === 'highpass_dissolve' ||
                transition === 'harmonic_weave' ||
                transition === 'crossfade_eq'
              ? 0.18
              : 0.22
        targetRms = Math.min(targetRms, hardCap)
        // For cinematic/Apple-like blends, avoid entering Track B at a very
        // weak intro frame when transition expects a controlled handoff.
        if (automixDecision) {
          const transition = automixDecision.transition
          if (
            transition === 'highpass_dissolve' ||
            transition === 'filter_sweep' ||
            transition === 'harmonic_weave' ||
            transition === 'crossfade_eq'
          ) {
            const floor =
              transition === 'crossfade_eq'
                ? 0.055
                : transition === 'harmonic_weave'
                  ? 0.06
                : 0.065
            targetRms = Math.max(targetRms, floor)
          }
        }
        const preferNoVocalEntry =
          transition !== null &&
          transition !== 'gapless' &&
          transition !== 'vocal_strip'
        const strictNoVocalPreference =
          preferNoVocalEntry &&
          (
            fusionLikeTransition ||
            transition === 'crossfade_eq' ||
            transition === 'filter_sweep' ||
            transition === 'highpass_dissolve' ||
            fallbackReason
          )
        const transitionHint =
          transition !== null
            ? `${transition}${preferNoVocalEntry ? '|no-vocal-entry' : ''}${strictNoVocalPreference ? '|strict-no-vocal' : ''}${fallbackReason ? '|fallback' : ''}`
            : null
        audioStream.seekToEnergyMatch(
          targetRms,
          durationMs,
          transitionHint ?? null,
          audioStream.getRealtimeBeatState?.() ?? null
        )
      }
    }

    const started = audioStream.startCrossfade(durationMs, config.curve)
    if (!started) {
      logger(
        'warn',
        'Crossfade',
        `Crossfade could not start for guild ${this.guildId} (controller rejected).`
      )
      this._clearCrossfade({ clearNext: false, clearPcm: false })
      return
    }

    const previousTrack = this.track
    const nextTrack = this.nextCrossfadeTrack
    const nextStreamInfo = this.nextCrossfadeStreamInfo

    this._crossfadeIgnoreIdle = true

    this.nextCrossfadeTrack = null
    this.nextCrossfadeStreamInfo = null

    this.nextCrossfadePcm = null
    this.nextTrack = null
    this.nextResource = null

    this._emitTrackEnd(EndReasons.CROSSFADE, {
      crossfade: {
        durationMs,
        curve: config.curve,
        mode: config.mode,
        transition: automixDecision?.transition ?? null,
        nextTrack: nextTrack
      }
    })

    this.track = nextTrack
    this.holoTrack = null
    this.streamInfo = nextStreamInfo

    const energySkipMs = audioStream.getEnergySkipMs?.() ?? 0

    this.position = energySkipMs
    this._lyricsBasePosition = energySkipMs
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0
    this._emitTrackStart().catch((err) => this._onError(err))
    this._crossfadeEndsAt = Date.now() + durationMs
    this._crossfadeBlendStartedAt = Date.now()

    const startPositionMs = this._realPosition()
    this._crossfadeCompletionContext = {
      token,
      previousTrack,
      startPositionMs,
      endPositionMs: startPositionMs + durationMs
    }
    logger(
      'debug',
      'Crossfade',
      `Crossfade started for guild ${this.guildId}`,
      {
        token,
        previousTrack: previousTrack.info.identifier,
        nextTrack: nextTrack.info.identifier,
        startPositionMs,
        endPositionMs: startPositionMs + durationMs
      }
    )
    this._armCrossfadeCompletionTimer(durationMs)
  }

  /**
   * Completes the crossfade transition and continues playback.
   *
   * @param token - Current crossfade token for race protection.
   * @param previousTrack - Track that was fading out.
   */
  private async _completeCrossfade(
    token: number,
    previousTrack: PlayerTrack
  ): Promise<void> {
    if (token !== this._crossfadeToken) return

    if (!this.connection) {
      this._clearCrossfade({ clearNext: false })
      return
    }

    if (!this.track) {
      this._clearCrossfade({ clearNext: false })
      return
    }

    const audioStream = this._getAudioStream()
    let snapshotPosition: number
    const consumed = audioStream?.getCrossfadeConsumedNextMs?.() ?? -1
    if (consumed >= 0) {
      const energySkip = audioStream?.getEnergySkipMs?.() ?? 0
      snapshotPosition = energySkip + consumed
    } else {
      snapshotPosition = this._realPosition()
    }

    const trackLen = this.track?.info?.length ?? 0
    const blendElapsed =
      this._crossfadeBlendStartedAt > 0
        ? Date.now() - this._crossfadeBlendStartedAt
        : 0
    if (snapshotPosition < blendElapsed * 0.3 && blendElapsed > 2000) {
      const wallBased = Math.round(blendElapsed)
      const energySkip = audioStream?.getEnergySkipMs?.() ?? 0
      const fallback = energySkip + wallBased
      logger(
        'warn',
        'Crossfade',
        `Position sanity check failed for guild ${this.guildId}: snapshot=${Math.round(snapshotPosition)}ms, ` +
          `blendElapsed=${blendElapsed}ms → using wall-clock fallback ${fallback}ms`
      )
      snapshotPosition = fallback
    }
    if (trackLen > 0 && snapshotPosition > trackLen) {
      snapshotPosition = trackLen - 1000
    }

    this._lyricsBasePosition = snapshotPosition
    this._lyricsBasePackets = this.connection.statistics?.packetsExpected ?? 0
    this.position = snapshotPosition
    this._crossfadeBlendStartedAt = 0

    if (this._preAutomixFilters !== null) {
      const preFilters = this._preAutomixFilters
      this._preAutomixFilters = null
      logger(
        'debug',
        'AutoMix',
        `Restoring pre-automix filters at crossfade completion for guild ${this.guildId}`
      )
      if (!this.destroying && this.track) {
        this.filters = { ...this.filters, filters: {} }
        this.setFilters({ filters: preFilters } as FiltersState)
      }
    }

    this._lastStreamDataTime = Date.now()

    const activeStream = this._getAudioStream()
    if (typeof activeStream?.setIncomingHighpass === 'function') {
      activeStream.setIncomingHighpass(false)
    }
    if (typeof activeStream?.setIncomingLowpass === 'function') {
      activeStream.setIncomingLowpass(false)
    }

    if (typeof activeStream?.setFilterBypass === 'function') {
      activeStream.setFilterBypass(false)
    }

    this._fading('reset')

    this.nextCrossfadePcm = null

    if (!this._crossfadePrepared) {
      this.nextCrossfadeResource = null
    }

    this._crossfadeIgnoreIdle = false

    if (this._crossfadeCompletionWatcher) {
      clearInterval(this._crossfadeCompletionWatcher)
      this._crossfadeCompletionWatcher = null
    }
    this._crossfadeCompletionDeadline = 0
    this._crossfadeCompletionContext = null
    this._crossfadeCompletionRemainingMs = 0
    this._crossfadeEndsAt = 0
    this._crossfadePrepared = false
    this._isResuming = false
    this._lastCrossfadeCompletedAt = Date.now()

    this._fading('trackEndSchedule', { startPosition: snapshotPosition })
    this._scheduleCrossfade(snapshotPosition)

    this._sendUpdate()

    logger(
      'debug',
      'Crossfade',
      `Crossfade completed for guild ${this.guildId} (previous: ${previousTrack.info.identifier}).`
    )

    if (this._pendingPreload) {
      const pending = this._pendingPreload
      this._pendingPreload = null
      logger(
        'debug',
        'Crossfade',
        `Processing deferred preload for guild ${this.guildId}`,
        { trackIdentifier: pending.info?.identifier }
      )
      this.preload(pending).catch((err) => {
        logger(
          'warn',
          'Crossfade',
          `Deferred preload failed for guild ${this.guildId}: ${(err as Error).message}`
        )
      })
    }
  }

  /**
   * Resolves optional Holo track data for events.
   */
  private async _resolveTrackForEvent(
    track: PlayerTrack | null
  ): Promise<PlayerTrack | null> {
    if (!track) return null
    if (!this.nodelink.options.enableHoloTracks) {
      return track
    }

    try {
      const source = this.nodelink.sources.getSource(track.info.sourceName)
      const resolveHoloTrack = (
        source as {
          resolveHoloTrack?: (
            trackPayload: PlayerTrack,
            options: {
              fetchChannelInfo?: boolean
              resolveExternalLinks?: boolean
            }
          ) => Promise<PlayerTrack | null>
        } | null
      )?.resolveHoloTrack
      if (typeof resolveHoloTrack === 'function') {
        const holoTrack = await resolveHoloTrack.call(source, track, {
          fetchChannelInfo: this.nodelink.options.fetchChannelInfo,
          resolveExternalLinks: this.nodelink.options.resolveExternalLinks
        })
        return holoTrack || track
      }
    } catch (err) {
      const error = err as Error
      logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`)
    }

    return track
  }

  /**
   * Calculates the real playback position considering timescale filters.
   */
  private _getTimescale(): { speed: number; rate: number } {
    const filterSettings = this.filters.filters as
      | { timescale?: { speed?: number; rate?: number } }
      | undefined
    const timescale = filterSettings?.timescale || {}
    return {
      speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
      rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
    }
  }

  private _realPosition(): number {
    const audioStream = this._getAudioStream()

    if (this._crossfadeCompletionContext) {
      const consumed = audioStream?.getCrossfadeConsumedNextMs?.() ?? -1
      if (consumed >= 0) {
        const energySkip = audioStream?.getEnergySkipMs?.() ?? 0
        return energySkip + consumed
      }
    }

    const playbackSpeed =
      audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed()

    const packets =
      this.connection?.statistics?.packetsExpected ?? this._lyricsBasePackets
    const deltaPackets = Math.max(0, packets - this._lyricsBasePackets)
    return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed
  }

  private _getTimescaleSpeed(): number {
    const settings = (this.filters.filters ?? this.filters) as {
      timescale?: { speed?: number; rate?: number }
    }
    const timescale = settings.timescale || {}
    return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0)
  }

  /**
   * Captures current position and packet count as a new baseline.
   * Call whenever playback speed changes (filters, tape, scratch).
   */
  private _snapshotPosition(): void {
    if (!this.connection?.audioStream) return
    this._lyricsBasePosition = this._realPosition()
    this._lyricsBasePackets = this.connection.statistics?.packetsExpected ?? 0
  }

  /**
   * Fetches an audio resource for playback.
   */
  private async _fetchResource(
    info: TrackInfoExtended,
    urlData: TrackUrlResult & { protocol?: string; format?: TrackFormat },
    startTime?: number
  ): Promise<{ stream: AudioResource } | { exception: { message: string } }> {
    if (this.nodelink.options?.mix?.enabled !== false) {
      await this._ensureAudioMixer()
    }

    await getStreamProcessor()
    const audioResourceFactory = createAudioResource
    if (!audioResourceFactory) {
      return { exception: { message: 'Stream processor not initialized' } }
    }

    const additionalData: Record<string, unknown> & { startTime?: number } = {
      ...urlData.additionalData
    }
    if (startTime !== undefined) additionalData.startTime = startTime

    urlData.additionalData = {
      ...urlData.additionalData,
      positionCallback: () => this._realPosition()
    }

    const track = urlData?.newTrack
      ? (urlData?.newTrack?.info as TrackInfoExtended)
      : info
    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      urlData.url,
      urlData.protocol,
      additionalData
    )
    if (fetched.exception) return fetched as { exception: { message: string } }
    const fetchedStream = fetched.stream
    const totalBytesRaw =
      (
        urlData.additionalData as
          | { contentLength?: number | string }
          | null
          | undefined
      )?.contentLength ?? null
    const totalBytesNum = Number(totalBytesRaw)
    this.profilerStreamStats = {
      downloadedBytes: 0,
      totalBytes:
        Number.isFinite(totalBytesNum) && totalBytesNum > 0
          ? totalBytesNum
          : null,
      lastChunkAt: null
    }
    if (typeof (fetchedStream as { on?: unknown }).on === 'function') {
      const eventStream = fetchedStream as unknown as VoiceAudioStream
      eventStream.on?.('data', (chunk: Buffer | Uint8Array | string) => {
        const size =
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : Number((chunk as { length?: number })?.length || 0)
        if (size > 0) this.profilerStreamStats.downloadedBytes += size
        this.profilerStreamStats.lastChunkAt = Date.now()
      })
      eventStream.on?.('eternalboxJump', (data: unknown) => {
        this.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
          track: this.holoTrack || this.track,
          eternalbox: data
        })
      })
      eventStream.on?.('icyMetadata', (data: unknown) => {
        this.emitEvent(GatewayEvents.STREAM_METADATA, {
          track: this.holoTrack || this.track,
          stream: data
        })
      })
    }
    const resource = audioResourceFactory(
      fetchedStream,
      fetched.type || urlData.format,
      this.nodelink,
      this.filters,
      this.volumePercent / 100,
      this.audioMixer,
      false,
      this.loudnessNormalizer
    )
    return { stream: resource }
  }

  /**
   * Fetches a raw PCM resource for crossfade buffering.
   *
   * @remarks
   * The PCM stream is decoded without filters or volume so that the main
   * pipeline can apply processing uniformly after mixing.
   */
  private async _fetchPcmResource(
    info: TrackInfoExtended,
    urlData: TrackUrlResult & { protocol?: string; format?: TrackFormat },
    startTime = 0
  ): Promise<{ stream: AudioResource } | { exception: { message: string } }> {
    if (this.nodelink.options?.mix?.enabled !== false) {
      await this._ensureAudioMixer()
    }

    await getStreamProcessor()
    const audioResourceFactory = createAudioResource
    if (!audioResourceFactory) {
      return { exception: { message: 'Stream processor not initialized' } }
    }

    const additionalData: Record<string, unknown> & { startTime?: number } = {
      ...urlData.additionalData
    }
    if (startTime !== undefined) additionalData.startTime = startTime

    const track = urlData?.newTrack
      ? (urlData?.newTrack?.info as TrackInfoExtended)
      : info
    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      urlData.url,
      urlData.protocol,
      additionalData
    )
    if (fetched.exception) return fetched as { exception: { message: string } }

    const resource = audioResourceFactory(
      fetched.stream,
      fetched.type || urlData.format,
      this.nodelink,
      {},
      1.0,
      null,
      true,
      false
    )
    return { stream: resource }
  }

  /**
   * Sends player state updates to the client.
   */
  private _sendUpdate(): boolean {
    if (
      !this.connection ||
      (this.isPaused && !this._fadeTimers.pause) ||
      this.connStatus === 'destroyed' ||
      this.destroying
    )
      return false

    const position = this._realPosition()

    const threshold = this.nodelink.options.trackStuckThresholdMs
    if (
      threshold > 0 &&
      !this.isUpdatingTrack &&
      !this._isStopping &&
      this.track &&
      !this._crossfadeCompletionContext &&
      !this._isResuming &&
      !this._crossfadeIgnoreIdle &&
      !this._isBridgeDrainWithoutPendingNext()
    ) {
      if (this._lastPosition === position) {
        this._stuckTime += this.nodelink.options.playerUpdateInterval
        if (
          this._stuckTime >= threshold &&
          !this._isRecovering &&
          this.connStatus === 'connected'
        ) {
          const stuckTime = this._stuckTime
          this._stuckTime = 0

          if (this.streamInfo?.format === 'mp4') {
            logger(
              'error',
              'Player',
              `Player for guild ${this.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Playback of MP4 track is stuck'
            })
            this.stop()
            return false
          }

          if (!this.track.info.isSeekable) {
            logger(
              'warn',
              'Player',
              `Player for guild ${this.guildId} is stuck on a non-seekable track. Stopping track.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Track is not seekable'
            })
            this.stop()
            return false
          }

          logger(
            'warn',
            'Player',
            `Player for guild ${this.guildId} is stuck. Attempting to recover...`,
            {
              lastPosition: this._lastPosition,
              currentPosition: position,
              stuckTime: stuckTime,
              threshold: threshold,
              connStatus: this.connStatus,
              lastStreamDataTime:
                this._lastStreamDataTime > 0
                  ? new Date(this._lastStreamDataTime).toISOString()
                  : 'never',
              statistics: this.connection?.statistics
            }
          )
          this._isRecovering = true

          this.seek(this._lastPosition)
            .then((success) => {
              if (success) {
                logger(
                  'info',
                  'Player',
                  `Player for guild ${this.guildId} recovered successfully.`
                )
              } else {
                logger(
                  'error',
                  'Player',
                  `Player for guild ${this.guildId} recovery failed. Stopping track.`
                )
                this.emitEvent(GatewayEvents.TRACK_STUCK, {
                  guildId: this.guildId,
                  track: this.track,
                  thresholdMs: threshold,
                  reason: 'Recovery attempt failed'
                })
                this.stop()
              }
              this._isRecovering = false
            })
            .catch((err: Error) => {
              logger(
                'error',
                'Player',
                `Player for guild ${this.guildId} recovery attempt threw an error: ${err.message}. Stopping track.`
              )
              this.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: this.guildId,
                track: this.track,
                thresholdMs: threshold,
                reason: `Recovery attempt failed: ${err.message}`
              })
              this.stop()
              this._isRecovering = false
            })
        }
      } else {
        this._stuckTime = 0
        this._isRecovering = false
      }
    }

    if (position !== this._lastPosition) {
      this._lastStreamDataTime = Date.now()
    }

    this._lastPosition = position
    this._syncLyrics()

    this.session.socket.send(
      JSON.stringify({
        op: GatewayEvents.PLAYER_UPDATE,
        guildId: this.guildId,
        state: {
          time: Date.now(),
          position,
          connected: this.connStatus === 'connected',
          ping: this.connection.ping ?? 0
        }
      })
    )
    return true
  }

  /**
   * Starts playback for the current track.
   */
  private async _startPlayback(startTime = 0): Promise<boolean> {
    if (!this.track) return false

    const trackInfo: TrackInfoExtended = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(
      trackInfo,
      undefined,
      this._isRecovering
    )
    const urlDataWithFormats = urlData as TrackUrlResult & {
      formats?: unknown[]
    }
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }
    logger('debug', 'Player', `Got track URL for guild ${this.guildId}`, {
      urlData: {
        ...urlData,
        formats: urlDataWithFormats.formats
          ? `[${urlDataWithFormats.formats.length} format(s) omitted]`
          : undefined
      }
    })

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )

      await this.waitEvent(
        'stateChange',
        (s: VoiceConnectionState) =>
          s.status === 'connected' && !!this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'error',
        'Player',
        `Voice connection for guild ${this.guildId} is not ready, cannot start playback.`
      )
      this._onError(new Error('Voice connection is not ready.'))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      startTime
    )
    if ('exception' in fetched) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
      return false
    }

    this._cleanupCurrentAudioStream('start-playback')

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }
    this._fading('trackStartArm', { resource })
    this._fading('trackEndSchedule', { startPosition: startTime || 0 })

    this.setFilters(this.filters)
    this._scheduleCrossfade(startTime || 0)

    logger('debug', 'Player', `Playing resource for guild ${this.guildId}`)
    this._stuckTime = 0
    this.connection.play(resource as unknown)
    await this.waitEvent(
      'playerStateChange',
      (s: VoicePlayerState) => s.status === 'playing'
    )

    this._lyricsBasePosition = startTime || 0
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0
    return true
  }

  /**
   * Starts playback for the provided track payload.
   *
   * @param payload - Track data plus playback options.
   * @param payload.noReplace - When true, keeps current track if already playing.
   * @param payload.startTime - Initial seek position in milliseconds.
   * @param payload.endTime - Optional end time to truncate playback.
   * @returns True when the request is accepted (actual start is async).
   */
  public async play({
    encoded,
    info,
    userData,
    audioTrackId,
    noReplace = false,
    startTime,
    endTime = 0
  }: PlayPayload): Promise<boolean> {
    return new Promise((resolve) => {
      this.isUpdatingTrack = true

      try {
        if (this.destroying) {
          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} because player is destroying`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }
        logger('debug', 'Player', `play() called for guild ${this.guildId}`, {
          encoded,
          noReplace,
          startTime,
          endTime,
          track: info
        })

        if (noReplace && this.track && this.connection?.audioStream) {
          const isAlreadyPlaying =
            this.track?.info.identifier === info.identifier ||
            this.nextCrossfadeTrack?.info.identifier === info.identifier

          if (isAlreadyPlaying) {
            logger(
              'info',
              'Player',
              `play() for guild ${this.guildId} adopted (already playing/transitioning ${info.identifier})`
            )
            this.isUpdatingTrack = false
            return resolve(true)
          }

          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} due to noReplace=true and player is active`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }

        if (this.track) {
          this._clearCrossfade({ force: true })
          this._emitTrackEnd(EndReasons.REPLACED)
          this._cleanupCurrentAudioStream('track-replaced')
        }

        this.track = { encoded, info, endTime, userData, audioTrackId }
        this._fading('reset')

        if (!this.voice.endpoint || !this.voice.token) {
          logger(
            'debug',
            'Player',
            `No voice state for guild ${this.guildId}, track is enqueued and will play when voice state is provided.`
          )
          this.isUpdatingTrack = false
          return resolve(true)
        }

        this._startPlayback(
          startTime !== undefined
            ? startTime === 0 && this.position < 1000
              ? 0
              : startTime
            : 0
        )
          .catch((err) => this._onError(err))
          .finally(() => {
            this.isUpdatingTrack = false
          })

        return resolve(true)
      } catch (e) {
        this.isUpdatingTrack = false
        this._onError(e as Error)
        return resolve(false)
      }
    })
  }

  /**
   * Performs a seek operation to the requested position.
   *
   * @param position - Target position in milliseconds. Uses current position when omitted.
   * @param endTime - Optional end time to enforce after the seek.
   * @returns True when the seek succeeds; false otherwise.
   */
  public async seek(position?: number, endTime?: number): Promise<boolean> {
    if (this.destroying || !this.track) return false
    if (!this.track.info.isSeekable && !this.track.info.isStream) return false

    const hasQueuedNextTrack = !!this.nextTrack && !!this.nextResource
    const hasPreparedCrossfade =
      !!this.nextCrossfadeTrack && !!this.nextCrossfadePcm
    const preserveQueuedTransition = hasQueuedNextTrack || hasPreparedCrossfade

    this._clearCrossfade({
      clearNext: !preserveQueuedTransition,
      clearPcm: !hasPreparedCrossfade,
      force: true
    })

    const seekPosition = position ?? this._realPosition()

    if (
      seekPosition === 0 &&
      !this._isRecovering &&
      this._realPosition() < 2000
    ) {
      logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.')

      return false
    }

    if (
      seekPosition < 0 ||
      (this.track.info.length > 0 && seekPosition > this.track.info.length)
    )
      return false
    this._isSeeking = true
    try {
      const sourceName = this.track.info.sourceName
      const unsupportedSources = ['local', 'deezer']

      let seekPromise: Promise<boolean>
      if (!this.streamInfo?.url) {
        logger(
          'debug',
          'Player',
          'No stream info URL available for seek. awaiting getTrackUrl.'
        )
        const sleep = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms))
        await sleep(1600)
        if (!this.streamInfo?.url) {
          logger(
            'debug',
            'Player',
            'Still no stream info URL available for seek.'
          )
          if (this.track) {
            const trackInfo = {
              ...this.track.info,
              audioTrackId: this.track.audioTrackId
            }
            const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
            if (!this.track) return false
            this.streamInfo = { ...urlData, trackInfo: this.track.info }
            logger(
              'debug',
              'Player',
              'Fetched stream info URL for seek after wait.'
            )
          }
        } else {
          logger(
            'debug',
            'Player',
            'Stream info URL became available during wait.'
          )
        }
      }

      const source = this.nodelink.sources.getSource(sourceName)
      const hasSourceLoader = source && typeof source.loadStream === 'function'
      const canNativeSeek =
        !!hasSourceLoader &&
        (this.streamInfo?.protocol === 'sabr' || sourceName === 'deezer')

      if (canNativeSeek) {
        seekPromise = this._seekUsingSource(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else if (
        !unsupportedSources.includes(sourceName) &&
        this.streamInfo?.url &&
        this.streamInfo.protocol !== 'hls'
      ) {
        seekPromise = this._seekeableSeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else {
        seekPromise = this._legacySeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      }

      const startPosition = this._realPosition()
      const result = await seekPromise
      if (result) {
        this.emitEvent(GatewayEvents.SEEK, {
          position: this.position,
          duration: this.position - startPosition
        })
        if (this._lyricsMarkerTimer) {
          clearTimeout(this._lyricsMarkerTimer)
          this._lyricsMarkerTimer = null
        }
        if (this.isLyricsSubscribed)
          this._recalculateLyricsIndex(undefined, undefined, true)
        this._fading('seek')
        this._fading('trackEndSchedule', { startPosition: this.position })
      }
      return result
    } finally {
      this._isSeeking = false
    }
  }

  /**
   * Seeks using source-native capabilities (e.g., SABR/Deezer).
   */
  private async _seekUsingSource(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (!this.track) return false

    logger(
      'debug',
      'Player',
      `Seeking using source (native) to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime
    let previousSession: unknown = null
    let reuseUrlData: TrackUrlResult | null = null

    if (this.streamInfo?.protocol === 'sabr' && this.connection?.audioStream) {
      const inputStream = (this.connection.audioStream as { pipes?: unknown[] })
        ?.pipes?.[0] as { getSessionState?: () => unknown } | undefined
      if (inputStream && typeof inputStream.getSessionState === 'function') {
        previousSession = inputStream.getSessionState()
        if (previousSession) {
          logger(
            'debug',
            'Player',
            `Extracted SABR session state: rn=${
              (previousSession as { requestNumber?: number }).requestNumber
            }, hasCookie=${!!(
              previousSession as {
                nextRequestPolicy?: { playbackCookie?: unknown }
              }
            ).nextRequestPolicy?.playbackCookie}`
          )

          reuseUrlData = {
            protocol: this.streamInfo.protocol,
            url: this.streamInfo.url,
            additionalData: {
              ...this.streamInfo.additionalData,
              previousSession,
              startTime: position
            }
          } as TrackUrlResult

          logger(
            'debug',
            'Player',
            `Reusing existing SABR streaming URL for seek to maintain session`
          )
        }
      }
    }

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData =
      reuseUrlData || (await this.nodelink.sources.getTrackUrl(trackInfo))
    this.streamInfo = { ...urlData, trackInfo: this.track.info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      await this.waitEvent(
        'stateChange',
        (s: VoiceConnectionState) =>
          s.status === 'connected' && !!this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
    if ('exception' in fetched) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
      return false
    }

    this._cleanupCurrentAudioStream('source-seek')

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }
    this._fading('seekPrepare', { resource })

    this.setFilters(this.filters)

    logger(
      'debug',
      'Player',
      `Playing resource for guild ${this.guildId} after source seek`
    )
    this.connection.play(resource as unknown)
    await this.waitEvent(
      'playerStateChange',
      (s: VoicePlayerState) => s.status === 'playing'
    )

    this._lyricsBasePosition = position
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0

    this._scheduleCrossfade(position)
    return true
  }

  /**
   * Seeks using seekable-stream helper for compatible sources.
   */
  private async _seekeableSeek(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (this.nodelink.options?.mix?.enabled !== false) {
      await this._ensureAudioMixer()
    }

    await getStreamProcessor()
    const seekResourceFactory = createSeekeableAudioResource
    if (!seekResourceFactory) {
      return this._legacySeek(position, endTime)
    }

    logger(
      'debug',
      'Player',
      `Seeking with Seekeable to ${position}ms for guild ${this.guildId}`
    )
    this.position = position

    try {
      const url = this.streamInfo?.url
      if (!url) return false

      const resourceResult = await seekResourceFactory(
        url,
        position,
        endTime,
        this.nodelink,
        this.filters,
        this,
        this.volumePercent / 100,
        this.audioMixer
      )

      if (
        (
          resourceResult as {
            exception?: { message: string; severity?: string }
          }
        ).exception
      ) {
        const exception = (
          resourceResult as {
            exception: { message: string; severity?: string }
          }
        ).exception
        logger(
          'error',
          'Player',
          `Seekeable resource creation failed for guild ${this.guildId}: ${exception.message}. Falling back to old method.`
        )
        this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
          track: this.track,
          exception
        })
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        return this._legacySeek(position, endTime)
      }

      const resource = resourceResult as AudioResource

      if (this.volumePercent !== 100) {
        resource.setVolume(this.volumePercent / 100)
      }
      this._fading('seekPrepare', { resource })
      resource.setFilters(this.filters)

      const oldStream = this.connection?.play(resource as unknown)
      await this.waitEvent(
        'playerStateChange',
        (s: VoicePlayerState) => s.status === 'playing'
      )
      if (oldStream) {
        oldStream.destroy()
      }

      this._lyricsBasePosition = position
      this._lyricsBasePackets =
        this.connection?.statistics?.packetsExpected ?? 0

      this._scheduleCrossfade(position)
      return true
    } catch (e) {
      const err = e as Error
      logger(
        'error',
        'Player',
        `An unexpected error occurred during seekeable seek for guild ${this.guildId}: ${err.message}. Falling back to old method.`
      )
      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: err.message,
          severity: 'fault',
          cause: 'UNKNOWN_ERROR'
        }
      })
      this._emitTrackEnd(EndReasons.LOAD_FAILED)
      return this._legacySeek(position, endTime)
    }
  }

  /**
   * Seeks using legacy re-fetch strategy.
   */
  private async _legacySeek(
    position: number,
    endTime?: number
  ): Promise<boolean> {
    if (!this.track) return false
    if (
      position < 0 ||
      (this.track.info.length > 0 && position > this.track.info.length)
    )
      return false

    logger(
      'debug',
      'Player',
      `Seeking with legacy method to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(
      trackInfo,
      undefined,
      this._isRecovering
    )
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )
      await this.waitEvent(
        'stateChange',
        (s: VoiceConnectionState) =>
          s.status === 'connected' && !!this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
    if ('exception' in fetched) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
      return false
    }

    this._cleanupCurrentAudioStream('legacy-seek')

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }
    this._fading('seekPrepare', { resource })

    this.setFilters(this.filters)

    logger(
      'debug',
      'Player',
      `Playing resource for guild ${this.guildId} after legacy seek`
    )
    this.connection.play(resource as unknown)
    await this.waitEvent(
      'playerStateChange',
      (s: VoicePlayerState) => s.status === 'playing'
    )

    this._lyricsBasePosition = position
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0

    this._scheduleCrossfade(position)
    return true
  }

  /**
   * Stops playback and emits STOPPED if applicable.
   *
   * @returns True when stop was executed; false when no active track.
   */
  public stop(): boolean {
    this.isUpdatingTrack = true
    try {
      if (this.destroying || !this.track) return false

      if (this.nextResource) {
        this.nextResource.destroy()
        this.nextResource = null
        this.nextTrack = null
        this.nextStreamInfo = null
      }

      if (this.connection && this.connStatus !== 'destroyed') {
        if (this.connection.audioStream) {
          this._isStopping = true
          if (this._fading('trackStop')) return true
          this._isStopping = false
          this.connection.stop(EndReasons.STOPPED)
        } else {
          this._emitTrackEnd(EndReasons.STOPPED)
          this._resetTrack()
        }
      } else {
        this._emitTrackEnd(EndReasons.STOPPED)
        this._resetTrack()
      }
      return true
    } finally {
      this.isUpdatingTrack = false
    }
  }

  /**
   * Preloads the next track for gapless playback.
   *
   * @param payload - Track to prepare in advance.
   * @returns True when preload succeeded.
   */
  public async preload(payload: PlayerTrack): Promise<boolean> {
    if (this.destroying) return false

    const crossfadeConfig = this._getCrossfadeConfig()
    const audioStream = this._getAudioStream()
    const pipelineDead =
      typeof audioStream?.isFlushed === 'function' && audioStream.isFlushed()
    const bridgeDraining =
      typeof audioStream?.isBridgeDraining === 'function' &&
      audioStream.isBridgeDraining()
    const shouldPrepareCrossfade =
      !!crossfadeConfig && !!this.track && !pipelineDead

    logger('debug', 'Crossfade', `preload() called for guild ${this.guildId}`, {
      hasCrossfadeConfig: !!crossfadeConfig,
      hasTrack: !!this.track,
      shouldPrepareCrossfade,
      pipelineDead,
      bridgeDraining,
      crossfadeCompletionActive: !!this._crossfadeCompletionContext,
      trackIdentifier: payload.info?.identifier,
      crossfadeDuration: crossfadeConfig?.durationMs ?? 'N/A'
    })
    const hasPreparedCrossfade =
      !!this.nextCrossfadeTrack && !!this.nextCrossfadePcm

    const sameEncoded =
      !!payload.encoded &&
      !!this.nextTrack?.encoded &&
      this.nextTrack.encoded === payload.encoded
    const sameIdentifier =
      !!payload.info?.identifier &&
      !!this.nextTrack?.info?.identifier &&
      this.nextTrack.info.identifier === payload.info.identifier
    const isDuplicatePreload =
      (sameEncoded || sameIdentifier) &&
      !!this.nextResource &&
      (!shouldPrepareCrossfade || hasPreparedCrossfade)

    if (isDuplicatePreload) {
      logger(
        'debug',
        'Crossfade',
        `Skipping duplicate nextTrack preload for guild ${this.guildId}`,
        {
          identifier: payload.info?.identifier,
          encodedMatch: sameEncoded,
          identifierMatch: sameIdentifier
        }
      )
      this._scheduleCrossfade(this._realPosition())
      return true
    }

    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
      this.nextStreamInfo = null
    }

    if (this._crossfadeCompletionContext) {
      logger(
        'debug',
        'Crossfade',
        `Deferring preload for guild ${this.guildId} — crossfade blend is active (token ${this._crossfadeCompletionContext.token})`,
        { trackIdentifier: payload.info?.identifier }
      )
      this._pendingPreload = payload
      return true
    }

    const _bridgeActive =
      bridgeDraining ||
      (typeof audioStream?.isBridgeMode === 'function' &&
        audioStream.isBridgeMode())
    this._clearCrossfade({ clearNext: true, force: !_bridgeActive })

    try {
      const trackInfo = {
        ...payload.info,
        audioTrackId: payload.audioTrackId
      }

      const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
      if (urlData.exception) return false

      if (shouldPrepareCrossfade && crossfadeConfig && this.track) {
        logger(
          'debug',
          'Crossfade',
          `Crossfade preload requested for guild ${this.guildId}`,
          {
            durationMs: crossfadeConfig.durationMs,
            mode: crossfadeConfig.mode,
            minBufferMs: crossfadeConfig.minBufferMs,
            bufferMs: crossfadeConfig.bufferMs
          }
        )

        if (crossfadeConfig.mode === 'preload' && this.track.info.isStream) {
          logger(
            'debug',
            'Crossfade',
            `Crossfade preload skipped for guild ${this.guildId} (stream mode required).`
          )
        } else {
          const total =
            this.track.endTime && this.track.endTime > 0
              ? this.track.endTime
              : this.track.info.length || 0

          if (total > 0 && total < crossfadeConfig.durationMs) {
            logger(
              'debug',
              'Crossfade',
              `Crossfade preload skipped for guild ${this.guildId} (track shorter than ${crossfadeConfig.durationMs}ms).`
            )
          } else {
            const pcmFetched = await this._fetchPcmResource(
              payload.info,
              urlData,
              0
            )
            if ('exception' in pcmFetched) return true

            this.nextCrossfadeTrack = payload
            this.nextCrossfadePcm = pcmFetched.stream
            this.nextCrossfadeStreamInfo = {
              ...urlData,
              trackInfo: payload.info
            }

            this.nextResource = pcmFetched.stream
            this.nextTrack = payload
            this.nextStreamInfo = { ...urlData, trackInfo: payload.info }

            logger(
              'debug',
              'Crossfade',
              `Crossfade preload ready for guild ${this.guildId}`,
              { nextTrack: payload.info.identifier }
            )

            this._prepareCrossfadeBuffer({
              durationMs: crossfadeConfig.durationMs,
              minBufferMs: crossfadeConfig.minBufferMs,
              bufferMs: crossfadeConfig.bufferMs
            })
            this._scheduleCrossfade(this._realPosition())
            return true
          }
        }
      }

      const fetched = await this._fetchResource(payload.info, urlData, 0)
      if ('exception' in fetched) return false

      this.nextTrack = payload
      this.nextResource = fetched.stream
      this.nextStreamInfo = { ...urlData, trackInfo: payload.info }

      if (this.volumePercent !== 100) {
        this.nextResource.setVolume(this.volumePercent / 100)
      }
      this.nextResource.setFilters(this.filters)

      if (pipelineDead && !bridgeDraining && this.connection) {
        logger(
          'debug',
          'Player',
          `Pipeline dead after crossfade — directly starting next track for guild ${this.guildId}`,
          { nextTrack: payload.info?.identifier }
        )

        const nextTrack = this.nextTrack
        const nextStreamInfo = this.nextStreamInfo
        const resource = this.nextResource

        if (this.track) {
          this._emitTrackEnd(EndReasons.GAPLESS)
        }

        this.track = nextTrack
        this.nextTrack = null
        this.nextResource = null
        this.streamInfo = nextStreamInfo
        this.nextStreamInfo = null

        this.position = 0
        this._lyricsBasePosition = 0
        this._lyricsBasePackets =
          this.connection.statistics?.packetsExpected ?? 0

        this._crossfadeIgnoreIdle = true

        this.connection.play(resource as unknown)
      }

      return true
    } catch (err) {
      const error = err as Error
      logger(
        'error',
        'Player',
        `Preload failed for guild ${this.guildId}: ${error.message}`
      )
      return false
    }
  }

  /**
   * Clears any queued/preloaded next track and cancels pending crossfade prep.
   *
   * @returns True when state was cleared.
   */
  public clearNextTrack(): boolean {
    if (this.destroying) return false

    this._pendingPreload = null
    const hasActiveCrossfade = !!this._crossfadeCompletionContext

    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
    }

    this.nextTrack = null
    this.nextStreamInfo = null

    if (hasActiveCrossfade) {
      if (this.nextCrossfadePcm) {
        this.nextCrossfadePcm.destroy()
        this.nextCrossfadePcm = null
      }
      if (this.nextCrossfadeResource) {
        this.nextCrossfadeResource.destroy()
        this.nextCrossfadeResource = null
      }
      this.nextCrossfadeTrack = null
      this.nextCrossfadeStreamInfo = null

      logger(
        'debug',
        'Crossfade',
        `clearNextTrack(): preserving active crossfade for guild ${this.guildId}`
      )
      return true
    }

    this._clearCrossfade({ clearNext: true, force: true })
    return true
  }

  /**
   * Pauses or resumes playback.
   *
   * @param shouldPause - True to pause, false to resume.
   * @returns True when state changed; false otherwise.
   */
  public pause(shouldPause: boolean): boolean {
    if (this.destroying || this.isPaused === shouldPause) return false
    logger(
      'debug',
      'Player',
      `Setting pause to ${shouldPause} for guild ${this.guildId}`
    )

    if (shouldPause) {
      if (this._fading('pause')) {
        this.isPaused = true
        const pumpCtrl = this._getAudioStream()?.crossfadeController
        if (typeof pumpCtrl?.setPumpPaused === 'function')
          pumpCtrl.setPumpPaused(true)
        this.emitEvent(GatewayEvents.PAUSE, { paused: true })
        return true
      }

      this.isPaused = true
      this.connection?.pause?.('requested')
      this._pauseCrossfadeCompletionTimer()
      const pumpCtrl = this._getAudioStream()?.crossfadeController
      if (typeof pumpCtrl?.setPumpPaused === 'function')
        pumpCtrl.setPumpPaused(true)
    } else {
      this.isPaused = false
      this._isResuming = true
      this._fading('resume')
      this.connection?.unpause?.('requested')
      this._resumeCrossfadeCompletionTimer()
      const pumpCtrl = this._getAudioStream()?.crossfadeController
      if (typeof pumpCtrl?.setPumpPaused === 'function')
        pumpCtrl.setPumpPaused(false)
    }

    this.emitEvent(GatewayEvents.PAUSE, { paused: this.isPaused })
    return true
  }

  /**
   * Adjusts playback volume (0-1000).
   *
   * @param level - Volume percentage (0-1000).
   * @returns True when volume was updated.
   */
  public volume(level: number): boolean {
    if (this.destroying) return false
    logger(
      'debug',
      'Player',
      `Setting volume to ${level} for guild ${this.guildId}`
    )
    this.volumePercent = Math.max(0, Math.min(1000, level))
    this.connection?.audioStream?.setVolume(this.volumePercent / 100)
    this.nextResource?.setVolume(this.volumePercent / 100)
    this.nextCrossfadeResource?.setVolume(this.volumePercent / 100)
    this.emitEvent(GatewayEvents.VOLUME_CHANGED, { volume: this.volumePercent })
    return true
  }

  /**
   * Sets fading configuration.
   *
   * @param config - New fading config; disables fading when undefined.
   * @returns Always true.
   */
  public setFading(config?: FadingConfig): boolean {
    this.fading = config
    return true
  }

  /**
   * Sets crossfade configuration.
   *
   * @param config - New crossfade config; disables crossfade when undefined.
   * @returns Always true.
   * @example
   * ```ts
   * player.setCrossfade({ enabled: true, duration: 4000, mode: 'preload' })
   * ```
   */
  public setCrossfade(config?: CrossfadeConfig): boolean {
    this.crossfade = config
    this._clearCrossfade({ clearNext: true })
    return true
  }

  /**
   * Toggles loudness normalization.
   *
   * @param enabled - Whether to enable loudness normalization.
   * @returns True when updated.
   */
  public setLoudnessNormalizer(enabled: boolean): boolean {
    this.loudnessNormalizer = !!enabled
    if (this.connection?.audioStream) {
      this.connection.audioStream.setLoudnessNormalizer?.(
        this.loudnessNormalizer
      )
    }
    return true
  }

  /**
   * Applies audio filters to the active stream.
   *
   * @param filters - Filter payload that replaces the active filter set.
   * @returns True when filters applied; false if player inactive.
   */
  public setFilters(
    filters: FiltersState,
    skipCrossfadeResource = false
  ): boolean {
    if (this.destroying || !this.track) return false
    logger(
      'debug',
      'Player',
      `Applying filters for guild ${this.guildId}:`,
      filters
    )

    const payload =
      (filters.filters as Record<string, unknown> | undefined) ??
      (filters as Record<string, unknown> | undefined)
    const filterTransitions = this._getFilterTransitions()

    const newFilterSettings: Record<string, FilterStateEntry> = {}

    if (payload && Object.keys(payload).length > 0) {
      for (const key in payload) {
        const value = payload[key]
        if (value === null || value === undefined) {
          continue
        }

        if (key === 'equalizer') {
          if (Array.isArray(value)) {
            newFilterSettings[key] = { bands: value }
          } else {
            newFilterSettings[key] = isObjectRecord(value)
              ? (value as FilterStateEntry)
              : { value }
          }
        } else {
          const existing = (
            this.filters.filters as Record<string, unknown> | undefined
          )?.[key]
          if (
            existing &&
            typeof existing === 'object' &&
            !Array.isArray(existing) &&
            typeof value === 'object' &&
            !Array.isArray(value)
          ) {
            const merged: Record<string, unknown> = {
              ...(existing as Record<string, unknown>),
              ...(value as Record<string, unknown>)
            }
            const mergedFilter = merged as FilterStateEntry
            if (mergedFilter._disabled) {
              delete mergedFilter._disabled
            }
            newFilterSettings[key] = mergedFilter
          } else {
            newFilterSettings[key] = {
              ...(value as Record<string, unknown>)
            }
            const newFilter = newFilterSettings[key]
            if (isObjectRecord(newFilter) && newFilter._disabled) {
              delete newFilter._disabled
            }
          }
        }

        const filterBlock = newFilterSettings[key]
        if (
          filterBlock &&
          typeof filterBlock === 'object' &&
          !filterBlock.transition &&
          filterTransitions?.enabled
        ) {
          filterBlock.transition = {
            durationMs: filterTransitions.durationMs ?? 4000,
            curve: filterTransitions.curve ?? 'sinusoidal'
          }
        }
      }
    }

    const oldFilters =
      (this.filters.filters as Record<string, unknown> | undefined) || {}
    for (const key in oldFilters) {
      if (!(key in newFilterSettings)) {
        const existingFilter = oldFilters[key] as FilterStateEntry | undefined
        if (existingFilter?._disabled === true) continue

        const isTransitionEnabled = filterTransitions?.enabled
        if (isTransitionEnabled) {
          newFilterSettings[key] = {
            _disabled: true,
            transition: {
              durationMs: filterTransitions.durationMs ?? 4000,
              curve: filterTransitions.curve ?? 'sinusoidal'
            }
          }
        }
      }
    }

    this.filters = { ...this.filters, filters: newFilterSettings }

    if (this.connection?.audioStream) {
      this._snapshotPosition()
      this.connection.audioStream.setFilters(this.filters)
    }
    this.nextResource?.setFilters(this.filters)
    if (!skipCrossfadeResource) {
      this.nextCrossfadeResource?.setFilters(this.filters)
    }

    const disabledKeys: string[] = []
    for (const key in newFilterSettings) {
      const val = newFilterSettings[key]
      if (val?._disabled === true) {
        disabledKeys.push(key)
      }
    }
    if (disabledKeys.length > 0) {
      const maxTransitionMs = Math.max(
        ...disabledKeys.map((key) => {
          const val = newFilterSettings[key]
          const tr = val?.transition
          return tr?.durationMs ?? 4000
        })
      )
      const cleanupTimer = setTimeout(() => {
        const current = (this.filters.filters ?? {}) as Record<string, unknown>
        let changed = false
        for (const key of disabledKeys) {
          const entry = current[key] as FilterStateEntry | undefined
          if (entry?._disabled === true) {
            delete current[key]
            changed = true
          }
        }
        if (changed) {
          this.filters = { ...this.filters, filters: current }
        }
      }, maxTransitionMs + 500)
      cleanupTimer.unref?.()
    }

    this.emitEvent(GatewayEvents.FILTERS_CHANGED, { filters: this.filters })

    return true
  }

  /**
   * Updates the voice state for this player.
   *
   * @param voicePayload - Session/token/endpoint/channel updates.
   * @param force - Forces reconnect even when unchanged.
   */
  public updateVoice(
    voicePayload: Partial<PlayerVoiceState> = {},
    force = false
  ): void {
    if (this.destroying) return

    const { sessionId, token, endpoint, channelId } = voicePayload

    let changed = false
    if (sessionId !== undefined && this.voice.sessionId !== sessionId) {
      this.voice.sessionId = sessionId
      changed = true
    }
    if (token !== undefined && this.voice.token !== token) {
      this.voice.token = token
      changed = true
    }
    if (endpoint !== undefined && this.voice.endpoint !== endpoint) {
      this.voice.endpoint = endpoint
      changed = true
    }
    if (channelId !== undefined && this.voice.channelId !== channelId) {
      this.voice.channelId = channelId
      changed = true
    }

    if (this.voice.sessionId && this.voice.token && this.voice.endpoint) {
      if (!changed && !force) {
        logger(
          'debug',
          'Player',
          `Voice state for guild ${this.guildId} is unchanged. Skipping update.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Updating voice state for guild ${this.guildId}`
      )
      if (!this.connection) this._initConnection()
      if (this.voice.channelId && this.connection) {
        this.connection.channelId = this.voice.channelId
      }
      this.connection?.voiceStateUpdate({ session_id: this.voice.sessionId })
      this.connection?.voiceServerUpdate({
        token: this.voice.token,
        endpoint: this.voice.endpoint
      })
      this.connection?.connect(async () => {
        if (this.destroying) return
        if (this.connection?.audioStream && !this.isPaused) {
          this.connection.unpause?.('reconnected')
        }

        if (
          this.track &&
          !this.connection?.audioStream &&
          !this.isUpdatingTrack
        ) {
          logger(
            'debug',
            'Player',
            `Voice state updated for guild ${this.guildId}, starting pending track.`
          )
          await this._startPlayback()
        }
      })
    } else {
      logger(
        'warn',
        'Player',
        `Incomplete voice update for guild ${this.guildId}. Missing sessionId, token, or endpoint.`
      )
    }
  }

  /**
   * Destroys the player and cleans up the voice connection.
   *
   * @param emitClose - Whether to emit WEBSOCKET_CLOSED to the client.
   */
  public destroy(emitClose = true): void {
    if (this.destroying) return
    this.destroying = true

    logger('debug', 'Player', `Destroying player for guild ${this.guildId}`)
    if (this.connection) {
      try {
        if (this.connection.audioStream) {
          this.connection.stop(EndReasons.CLEANUP)
          this._cleanupCurrentAudioStream('destroy')
        }
        this.connection.destroy()
        this.connection = null
      } catch (err) {
        const error = err as Error
        logger(
          'error',
          'internal',
          `Failed to destroy connection for guild ${this.guildId}: ${error.message} `
        )
      }
    }
    if (emitClose) {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: 1000,
        reason: 'destroyed by client',
        byRemote: false
      })
    }
    this.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
      guildId: this.guildId
    })
    this._resetTrack()
    this.connStatus = 'destroyed'
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
  }

  /**
   * Adds an additional mix layer over the main stream.
   *
   * @param trackPayload - Track to mix in PCM form.
   * @param volume - Optional mix volume (0-1). Defaults to mix config.
   * @throws Error when no active main stream or mixer limits exceeded.
   */
  public async addMix(
    trackPayload: PlayerTrack,
    volume: number | null = null
  ): Promise<{
    id: string
    track: PlayerTrack
    volume: number
  }> {
    if (!this.track || this.isPaused) {
      throw new Error('Cannot add mix without an active stream')
    }

    await this._ensureAudioMixer()
    if (!this.audioMixer) throw new Error('AudioMixer not initialized')

    const mixConfig = this.nodelink?.options?.mix ?? {
      enabled: true,
      defaultVolume: 0.8,
      maxLayersMix: 5
    }

    if (this.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)) {
      throw new Error(
        `Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`
      )
    }

    const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8

    const { createAudioResource: createResource } = await import(
      './processing/streamProcessor.ts'
    )

    const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info)
    if (!urlData || !urlData.url) {
      throw new Error('Failed to get stream URL for mix track')
    }

    const fetched = await this.nodelink.sources.getTrackStream(
      (urlData.newTrack?.info as TrackInfoExtended) || trackPayload.info,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )

    if (fetched.exception) {
      throw new Error(fetched.exception.message)
    }

    const pcmResource = createResource(
      fetched.stream,
      fetched.type || (urlData.format as string) || 'unknown',
      this.nodelink,
      {},
      mixVolume,
      null,
      true
    ) as AudioResource & { stream: VoiceAudioStream }

    const mixId = this.audioMixer.addLayer(
      pcmResource.stream,
      trackPayload,
      mixVolume
    )

    return {
      id: mixId,
      track: trackPayload,
      volume: mixVolume
    }
  }

  /**
   * Removes a mix layer by id.
   *
   * @param mixId - Identifier returned by addMix.
   * @returns True when removed.
   */
  public removeMix(mixId: string): boolean {
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.removeLayer(mixId)
  }

  /**
   * Updates the volume of a mix layer.
   *
   * @param mixId - Identifier of the mix layer.
   * @param volume - New volume (0-1).
   * @returns True when updated; false if layer missing.
   */
  public updateMix(mixId: string, volume: number): boolean {
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.updateLayerVolume(mixId, volume)
  }

  /**
   * Lists active mix layers.
   *
   * @returns Current mix layers with track and volume.
   */
  public getMixes(): Array<{
    id: string
    track: PlayerTrack
    volume: number
    position: number
    startTime: number
  }> {
    if (!this.audioMixer) {
      return []
    }
    return this.audioMixer.getLayers()
  }

  /**
   * Subscribes to lyrics events for the current track.
   *
   * @param skipTrackSource - When true, skips track source provider before fetching lyrics.
   */
  public async subscribeLyrics(
    skipTrackSource: boolean | string | undefined
  ): Promise<void> {
    return new Promise((resolve) => {
      if (this.isLyricsSubscribed) {
        return resolve()
      }

      this.isLyricsSubscribed = true
      this.skipTrackSource =
        skipTrackSource === 'true' || skipTrackSource === true

      if (this.track && !this.isPaused) {
        this._loadLyrics().catch((error: unknown) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          logger(
            'warn',
            'Lyrics',
            `Failed to load lyrics for guild ${this.guildId}: ${errorMessage} `
          )
        })
      }

      return resolve()
    })
  }

  /**
   * Unsubscribes from lyrics events.
   */
  public async unsubscribeLyrics(): Promise<void> {
    return new Promise((resolve) => {
      this.isLyricsSubscribed = false
      this.skipTrackSource = false
      this.currentLyrics = null
      this.lyricsLineIndex = -1
      if (this._lyricsMarkerTimer) {
        clearTimeout(this._lyricsMarkerTimer)
        this._lyricsMarkerTimer = null
      }
      return resolve()
    })
  }

  /**
   * Loads lyrics for the current track and emits events.
   */
  private async _loadLyrics(): Promise<void> {
    if (!this.track) return

    const lyricsManager =
      this.nodelink.lyrics ?? (await this.nodelink.getLyricsManager?.())
    if (!lyricsManager) return

    const lyricsData = await lyricsManager.loadLyrics(
      { info: this.track.info },
      undefined,
      this.skipTrackSource
    )

    if (lyricsData && lyricsData.loadType === 'lyrics') {
      const lines: LyricsLine[] = lyricsData.data.lines.map((line) => ({
        timestamp: line.time,
        duration: line.duration || 0,
        line: line.text,
        words: line.words || [],
        plugin: {}
      }))

      for (let i = 0; i < lines.length - 1; i++) {
        const current = lines[i]
        const next = lines[i + 1]
        if (!current || !next) continue
        if (current.duration === 0) {
          current.duration = next.timestamp - current.timestamp
        }
      }

      const payload: LyricsPayload = {
        sourceName: this.track.info.sourceName,
        provider: lyricsData.data.provider,
        text: lyricsData.data.lines.map((l) => l.text).join('\n'),
        lines,
        plugin: {}
      }

      this.currentLyrics = payload
      this.lyricsLineIndex = -1
      this.emitEvent('LyricsFoundEvent', { lyrics: this.currentLyrics })
      if (this._lyricsMarkerTimer) {
        clearTimeout(this._lyricsMarkerTimer)
        this._lyricsMarkerTimer = null
      }
      this._recalculateLyricsIndex(undefined, undefined, true)
      this._syncLyrics(true)
    } else {
      this.currentLyrics = null
      this.emitEvent('LyricsNotFoundEvent')
    }
  }

  /**
   * Synchronizes lyrics with current playback position.
   */
  private _syncLyrics(force = false): void {
    if (
      !this.isLyricsSubscribed ||
      !this.currentLyrics ||
      !this.currentLyrics.lines
    )
      return
    if (this._lyricsMarkerTimer && !force) return

    const timescale = this._getTimescale()
    const playbackSpeed = timescale.speed * timescale.rate
    const position = this._getLyricsPosition(playbackSpeed)
    const lines = this.currentLyrics.lines
    this._recalculateLyricsIndex(position, lines)

    const nextIndex = this.lyricsLineIndex + 1
    const nextLine = lines[nextIndex]
    if (!nextLine) return

    const nextTimestamp = nextLine.timestamp
    const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed)

    this._lyricsMarkerTimer = setTimeout(() => {
      this._lyricsMarkerTimer = null
      if (
        !this.isLyricsSubscribed ||
        !this.currentLyrics ||
        !this.currentLyrics.lines
      )
        return
      const timedLine = this.currentLyrics.lines[nextIndex]
      if (!timedLine) return
      const nowPosition = this._getLyricsPosition(playbackSpeed)
      const drift = nowPosition - nextTimestamp

      if (drift < -15) {
        this._syncLyrics(true)
        return
      }

      if (Math.abs(drift) > 100) {
        this._lyricsBasePosition -= drift * 0.25
      }

      this.lyricsLineIndex = nextIndex
      this.emitEvent('LyricsLineEvent', {
        lineIndex: nextIndex,
        line: timedLine,
        skipped: drift > 60
      })
      this._syncLyrics(true)
    }, delayMs)
  }

  /**
   * Computes current lyrics position based on packets received.
   */
  private _getLyricsPosition(playbackSpeed: number): number {
    if (this._crossfadeCompletionContext) {
      const s = this._getAudioStream()
      const consumed = s?.getCrossfadeConsumedNextMs?.() ?? -1
      if (consumed >= 0) {
        const energySkip = s?.getEnergySkipMs?.() ?? 0
        return energySkip + consumed
      }
    }

    const stats = this.connection?.statistics
    const packets = stats?.packetsExpected ?? this._lyricsBasePackets
    const deltaPackets = Math.max(0, packets - this._lyricsBasePackets)

    return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed
  }

  /**
   * Recalculates the current lyric line index.
   */
  private _recalculateLyricsIndex(
    positionOverride?: number,
    linesOverride?: LyricsLine[],
    allowBackward = false
  ): void {
    if (!this.currentLyrics || !this.currentLyrics.lines) return

    const lines = linesOverride || this.currentLyrics.lines
    let position = positionOverride

    if (position === undefined) {
      const timescale = this._getTimescale()
      const playbackSpeed = timescale.speed * timescale.rate
      position = this._getLyricsPosition(playbackSpeed)
    }

    let foundIndex = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      if (line.timestamp <= position) {
        foundIndex = i
      } else {
        break
      }
    }

    if (!allowBackward && foundIndex < this.lyricsLineIndex) {
      return
    }

    if (foundIndex !== this.lyricsLineIndex) {
      const skipped = foundIndex > this.lyricsLineIndex + 1
      this.lyricsLineIndex = foundIndex

      if (foundIndex !== -1) {
        const line = lines[foundIndex]
        if (!line) return
        this.emitEvent('LyricsLineEvent', {
          lineIndex: foundIndex,
          line: line,
          skipped
        })
      }
    }
  }

  /**
   * Serializes player state to JSON-safe object.
   */
  public toJSON(): PlayerStateJSON {
    return {
      guildId: this.guildId,
      track: this.track,
      volume: this.volumePercent,
      fading: this.fading,
      crossfade: this.crossfade,
      loudnessNormalizer: this.loudnessNormalizer,
      paused: this.isPaused,
      filters: this.filters,
      state: {
        time: Date.now(),
        position: this._realPosition(),
        connected: this.connStatus === 'connected',
        ping: this.connection?.ping ?? 0
      },
      voice: { ...this.voice }
    }
  }

  /**
   * Handles fading, tape, and scratch actions for start/stop/seek/pause events.
   */
  private _fading(
    action:
      | 'reset'
      | 'trackStart'
      | 'trackStartArm'
      | 'trackEndSchedule'
      | 'trackStop'
      | 'seek'
      | 'seekPrepare'
      | 'pause'
      | 'resume',
    payload: { resource?: AudioResource; startPosition?: number } = {}
  ): boolean {
    const timers = this._fadeTimers
    if (!timers) return false

    if (action === 'reset') {
      if (timers.trackEnd) clearTimeout(timers.trackEnd)
      if (timers.pause) {
        if (timers.pause instanceof Object && 'interval' in timers.pause) {
          clearInterval(timers.pause.interval)
          if (timers.pause.timeout) clearTimeout(timers.pause.timeout)
        } else {
          clearTimeout(timers.pause as NodeJS.Timeout)
        }
      }
      if (timers.stop) {
        if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
          clearInterval(timers.stop.interval)
          if (timers.stop.timeout) clearTimeout(timers.stop.timeout)
        } else {
          clearTimeout(timers.stop)
        }
      }
      timers.trackEnd = null
      timers.pause = null
      timers.stop = null
      this._pendingTrackStartFade = false
      return false
    }

    if (action === 'trackEndSchedule' && timers.trackEnd) {
      clearTimeout(timers.trackEnd)
      timers.trackEnd = null
    }

    if (
      this.crossfade?.enabled &&
      this.nextCrossfadeTrack &&
      this.nextCrossfadeResource
    )
      return false
    if (!this.fading || this.fading.enabled !== true) return false

    let section: FadingSection | undefined | null = null
    if (action === 'trackStart' || action === 'trackStartArm')
      section = this.fading.trackStart
    else if (action === 'trackEndSchedule') section = this.fading.trackEnd
    else if (action === 'trackStop') section = this.fading.trackStop
    else if (action === 'seek' || action === 'seekPrepare')
      section = this.fading.seek
    else if (action === 'pause') section = this.fading.pause
    else if (action === 'resume') section = this.fading.resume
    else return false

    if (!section || !Number.isFinite(section.duration) || section.duration <= 0)
      return false

    const fadeType = section.type || 'volume'
    const scratchStyle =
      (section.curve as import('../typings/playback/processing.types.ts').ScratchStyle) ||
      'random'

    if (fadeType === 'tape' || fadeType === 'scratch') {
      this._snapshotPosition()
    }

    if (action === 'trackStartArm') {
      const resource = payload.resource
      if (!resource) return false
      if (fadeType === 'volume' || fadeType === 'both') {
        if (resource.setFadeVolume) resource.setFadeVolume(0)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if (resource.tapeTo) resource.tapeTo(0, 'stop')
      }
      if (fadeType === 'scratch') {
        if (resource.scratchTo) resource.scratchTo(0, 'stop')
      }
      this._pendingTrackStartFade = true
      return true
    }

    if (action === 'trackStart') {
      if (!this._pendingTrackStartFade) return false
      const stream =
        (payload.resource as AudioResource | undefined)?.stream ||
        this.connection?.audioStream
      if (!stream) return false
      this._pendingTrackStartFade = false

      if (fadeType === 'volume' || fadeType === 'both') {
        if ((stream as AudioResource).fadeTo)
          (stream as AudioResource).fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if ((stream as AudioResource).tapeTo)
          (stream as AudioResource).tapeTo?.(
            section.duration,
            'start',
            section.curve
          )
      }
      if (fadeType === 'scratch') {
        if ((stream as AudioResource).scratchTo)
          (stream as AudioResource).scratchTo?.(section.duration, scratchStyle)
      }
      return true
    }

    if (action === 'seekPrepare') {
      const resource = payload.resource
      if (!resource) return false
      if (fadeType === 'volume' || fadeType === 'both') {
        if (resource.setFadeVolume) resource.setFadeVolume(0)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        if (resource.tapeTo) resource.tapeTo(0, 'stop')
      }
      if (fadeType === 'scratch') {
        if (resource.scratchTo) resource.scratchTo(0, 'stop')
      }
      return true
    }

    if (action === 'seek') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false

      if (fadeType === 'volume' || fadeType === 'both') {
        if (stream.setFadeVolume) stream.setFadeVolume(0)
        stream.fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'start', section.curve)
      }
      if (fadeType === 'scratch') {
        stream.scratchTo?.(section.duration, 'start')
      }
      return true
    }

    if (action === 'pause') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      logger(
        'debug',
        'Crossfade',
        `Pause fade triggered; freezing crossfade timers for guild ${this.guildId}`
      )
      this._pauseCrossfadeCompletionTimer()
      if (timers.trackEnd) {
        clearTimeout(timers.trackEnd)
        timers.trackEnd = null
      }
      if (timers.pause) {
        if (timers.pause instanceof Object && 'interval' in timers.pause) {
          const pauseTimer = timers.pause as {
            interval: NodeJS.Timeout
            timeout?: NodeJS.Timeout
          }
          clearInterval(pauseTimer.interval)
          if (pauseTimer.timeout) clearTimeout(pauseTimer.timeout)
        } else {
          clearTimeout(timers.pause as NodeJS.Timeout)
        }
      }

      if (fadeType === 'volume' || fadeType === 'both') {
        stream.fadeTo?.(0, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'stop', section.curve)
      }
      if (fadeType === 'scratch') {
        const style = ['wash', 'backspin', 'baby', 'stop'].includes(
          scratchStyle
        )
          ? scratchStyle
          : 'wash'
        stream.scratchTo?.(section.duration, style)
      }

      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime
        const isTapeDone = stream.checkTapeRampCompleted?.()
        const isScratchDone = stream.checkScratchEffectCompleted?.()
        const effectsDone =
          (fadeType !== 'tape' || isTapeDone === true) &&
          (fadeType !== 'scratch' || isScratchDone === true) &&
          (fadeType !== 'both' ||
            (isTapeDone === true && isScratchDone === true))
        const isRampDone = elapsed >= section.duration && effectsDone
        const isTimeUp = elapsed > section.duration + 500 // Safety timeout

        if (isRampDone || isTimeUp) {
          clearInterval(checkInterval)

          const drainTimeout = setTimeout(() => {
            this.connection?.pause?.('requested')
            timers.pause = null
          }, 750)

          const pauseTimer = timers.pause
          if (
            pauseTimer &&
            typeof pauseTimer === 'object' &&
            'interval' in pauseTimer
          ) {
            pauseTimer.timeout = drainTimeout
          }
        }
      }, 10)

      timers.pause = { interval: checkInterval }
      return true
    }

    if (action === 'resume') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      logger(
        'debug',
        'Crossfade',
        `Resume fade triggered; resuming crossfade timers for guild ${this.guildId}`
      )
      this._resumeCrossfadeCompletionTimer()

      if (fadeType === 'volume' || fadeType === 'both') {
        if (stream.setFadeVolume) stream.setFadeVolume(0)
        stream.fadeTo?.(1, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(0, 'stop')
        stream.tapeTo?.(section.duration, 'start', section.curve)
      }
      if (fadeType === 'scratch') {
        stream.scratchTo?.(0, 'stop')
        stream.scratchTo?.(section.duration, 'start')
      }
      return true
    }

    if (action === 'trackStop') {
      const stream = this.connection?.audioStream as AudioResource | undefined
      if (!stream) return false
      if (timers.stop) {
        if (typeof timers.stop === 'object' && 'interval' in timers.stop) {
          clearInterval(timers.stop.interval)
          if (timers.stop.timeout) clearTimeout(timers.stop.timeout)
        } else {
          clearTimeout(timers.stop)
        }
      }

      if (fadeType === 'volume' || fadeType === 'both') {
        stream.fadeTo?.(0, section.duration, section.curve)
      }
      if (fadeType === 'tape' || fadeType === 'both') {
        stream.tapeTo?.(section.duration, 'stop', section.curve)
      }
      if (fadeType === 'scratch') {
        const style = ['wash', 'backspin', 'baby', 'stop'].includes(
          scratchStyle
        )
          ? scratchStyle
          : 'stop'
        stream.scratchTo?.(section.duration, style)
      }

      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime
        const isRampDone = elapsed >= section.duration
        const isTimeUp = elapsed > section.duration + 500 // Safety timeout

        if (isRampDone || isTimeUp) {
          clearInterval(checkInterval)

          const drainTimeout = setTimeout(() => {
            this._isStopping = false
            this.connection?.stop(EndReasons.STOPPED)
            timers.stop = null
          }, 750)

          if (
            timers.stop &&
            typeof timers.stop === 'object' &&
            'interval' in timers.stop
          ) {
            timers.stop.timeout = drainTimeout
          }
        }
      }, 10)

      timers.stop = { interval: checkInterval }
      return true
    }

    if (action === 'trackEndSchedule') {
      if (!this.track?.info) return false
      const total =
        this.track.endTime && this.track.endTime > 0
          ? this.track.endTime
          : this.track.info.length || 0
      if (!Number.isFinite(total) || total <= 0) return false

      const startPosition = payload.startPosition || 0
      const remaining = Math.max(0, total - startPosition)
      const fadeDuration = Math.min(section.duration, remaining)
      const delay = Math.max(0, remaining - fadeDuration)

      timers.trackEnd = setTimeout(() => {
        const stream = this.connection?.audioStream as AudioResource | undefined
        if (stream) {
          if (fadeType === 'volume' || fadeType === 'both') {
            stream.fadeTo?.(0, fadeDuration, section.curve)
          }
          if (fadeType === 'tape' || fadeType === 'both') {
            stream.tapeTo?.(fadeDuration, 'stop', section.curve)
          }
          if (fadeType === 'scratch') {
            const style = ['wash', 'backspin', 'baby', 'stop'].includes(
              scratchStyle
            )
              ? scratchStyle
              : 'wash'
            stream.scratchTo?.(fadeDuration, style)
          }
        }
        if (timers.trackEnd) {
          clearTimeout(timers.trackEnd)
          timers.trackEnd = null
        }
      }, delay)
      return true
    }

    return false
  }
}
