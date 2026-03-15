import { type Readable, Transform, type TransformCallback } from 'node:stream'
import type { FadeCurve } from '../../typings/playback/processing.types.ts'
import { logger } from '../../utils.ts'
import { RingBuffer } from '../structs/RingBuffer.ts'
import { estimateBpmFromOnsets, estimateBpmFromPcm } from './bpmDetector.ts'
import { estimateKeyFromPcm, type KeyResult } from './keyDetector.ts'
import {
  type RealtimeBeatState,
  RealtimeBpmTracker
} from './realtimeBpmTracker.ts'

const HALF_PI = Math.PI / 2
const TWO_PI = Math.PI * 2
const DEFAULT_CURVE: FadeCurve = 'sinusoidal'
const SUPPORTED_CURVES = new Set<FadeCurve>(['linear', 'sine', 'sinusoidal'])
const SOFT_CLIP_THRESHOLD = 28000
const SOFT_CLIP_HEADROOM = 32767 - SOFT_CLIP_THRESHOLD
const MIX_BUS_TARGET_PEAK = 28500
const MIX_BUS_TARGET_PEAK_FUSION = 27800

interface CrossfadeRuntime {
  durationFrames: number
  elapsedFrames: number
  curve: FadeCurve
  style: 'standard' | 'fusion'
  isFinished: boolean
}

/**
 * Options used to buffer the next track for crossfade.
 */
export interface CrossfadePrepareOptions {
  /**
   * Total crossfade duration in milliseconds.
   *
   * This controls how much audio is buffered for the next track.
   */
  durationMs: number

  /**
   * Minimum buffered audio (ms) required before crossfade can start.
   *
   * @defaultValue durationMs
   */
  minBufferMs?: number

  /**
   * Maximum buffer window for the next track (ms).
   *
   * When set to a larger value, the controller keeps more PCM data in memory
   * before pausing the next stream.
   *
   * @defaultValue durationMs
   */
  bufferMs?: number
}

/**
 * Crossfade controller that mixes a buffered next track into the main PCM stream.
 *
 * @remarks
 * - The next track is buffered ahead of time and mixed only during the fade window.
 * - Mixing uses constant-power curves by default to avoid volume dips.
 *
 * @example
 * ```ts
 * const controller = new CrossfadeController(48000, 2)
 * controller.prepareNextStream(nextPcmStream, { durationMs: 5000 })
 * controller.startCrossfade(5000, 'sinusoidal')
 * ```
 */
export class CrossfadeController extends Transform {
  private readonly sampleRate: number
  private readonly channels: number
  private readonly bytesPerMs: number
  private readonly guildId: string
  private bufferSize: number
  private targetBufferBytes: number
  private minBufferBytes: number
  private ringBuffer: RingBuffer | null = null
  private nextStream: Readable | null = null
  private nextPending: Buffer | null = null
  private nextSpillChunks: Buffer[] = []
  private nextSpillBytes = 0
  private mainPending: Buffer | null = null
  private crossfade: CrossfadeRuntime | null = null
  private bufferReady = false
  private warnedCurve: FadeCurve | null = null
  private _bridgePumpRunning = false
  private _flushed = false

  private _pumpPaused = false
  private _pumpPausedAt = 0
  private _pumpTotalPausedMs = 0

  private _bcfStream: Readable | null = null
  private _bcfRing: RingBuffer | null = null
  private _bcfPending: Buffer | null = null
  private _bcfSpillChunks: Buffer[] = []
  private _bcfSpillBytes = 0
  private _bcfReady = false
  private _bcfTargetBytes = 0
  private _bcfMinBytes = 0
  private _bcfBufferSize = 0
  private _bcfRuntime: CrossfadeRuntime | null = null
  private _bcfHpPrevL = 0
  private _bcfHpPrevR = 0
  private _bcfLpPrevL = 0
  private _bcfLpPrevR = 0

  private _bridgeCrossfadeActive = false
  private _bcfConsumedSamples = 0
  /** Freezes _bcfConsumedSamples after blend completes to prevent drift. */
  private _bcfCountFrozen = false

  private _hpEnabled = false
  private _hpDurationFrames = 0
  private _hpPeakAlpha = 0.06
  private _hpPrevL = 0
  private _hpPrevR = 0

  private _lpEnabled = false
  private _lpPeakAlpha = 0.08
  private _lpPrevL = 0
  private _lpPrevR = 0
  /** Fraction of crossfade over which the LP filter opens (default 0.50). */
  private _lpCompletionRatio = 0.5

  private _mainRmsEma = 0
  private _mainRmsPeak = 0

  private _onsetBuffer: number[] = []
  private _prevRmsForOnset = 0
  private _detectedMainBpm: number | null = null
  private _mainBpmDetected = false
  /** Approx. onset samples per second (derived from chunk cadence). */
  private _onsetChunkMs = 20
  private _mainBeatDecimate = 0
  private _mainOnsetAccum = 0
  private _mainDeltaAccum = 0

  private _mainKeyPcm: Buffer[] = []
  private _mainKeyPcmBytes = 0
  private _mainKeyDetected = false
  private _detectedMainKey: KeyResult | null = null
  /** Max bytes to capture for key detection (~10 s stereo 48 kHz 16-bit). */
  private get _mainKeyMaxBytes(): number {
    return this.sampleRate * this.channels * 2 * 10
  }

  private _nextRmsEma = 0
  private _nextRmsPeak = 0
  private _nextOpeningEnergyAcc = 0
  private _nextOpeningEnergyMs = 0
  private _nextOpeningEnergy = 0
  private readonly _nextOpeningWindowMs = 4000

  private _nextOnsetBuffer: number[] = []
  private _nextPrevRmsForOnset = 0
  private _detectedNextBpm: number | null = null
  private _nextBpmDetected = false
  private _nextOnsetChunkMs = 20
  private _nextBeatDecimate = 0
  private _nextOnsetAccum = 0
  private _nextDeltaAccum = 0
  private _nextBeatTracker = new RealtimeBpmTracker()
  private _nextBeatState: RealtimeBeatState = this._nextBeatTracker.getState()
  private _lastRealtimeNextBpmLogSec = 0

  private _nextKeyPcm: Buffer[] = []
  private _nextKeyPcmBytes = 0
  private _nextKeyDetected = false
  private _detectedNextKey: KeyResult | null = null
  private get _nextKeyMaxBytes(): number {
    return this.sampleRate * this.channels * 2 * 10
  }

  private _totalNextConsumedSamples = 0
  private _incomingGain = 1

  /**
   * Called once after the bridge pump fully drains Track B's ring buffer.
   * Set by the player to flush deferred filter state into the live pipeline.
   */
  public onBridgeDrained: (() => void) | null = null

  /**
   * Called when the bridge pump is about to exhaust (ring empty, stream dead)
   * and no B→C blend is active.  The player uses this to fire the pending
   * crossfade timer immediately instead of letting the bridge die.
   * After calling this, the bridge pump pushes silence frames for up to
   * MAX_BRIDGE_SILENCE_MS while waiting for a bridge crossfade to appear.
   */
  public onBridgeStarving: (() => void) | null = null

  /**
   * Optional synchronous filter processor for bridge-pump audio.
   *
   * During bridge mode, audio bypasses the upstream FiltersManager because
   * `this.push()` writes directly to the readable side.  When set, the
   * bridge pump pipes each PCM chunk through this callback so that user-
   * applied filters (karaoke, lowpass, highpass, etc.) take effect.
   */
  public filterProcessor: ((chunk: Buffer) => Buffer) | null = null

  /**
   * Sets the upstream FiltersManager bypass flag.  When true, the upstream
   * _transform passes chunks through raw — all filter processing moves to
   * filterProcessor inside this controller, avoiding double-processing.
   */
  public filterBypassSetter: ((bypass: boolean) => void) | null = null

  /**
   * Resets the upstream FiltersManager's internal filter state (clears echo
   * delay lines, reverb buffers, etc.) so Track B audio never touches
   * stale Track A filter data.
   */
  public filterStateResetter: (() => void) | null = null

  /** Guards against triggering bypass/reset more than once per crossfade. */
  private _bypassTriggered = false

  private _panEnabled = false
  private _panCompletionRatio = 0.3

  private _panOutEnabled = false
  private _panOutCompletionRatio = 0.5

  private _echoEnabled = false
  private _echoDelayFrames = 0
  private _echoPeakMix = 0.2
  private _echoFeedback = 0.3
  /** Fraction of crossfade over which the echo dries out (default 0.65). */
  private _echoCompletionRatio = 0.65
  private _echoDelayL: Float64Array | null = null
  private _echoDelayR: Float64Array | null = null
  private _echoWritePos = 0

  private _bcfEchoDelayL: Float64Array | null = null
  private _bcfEchoDelayR: Float64Array | null = null
  private _bcfEchoWritePos = 0

  private _energySkipMs = 0
  private _incomingEntryGainComp = 1
  private _entryPhraseConfidence = 0
  private _entryStability = 0
  private _entryFxCenterShield = 0
  private _entryFxLowDuckBoost = 0
  private _entryFxAirSoftenBoost = 0
  private _entryFxSidechainBoost = 0

  // Clean-room dynamic transition state (tempo/energy/transient responsive)
  private _dynamicMixEnabled = true
  private _dynamicNextRmsEma = 0
  private _dynamicNextTransientEma = 0
  private _dynamicMainBrightnessEma = 0
  private _dynamicNextBrightnessEma = 0
  private _dynamicToneMismatchEma = 1
  private _dynamicPrevMainL = 0
  private _dynamicPrevMainR = 0
  private _dynamicPrevNextL = 0
  private _dynamicPrevNextR = 0
  private _dynamicPulseHz = 0
  private _dynamicFrameCursor = 0
  private _dynamicPulsePhaseOffset = 0
  private _rtBeatTracker = new RealtimeBpmTracker()
  private _rtBeatState: RealtimeBeatState = this._rtBeatTracker.getState()
  private _lastRealtimeBpmLogSec = 0
  private _mainSpecLowLp = 0
  private _mainSpecMidLp = 0
  private _mainSpecHighLp = 0
  private _mainSpecPrevComposite = 0
  private _mainSpecBrightnessEma = 0.42
  private _mainSpecMotionEma = 0.22
  private _mainSpecCentroidEma = 0.38
  private _mainSpecLowAlpha = 0
  private _mainSpecMidAlpha = 0
  private _mainSpecHighAlpha = 0

  // Live multiband unmasking for "medley-like" overlap instead of plain fade.
  private _adaptiveBandBlendEnabled = true
  private _mixBandLowAlpha = 0
  private _mixBandHighAlpha = 0
  private _mixMainLowLpL = 0
  private _mixMainLowLpR = 0
  private _mixNextLowLpL = 0
  private _mixNextLowLpR = 0
  private _mixMainHighLpL = 0
  private _mixMainHighLpR = 0
  private _mixNextHighLpL = 0
  private _mixNextHighLpR = 0

  // Incoming fusion sculpting: environment first, vocal core later.
  private _transitionName: string | null = null
  private _strictNoVocalEntry = false
  private _fusionBlendEnabled = true
  private _fusionTailHoldEnabled = false
  private _fusionOutFloorPeak = 0.5
  private _fusionOutFloorTail = 0.05
  private _fusionBeatMorphEnabled = false
  private _fusionBeatMorphFromHz = 0
  private _fusionBeatMorphToHz = 0
  private _fusionBeatMorphStrength = 0
  private _fusionMainLpL = 0
  private _fusionMainLpR = 0
  private _fusionMainLpAlpha = 0
  private _fusionAmbientLpL = 0
  private _fusionAmbientLpR = 0
  private _fusionBandLowLp = 0
  private _fusionBandHighLp = 0
  private _fusionPrevBand = 0
  private _fusionVocalPresenceEma = 0
  private _fusionBandLowAlpha = 0
  private _fusionBandHighAlpha = 0
  private _fusionAmbientAlpha = 0

  /**
   * Whether the PCM source should be paused when the ring buffer is full.
   * After the crossfade blend finishes, we allow a much larger buffer
   * (ring + spill) so the bridge pump never starves.
   */
  private _shouldPausePcm(): boolean {
    const total = (this.ringBuffer?.length ?? 0) + this.nextSpillBytes
    if (this.crossfade?.isFinished) {
      return total > this.bufferSize + Math.round(5000 * this.bytesPerMs)
    }

    return total >= this.bufferSize
  }

  private readonly onNextData = (chunk: Buffer) => {
    if (!this.ringBuffer) return
    let data = chunk

    if (this.nextPending && this.nextPending.length > 0) {
      data = Buffer.concat([this.nextPending, chunk])
      this.nextPending = null
    }

    const remainder = data.length % 4
    if (remainder > 0) {
      this.nextPending = Buffer.from(data.subarray(data.length - remainder))
      data = data.subarray(0, data.length - remainder)
    }

    if (!data.length || !this.ringBuffer) return

    this._updateNextTrackAnalysis(data)

    this._drainSpillToRing()

    const remaining = this.bufferSize - this.ringBuffer.length
    if (remaining <= 0) {
      this._appendSpill(data)
      if (this._shouldPausePcm()) this._pauseNextStream()
      return
    }

    if (data.length > remaining) {
      this.ringBuffer.write(data.subarray(0, remaining))
      this._appendSpill(data.subarray(remaining))
      this.bufferReady = true
      if (this._shouldPausePcm()) this._pauseNextStream()
      return
    }

    this.ringBuffer.write(data)
    if (this.ringBuffer.length >= this.targetBufferBytes) {
      this.bufferReady = true
      if (this._shouldPausePcm()) this._pauseNextStream()
    }
  }

  private readonly onNextEnd = () => {
    this._pauseNextStream()
  }

  private _appendSpill(data: Buffer): void {
    if (!data.length) return

    this.nextSpillChunks.push(Buffer.from(data))
    this.nextSpillBytes += data.length
  }

  private _drainSpillToRing(): void {
    if (!this.ringBuffer || this.nextSpillChunks.length === 0) return

    let remaining = this.bufferSize - this.ringBuffer.length
    if (remaining <= 0) return
    remaining = remaining - (remaining % 4)
    if (remaining <= 0) return

    while (remaining > 0 && this.nextSpillChunks.length > 0) {
      const chunk = this.nextSpillChunks[0]!
      if (chunk.length <= remaining) {
        this.ringBuffer.write(chunk)
        remaining -= chunk.length
        this.nextSpillBytes -= chunk.length
        this.nextSpillChunks.shift()
      } else {
        const aligned = remaining - (remaining % 4)
        if (aligned <= 0) break
        this.ringBuffer.write(chunk.subarray(0, aligned))
        this.nextSpillChunks[0] = chunk.subarray(aligned)
        this.nextSpillBytes -= aligned
        remaining -= aligned
      }
    }

    if (this.ringBuffer.length >= this.targetBufferBytes) {
      this.bufferReady = true
      this._pauseNextStream()
    }
  }

  private _resumeNextStream(): void {
    const stream = this.nextStream as Readable | null
    if (!stream) return
    if (typeof stream.resume === 'function') stream.resume()
  }

  private readonly _onBcfData = (chunk: Buffer): void => {
    if (!this._bcfRing) return
    let data = chunk
    if (this._bcfPending && this._bcfPending.length > 0) {
      data = Buffer.concat([this._bcfPending, chunk])
      this._bcfPending = null
    }
    const remainder = data.length % 4
    if (remainder > 0) {
      this._bcfPending = Buffer.from(data.subarray(data.length - remainder))
      data = data.subarray(0, data.length - remainder)
    }
    if (!data.length) return

    this._bcfDrainSpill()

    const capacity = this._bcfBufferSize - this._bcfRing.length
    if (capacity >= data.length) {
      this._bcfRing.write(data)
    } else if (capacity > 0) {
      this._bcfRing.write(data.subarray(0, capacity))
      this._bcfSpillChunks.push(Buffer.from(data.subarray(capacity)))
      this._bcfSpillBytes += data.length - capacity
    } else {
      this._bcfSpillChunks.push(Buffer.from(data))
      this._bcfSpillBytes += data.length
    }

    if (!this._bcfReady && this._bcfRing.length >= this._bcfMinBytes) {
      this._bcfReady = true
    }

    const total = this._bcfRing.length + this._bcfSpillBytes
    if (total >= this._bcfBufferSize && this._bcfStream) {
      if (typeof (this._bcfStream as any).pause === 'function') {
        ;(this._bcfStream as any).pause()
      }
    }
  }

  private readonly _onBcfEnd = (): void => {
    if (this._bcfRing && this._bcfRing.length > 0) {
      this._bcfReady = true
    }
  }

  private _bcfDrainSpill(): void {
    if (!this._bcfRing || this._bcfSpillChunks.length === 0) return
    let remaining = this._bcfBufferSize - this._bcfRing.length
    if (remaining <= 0) return
    remaining = remaining - (remaining % 4)
    if (remaining <= 0) return

    while (remaining > 0 && this._bcfSpillChunks.length > 0) {
      const chunk = this._bcfSpillChunks[0]!
      if (chunk.length <= remaining) {
        this._bcfRing.write(chunk)
        remaining -= chunk.length
        this._bcfSpillBytes -= chunk.length
        this._bcfSpillChunks.shift()
      } else {
        const aligned = remaining - (remaining % 4)
        if (aligned <= 0) break
        this._bcfRing.write(chunk.subarray(0, aligned))
        this._bcfSpillChunks[0] = chunk.subarray(aligned)
        this._bcfSpillBytes -= aligned
        remaining -= aligned
      }
    }
  }

  private _bcfResumeStream(): void {
    if (!this._bcfStream) return
    const total = (this._bcfRing?.length ?? 0) + this._bcfSpillBytes
    const limit = this._bcfBufferSize + Math.round(5000 * this.bytesPerMs)
    if (
      total < limit &&
      typeof (this._bcfStream as any).resume === 'function'
    ) {
      ;(this._bcfStream as any).resume()
    }
  }

  /**
   * Prepares a bridge crossfade by buffering Track C's PCM while the
   * bridge pump is actively draining Track B.
   */
  private _prepareBridgeCrossfade(
    stream: Readable,
    options: CrossfadePrepareOptions
  ): void {
    this._clearBridgeCrossfade()

    const durationMs = Math.max(0, options.durationMs)
    const minBufferMs = options.minBufferMs ?? durationMs
    const bufferMs =
      options.bufferMs !== undefined && options.bufferMs > 0
        ? Math.max(minBufferMs, options.bufferMs)
        : durationMs

    this._bcfTargetBytes = Math.round(durationMs * this.bytesPerMs)
    this._bcfMinBytes = Math.round(minBufferMs * this.bytesPerMs)
    this._bcfBufferSize = Math.round(bufferMs * this.bytesPerMs)
    this._bcfRing = new RingBuffer(
      this._bcfBufferSize + Math.round(10000 * this.bytesPerMs)
    )
    this._bcfStream = stream
    this._bcfReady = false

    stream.on('data', this._onBcfData)
    stream.on('end', this._onBcfEnd)
    stream.on('close', this._onBcfEnd)
    stream.on('error', this._onBcfEnd)

    if (typeof (stream as any).resume === 'function') {
      ;(stream as any).resume()
    }

    logger('debug', 'Crossfade', 'Bridge crossfade: buffering Track C', {
      durationMs,
      minBufferMs,
      bufferMs
    })
  }

  /**
   * Activates the bridge crossfade blend inside the bridge pump.
   * @returns True when blend has been activated.
   */
  private _startBridgeCrossfade(
    durationMs: number,
    curve?: FadeCurve,
    style: 'standard' | 'fusion' = 'standard'
  ): boolean {
    if (!this._bcfRing || !this._bcfReady) return false

    const durationFrames = Math.max(
      1,
      Math.round((durationMs / 1000) * this.sampleRate)
    )
    this._bcfRuntime = {
      durationFrames,
      elapsedFrames: 0,
      curve: this._resolveCurve(curve),
      style,
      isFinished: false
    }
    this._transitionName = null
    this._resetDynamicMixState()
    this._bootstrapDynamicPulse()
    this._configureFusionMixProfile(durationFrames)
    this._bcfHpPrevL = 0
    this._bcfHpPrevR = 0

    this._bridgeCrossfadeActive = true
    this._bcfConsumedSamples = 0
    this._bcfCountFrozen = false
    this._energySkipMs = 0
    this._incomingEntryGainComp = 1
    this._entryPhraseConfidence = 0
    this._entryStability = 0
    this._entryFxCenterShield = 0
    this._entryFxLowDuckBoost = 0
    this._entryFxAirSoftenBoost = 0
    this._entryFxSidechainBoost = 0

    this.filterBypassSetter?.(false)

    logger('info', 'Crossfade', 'Bridge crossfade: blend starting', {
      durationMs,
      curve: this._bcfRuntime.curve
    })
    return true
  }

  /**
   * Checks whether Track C has enough buffered audio for bridge crossfade.
   */
  public isBridgeCrossfadeReady(): boolean {
    return this._bcfReady
  }

  /**
   * Sets the upstream FiltersManager bypass flag without touching the
   * internal _bypassTriggered one-shot guard.  This lets the player
   * control bypass independently of the _transform lifecycle — e.g.
   * disabling bypass after crossfade completion so the next automix
   * pre-lead can build filter state (echo delay lines, reverb buffers).
   */
  /**
   * Pauses or resumes the bridge pump's time-based pacing.
   *
   * When paused, the pump stops consuming from the ring buffer so a
   * long pause doesn't exhaust Track B/C audio and kill the pipeline.
   * On resume, accumulated pause time is subtracted from wall-clock
   * elapsed so the pacing budget picks up exactly where it left off.
   */
  public setPumpPaused(paused: boolean): void {
    if (paused === this._pumpPaused) return
    if (paused) {
      this._pumpPaused = true
      this._pumpPausedAt = Date.now()
    } else {
      this._pumpPaused = false
      if (this._pumpPausedAt > 0) {
        this._pumpTotalPausedMs += Date.now() - this._pumpPausedAt
        this._pumpPausedAt = 0
      }
    }
  }

  public setFilterBypass(bypass: boolean): void {
    this.filterBypassSetter?.(bypass)
  }

  /**
   * Swaps Track C's buffers into the main slot after bridge crossfade blend
   * completes.  The bridge pump then continues draining Track C seamlessly.
   */
  private _swapBridgeCrossfade(): void {
    if (this.nextStream) {
      this.nextStream.removeListener('data', this.onNextData)
      this.nextStream.removeListener('end', this.onNextEnd)
      this.nextStream.removeListener('close', this.onNextEnd)
      this.nextStream.removeListener('error', this.onNextEnd)
      if (typeof (this.nextStream as any).destroy === 'function') {
        ;(this.nextStream as any).destroy()
      }
    }

    this.ringBuffer?.dispose()
    this.nextSpillChunks = []
    this.nextSpillBytes = 0
    this.nextPending = null

    if (this._bcfStream) {
      this._bcfStream.removeListener('data', this._onBcfData)
      this._bcfStream.removeListener('end', this._onBcfEnd)
      this._bcfStream.removeListener('close', this._onBcfEnd)
      this._bcfStream.removeListener('error', this._onBcfEnd)
    }

    this.nextStream = this._bcfStream
    this.ringBuffer = this._bcfRing
    this.nextSpillChunks = this._bcfSpillChunks
    this.nextSpillBytes = this._bcfSpillBytes
    this.nextPending = this._bcfPending

    if (this.nextStream) {
      this.nextStream.on('data', this.onNextData)
      this.nextStream.on('end', this.onNextEnd)
      this.nextStream.on('close', this.onNextEnd)
      this.nextStream.on('error', this.onNextEnd)
    }

    if (this._bcfBufferSize > 0) {
      this.bufferSize = this._bcfBufferSize
    }

    this._bcfStream = null
    this._bcfRing = null
    this._bcfPending = null
    this._bcfSpillChunks = []
    this._bcfSpillBytes = 0
    this._bcfRuntime = null
    this._bcfReady = false
    this._bcfTargetBytes = 0
    this._bcfMinBytes = 0
    this._bcfBufferSize = 0
    this._bcfHpPrevL = 0
    this._bcfHpPrevR = 0
    this._bcfLpPrevL = 0
    this._bcfLpPrevR = 0

    this.filterBypassSetter?.(true)

    this.filterStateResetter?.()

    this._bcfCountFrozen = true

    logger(
      'info',
      'Crossfade',
      'Bridge crossfade: swap complete — Track C is now main'
    )
  }

  private _clearBridgeCrossfade(): void {
    if (this._bcfStream) {
      this._bcfStream.removeListener('data', this._onBcfData)
      this._bcfStream.removeListener('end', this._onBcfEnd)
      this._bcfStream.removeListener('close', this._onBcfEnd)
      this._bcfStream.removeListener('error', this._onBcfEnd)
      if (typeof (this._bcfStream as any).pause === 'function') {
        ;(this._bcfStream as any).pause()
      }
    }
    this._bcfStream = null
    this._bcfPending = null
    this._bcfSpillChunks = []
    this._bcfSpillBytes = 0
    this._bcfRing?.dispose()
    this._bcfRing = null
    this._bcfRuntime = null
    this._bcfReady = false
    this._bcfTargetBytes = 0
    this._bcfMinBytes = 0
    this._bcfBufferSize = 0
    this._bcfHpPrevL = 0
    this._bcfHpPrevR = 0
    this._bcfLpPrevL = 0
    this._bcfLpPrevR = 0
  }

  /**
   * Creates a new CrossfadeController.
   *
   * @param guildId - The guild ID for this controller (optional for API streams).
   * @param sampleRate - PCM sample rate (Hz).
   * @param channels - Number of audio channels.
   */
  constructor(guildId?: string, sampleRate = 48000, channels = 2) {
    super()
    this.guildId = guildId || 'api-stream'
    this.sampleRate = sampleRate
    this.channels = channels
    this.bytesPerMs = (this.sampleRate * this.channels * 2) / 1000
    this.bufferSize = Math.round(this.bytesPerMs * 1000)
    this.targetBufferBytes = 0
    this.minBufferBytes = 0
    this._fusionBandLowAlpha = this._computeOnePoleAlpha(220)
    this._fusionBandHighAlpha = this._computeOnePoleAlpha(2800)
    this._fusionAmbientAlpha = this._computeOnePoleAlpha(1800)
    this._fusionMainLpAlpha = this._computeOnePoleAlpha(1700)
    this._mainSpecLowAlpha = this._computeOnePoleAlpha(180)
    this._mainSpecMidAlpha = this._computeOnePoleAlpha(900)
    this._mainSpecHighAlpha = this._computeOnePoleAlpha(3200)
    this._mixBandLowAlpha = this._computeOnePoleAlpha(180)
    this._mixBandHighAlpha = this._computeOnePoleAlpha(2600)

    this.setMaxListeners(20)
  }

  override push(chunk: any, encoding?: BufferEncoding): boolean {
    return super.push(chunk, encoding)
  }

  /**
   * Whether the Transform's _flush has been entered, meaning _transform
   * will never be called again and no crossfade blend can execute.
   *
   * Returns false while the bridge pump is still actively draining Track B
   * audio — the pipeline is still alive (pushing audio downstream) even
   * though _transform will never be called again.
   */
  public isFlushed(): boolean {
    return this._flushed && !this._bridgePumpRunning
  }

  /**
   * Whether the bridge pump is actively draining Track B's ring buffer
   * inside _flush().  During this phase the pipeline is still pushing
   * audio downstream, but no new crossfade can be set up on this controller.
   */
  public isBridgeDraining(): boolean {
    return this._bridgePumpRunning
  }

  /**
   * Prepares a buffered next track stream for crossfading.
   *
   * @param stream - PCM stream for the next track.
   * @param options - Buffering options.
   * @example
   * ```ts
   * controller.prepareNextStream(pcmStream, { durationMs: 4000 })
   * ```
   */
  public prepareNextStream(
    stream: Readable,
    options: CrossfadePrepareOptions
  ): void {
    if (this._flushed) {
      if (this._bridgePumpRunning) {
        this._prepareBridgeCrossfade(stream, options)
        return
      }
      logger(
        'debug',
        'Crossfade',
        'prepareNextStream rejected: controller is flushed (pipeline dead)'
      )
      return
    }

    if (this.crossfade?.isFinished) {
      logger(
        'debug',
        'Crossfade',
        'prepareNextStream: post-blend state (isFinished, !flushed) → routing to bridge crossfade path'
      )
      this._prepareBridgeCrossfade(stream, options)
      return
    }

    this.clear()
    this.nextStream = stream

    const durationMs = Math.max(0, options.durationMs)
    const minBufferMs =
      options.minBufferMs !== undefined
        ? Math.max(0, options.minBufferMs)
        : durationMs
    const bufferMs =
      options.bufferMs !== undefined && options.bufferMs > 0
        ? Math.max(minBufferMs, options.bufferMs)
        : durationMs

    this.targetBufferBytes = Math.round(durationMs * this.bytesPerMs)
    this.minBufferBytes = Math.round(minBufferMs * this.bytesPerMs)
    this.bufferSize = Math.max(1, Math.round(bufferMs * this.bytesPerMs))
    this.ringBuffer = new RingBuffer(this.bufferSize)

    stream.on('data', this.onNextData)
    stream.once('end', this.onNextEnd)
    stream.once('close', this.onNextEnd)
    stream.once('error', this.onNextEnd)

    // Ensure the stream actually flows after re-bind (important after seek,
    // where previous controller instances may have paused this stream).
    this._resumeNextStream()
  }

  /**
   * Returns the buffered duration (ms) available for crossfade.
   */
  public getBufferedMs(): number {
    if (this._bridgePumpRunning && this._bcfRing) {
      return this._bcfRing.length / this.bytesPerMs
    }
    if (!this.ringBuffer) return 0
    return this.ringBuffer.length / this.bytesPerMs
  }

  /**
   * Indicates whether the controller is currently acting as a seamless bridge
   * for the next track (Track B) after the main track (Track A) has ended.
   */
  public isBridgeMode(): boolean {
    if (this._bcfRuntime && !this._bcfRuntime.isFinished) return false
    return (
      this.crossfade?.isFinished === true &&
      (!this.mainPending || this.mainPending.length === 0)
    )
  }

  /**
   * Returns the current crossfade status.
   */
  public getState(): {
    active: boolean
    bufferedMs: number
    targetMs: number
    isFinished: boolean
  } {
    if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
      return {
        active: true,
        bufferedMs: (this._bcfRing?.length ?? 0) / this.bytesPerMs,
        targetMs: this._bcfTargetBytes / this.bytesPerMs,
        isFinished: false
      }
    }
    return {
      active: this.crossfade !== null,
      bufferedMs: this.getBufferedMs(),
      targetMs: this.targetBufferBytes / this.bytesPerMs,
      isFinished: this.crossfade?.isFinished ?? false
    }
  }

  /**
   * Indicates whether enough audio is buffered to start crossfade.
   */
  public isReady(): boolean {
    if (this._bridgePumpRunning && this._bcfRing && this._bcfReady) return true
    if (!this.ringBuffer) return false
    if (this.bufferReady) return true
    return this.ringBuffer.length >= this.minBufferBytes
  }

  /**
   * Starts the crossfade mix.
   *
   * @param durationMs - Crossfade duration in milliseconds.
   * @param curve - Fade curve to apply.
   * @returns True when crossfade has started.
   * @example
   * ```ts
   * if (controller.isReady()) {
   *   controller.startCrossfade(3000, 'linear')
   * }
   * ```
   */
  public startCrossfade(
    durationMs: number,
    curve?: FadeCurve,
    style: 'standard' | 'fusion' = 'standard'
  ): boolean {
    if (this._flushed) {
      if (this._bridgePumpRunning && this._bcfRing && this._bcfReady) {
        return this._startBridgeCrossfade(durationMs, curve, style)
      }
      if (this.ringBuffer && this.ringBuffer.length > 0) {
      } else {
        return false
      }
    }
    if (!this.ringBuffer || !this.isReady()) return false
    this._drainSpillToRing()
    this._resumeNextStream()
    if (!Number.isFinite(durationMs) || durationMs <= 0) return false

    const durationFrames = Math.max(
      1,
      Math.round((durationMs / 1000) * this.sampleRate)
    )
    this.crossfade = {
      durationFrames,
      elapsedFrames: 0,
      curve: this._resolveCurve(curve),
      style,
      isFinished: false
    }
    this._resetDynamicMixState()
    this._bootstrapDynamicPulse()
    this._configureFusionMixProfile(durationFrames)
    this._hpPrevL = 0
    this._hpPrevR = 0
    if (this._hpEnabled) {
      this._hpDurationFrames = durationFrames
    }
    return true
  }

  /**
   * Scans Track B's buffer and skips forward until it finds a window that
   * matches the target RMS energy and (optionally) the target beat phase.
   */
  public seekToEnergyMatch(
    targetRms: number,
    crossfadeDurationMs: number,
    transitionName?: string | null,
    targetBeatState?: RealtimeBeatState | null
  ): void {
    if (!this.ringBuffer || this.ringBuffer.length < 4) return

    const rawTransition =
      typeof transitionName === 'string' ? transitionName : ''
    const transitionParts = rawTransition.split('|').filter((p) => p.length > 0)
    const transition = transitionParts[0] ?? ''
    const transitionFlags = new Set(transitionParts.slice(1))
    const forceNoVocalEntry = transitionFlags.has('no-vocal-entry')
    const strictNoVocalEntry = transitionFlags.has('strict-no-vocal')
    const fallbackHint = transitionFlags.has('fallback')
    this._strictNoVocalEntry = strictNoVocalEntry
    this._transitionName = transition || null

    const isFusion = this._isFusionTransition(transition)
    const isFusionPremium =
      transition === 'fusion_morph' || transition === 'harmonic_weave'
    const reserveMs = strictNoVocalEntry
      ? Math.max(2200, Math.min(crossfadeDurationMs * 0.4, 7000))
      : Math.max(3200, Math.min(crossfadeDurationMs * 0.55, 9000))
    const requiredBytes = Math.round(crossfadeDurationMs * this.bytesPerMs)
    const reserveBytes = Math.round(reserveMs * this.bytesPerMs)
    let maxScannableBytes = this.ringBuffer.length - reserveBytes
    if (maxScannableBytes <= 0) return
    const fusionIntroGuardWindows = fallbackHint
      ? isFusionPremium
        ? 8
        : 10
      : isFusionPremium
        ? 4
        : 6 // 3 seconds max skip for fusion (was 5s)

    // Standardize scan window to 60s for better phrase detection.
    // Fusion should stay close to the beginning so the entry feels like a medley,
    // not a jump cut into a later vocal phrase.
    const scanLimitMs = isFusion
      ? forceNoVocalEntry || fallbackHint
        ? isFusionPremium
          ? 8000
          : 9500
        : isFusionPremium
          ? 3600
          : 4600
      : forceNoVocalEntry
        ? 12000
        : 60000
    const scanLimitBytes = Math.round(scanLimitMs * this.bytesPerMs)
    maxScannableBytes = Math.min(maxScannableBytes, scanLimitBytes)

    const peekData = this.ringBuffer.peek(maxScannableBytes)
    if (!peekData) return

    const samples = peekData.length >> 1
    const windowSamples = Math.floor(this.sampleRate * 0.5) * this.channels // 500ms windows
    if (samples < windowSamples * 2) return

    let target = Math.max(targetRms > 0 ? targetRms : 0.05, 0.03)

    const preferPunchyEntry =
      transition === 'cinema_lift' ||
      transition === 'pulse_tunnel' ||
      transition === 'filter_sweep' ||
      transition === 'highpass_dissolve'

    // Fusion mode: prioritize beat phase alignment for transparent handoffs.
    const targetPhase =
      targetBeatState?.locked && targetBeatState.bpm > 0
        ? targetBeatState.phase
        : null
    const targetBpm = targetBeatState?.bpm ?? null

    const energies: number[] = []
    const transients: number[] = []
    const phases: number[] = []
    const vocalDensities: number[] = []
    const windowPeaks: number[] = []
    const windowCrests: number[] = []
    const spectralBrightness: number[] = []
    const spectralMotion: number[] = []
    const spectralCentroids: number[] = []

    const vocalLowAlpha = this._computeOnePoleAlpha(220)
    const vocalHighAlpha = this._computeOnePoleAlpha(2800)
    const specLowAlpha = this._computeOnePoleAlpha(170)
    const specMidAlpha = this._computeOnePoleAlpha(900)
    const specHighAlpha = this._computeOnePoleAlpha(3200)
    const phaseConfidenceGate = isFusion ? 0.62 : 0.5
    const hardVocalCeiling = strictNoVocalEntry
      ? isFusionPremium
        ? 0.26
        : 0.3
      : forceNoVocalEntry
        ? isFusion
          ? 0.34
          : 0.4
        : isFusion
          ? 0.42
          : 0.62
    const hardPeakCeiling = strictNoVocalEntry
      ? 0.92
      : forceNoVocalEntry
        ? 0.95
        : 0.98
    const hardCrestCeiling = strictNoVocalEntry
      ? 3.1
      : forceNoVocalEntry
        ? 3.5
        : 4.0
    const mainBrightnessRef = Math.max(
      0.1,
      Math.min(0.95, this._mainSpecBrightnessEma)
    )
    const mainMotionRef = Math.max(0.04, Math.min(0.9, this._mainSpecMotionEma))
    const mainCentroidRef = Math.max(
      0.08,
      Math.min(0.95, this._mainSpecCentroidEma)
    )

    // Pre-track B analysis for phase alignment if needed
    const bBeatTracker = new RealtimeBpmTracker()
    if (targetPhase !== null && targetBpm) {
      // Warm up tracker with peek data to find B's beat phase
      const stepMs = 20
      const stepSamples =
        Math.floor((stepMs / 1000) * this.sampleRate) * this.channels
      for (let i = 0; i < samples - stepSamples; i += stepSamples) {
        let sumSq = 0
        let count = 0
        for (let j = 0; j < stepSamples; j += this.channels * 2) {
          const sampleIndex = i + j
          if (sampleIndex + this.channels > samples) break
          const l = peekData.readInt16LE(sampleIndex * 2)
          const r =
            this.channels > 1 ? peekData.readInt16LE((sampleIndex + 1) * 2) : l
          const mid = (l + r) * 0.5
          sumSq += mid * mid
          count++
        }
        if (count > 0) {
          const rms = Math.sqrt(sumSq / count) / 32768
          bBeatTracker.push(rms, stepMs / 1000)
        }
      }
    }

    for (let i = 0; i <= samples - windowSamples; i += windowSamples) {
      let sumSq = 0
      let count = 0
      let sumRise = 0
      let riseCount = 0
      let sumAbsMid = 0
      let sumAbsSide = 0
      let sumAbsBand = 0
      let peakAbs = 0
      let bandLowLp = 0
      let bandHighLp = 0
      let specLowLp = 0
      let specMidLp = 0
      let specHighLp = 0
      let specBass = 0
      let specMid = 0
      let specTreble = 0
      let specFlux = 0
      let prevSpecComposite = 0
      let prevMid = peekData.readInt16LE(i * 2)
      for (let j = 0; j < windowSamples; j += this.channels * 2 * 16) {
        const sampleIndex = i + j
        if (sampleIndex + this.channels > samples) break
        const l = peekData.readInt16LE(sampleIndex * 2)
        const r =
          this.channels > 1 ? peekData.readInt16LE((sampleIndex + 1) * 2) : l
        const mid = (l + r) * 0.5
        const side = (l - r) * 0.5
        const absMidSample = Math.abs(mid)
        sumSq += mid * mid
        const d = mid - prevMid
        if (d > 0) {
          sumRise += d
          riseCount++
        }
        prevMid = mid
        bandLowLp += vocalLowAlpha * (mid - bandLowLp)
        bandHighLp += vocalHighAlpha * (mid - bandHighLp)
        const band = bandHighLp - bandLowLp
        specLowLp += specLowAlpha * (mid - specLowLp)
        specMidLp += specMidAlpha * (mid - specMidLp)
        specHighLp += specHighAlpha * (mid - specHighLp)
        const bassBand = Math.abs(specLowLp)
        const midBand = Math.abs(specMidLp - specLowLp)
        const trebleBand = Math.abs(mid - specHighLp)
        specBass += bassBand
        specMid += midBand
        specTreble += trebleBand
        const specComposite = midBand + trebleBand * 1.15
        specFlux += Math.abs(specComposite - prevSpecComposite)
        prevSpecComposite = specComposite
        sumAbsMid += absMidSample
        sumAbsSide += Math.abs(side)
        sumAbsBand += Math.abs(band)
        if (absMidSample > peakAbs) peakAbs = absMidSample
        count++
      }
      if (count === 0) continue
      const energy = Math.sqrt(sumSq / count) / 32768
      energies.push(energy)
      transients.push(riseCount > 0 ? sumRise / riseCount / 32768 : 0)
      const peakNorm = peakAbs / 32768
      windowPeaks.push(peakNorm)
      windowCrests.push(peakNorm / Math.max(energy, 0.012))
      const centerFocus = sumAbsMid / (sumAbsMid + sumAbsSide + 1)
      const bandRatio = sumAbsBand / (sumAbsMid + 1)
      const vocalDensity =
        Math.max(0, Math.min(1, (bandRatio - 0.1) / 0.55)) *
        Math.max(0, Math.min(1, (centerFocus - 0.52) / 0.45))
      vocalDensities.push(vocalDensity)
      const specTotal = specBass + specMid + specTreble + 1
      const bright = Math.max(
        0,
        Math.min(1, (specTreble * 1.12 + specMid * 0.42) / specTotal)
      )
      const motion = Math.max(
        0,
        Math.min(1, specFlux / (specMid + specTreble + 1) / 0.7)
      )
      const centroidNorm = Math.max(
        0,
        Math.min(
          1,
          (specBass * 140 + specMid * 900 + specTreble * 3200) /
            specTotal /
            3800
        )
      )
      spectralBrightness.push(bright)
      spectralMotion.push(motion)
      spectralCentroids.push(centroidNorm)

      if (targetPhase !== null) {
        const timeAtWindow = i / (this.sampleRate * this.channels)
        const bState = bBeatTracker.getState()
        const bpmRatio =
          targetBpm && targetBpm > 0 && bState.bpm > 0
            ? Math.max(targetBpm, bState.bpm) /
              Math.max(1e-6, Math.min(targetBpm, bState.bpm))
            : 1
        const bpmCoherent =
          bpmRatio <= 1.35 || (bpmRatio >= 1.8 && bpmRatio <= 2.25)
        // Estimate phase at this window start
        if (
          bState.locked &&
          bState.bpm > 0 &&
          bState.confidence >= phaseConfidenceGate &&
          bpmCoherent
        ) {
          const period = 60 / bState.bpm
          const cycles = timeAtWindow / period
          const phase = (bState.phase + cycles) % 1
          phases.push(phase)
        } else {
          phases.push(-1)
        }
      } else {
        phases.push(-1)
      }
    }
    if (energies.length < 2) return

    const openingEnergy = energies[0]!
    const openingTransient = transients[0]!
    const openingVocalDensity = vocalDensities[0] ?? 0
    const fusionVocalHardCeiling = isFusionPremium ? 0.28 : 0.32
    const fusionIntroLowVocalThreshold = isFusionPremium
      ? Math.min(0.24, Math.max(0.11, openingVocalDensity - 0.06))
      : Math.min(0.27, Math.max(0.12, openingVocalDensity - 0.05))
    const strictFusionVocalTarget = isFusionPremium ? 0.2 : 0.24
    const sortedEnergies = [...energies].sort((a, b) => a - b)
    const percentile = (p: number): number => {
      const idx = Math.max(
        0,
        Math.min(
          sortedEnergies.length - 1,
          Math.floor((sortedEnergies.length - 1) * p)
        )
      )
      return sortedEnergies[idx] ?? openingEnergy
    }
    const p80 = percentile(0.8)
    const p90 = percentile(0.9)
    const profileCeiling = Math.max(p80, openingEnergy * 1.35, 0.05)
    const originalTarget = target
    if (target > profileCeiling * 1.22) {
      target = profileCeiling * 1.08
    }
    const fusionEnergyFloor = isFusion
      ? Math.max(0.018, Math.min(openingEnergy * 0.72, target * 0.74))
      : 0
    if (preferPunchyEntry) {
      target = Math.max(target, Math.min(0.1, p90 * 0.92))
    }
    const preferControlledEntry =
      (openingEnergy > target * 1.45 && target < 0.17 && openingEnergy > 0.1) ||
      (openingEnergy > 0.24 && target < 0.2 && openingEnergy > target * 1.25)
    const punchyScoring = preferPunchyEntry && !preferControlledEntry

    const forwardSpan = isFusion ? 3 : 2
    const forwardVocalMax = new Array<number>(energies.length).fill(0)
    const forwardPeakMax = new Array<number>(energies.length).fill(0)
    const forwardEnergyMean = new Array<number>(energies.length).fill(0)
    const forwardMotionMean = new Array<number>(energies.length).fill(0)
    for (let i = 0; i < energies.length; i++) {
      let vocalMax = 0
      let peakMax = 0
      let energySum = 0
      let motionSum = 0
      let count = 0
      for (let k = 0; k <= forwardSpan; k++) {
        const idx = i + k
        if (idx >= energies.length) break
        vocalMax = Math.max(vocalMax, vocalDensities[idx] ?? 0)
        peakMax = Math.max(peakMax, windowPeaks[idx] ?? 0)
        energySum += energies[idx] ?? 0
        motionSum += spectralMotion[idx] ?? mainMotionRef
        count++
      }
      const norm = Math.max(1, count)
      forwardVocalMax[i] = vocalMax
      forwardPeakMax[i] = peakMax
      forwardEnergyMean[i] = energySum / norm
      forwardMotionMean[i] = motionSum / norm
    }

    // Choose best window by weighted "energy fit" + phase alignment.
    let bestWindowIdx = 0
    let bestScore = Number.POSITIVE_INFINITY
    let bestFusionIntroIdx = 0
    let bestFusionIntroScore = Number.POSITIVE_INFINITY
    let bestFusionLowVocalIntroIdx = 0
    let bestFusionLowVocalIntroScore = Number.POSITIVE_INFINITY
    const windowScores: number[] = []
    const phraseConfidenceScores: number[] = []
    const stabilityScores: number[] = []
    const eps = 1e-6
    for (let i = 0; i < energies.length; i++) {
      const e = energies[i]!
      const t = transients[i]!
      const p = phases[i]!
      const ratio = (e + eps) / (target + eps)
      // Asymmetric Energy Distance:
      // We are much more tolerant of the track being QUIETER than the target (intro)
      // than we are of it being LOUDER (clipping/energy jump).
      const logDistance = e < target
        ? Math.abs(Math.log(ratio)) * 0.20 // 80% less penalty for quiet intros
        : Math.abs(Math.log(ratio)) * 1.8; // More penalty for being too loud

      let score = logDistance;

      // Penalize forward progress HEAVILY to encourage earliest match.
      score += i * 0.65; 

      const peakNorm = windowPeaks[i] ?? 0
      const crest = windowCrests[i] ?? 1

      // Preference for artistic intros:
      // If Window 0 has reasonable energy (>0.01) and isn't clipping, give it a lead
      // but not so large that poor-quality windows can't be outscored by later ones.
      if (i === 0 && e > 0.01 && peakNorm < 0.95) {
        score -= 2.5;
      } else if (i < 4) {
        score -= 2.0; // Bonus for the first 2 seconds
      }

      const prev = i > 0 ? energies[i - 1]! : e
      const slope = e - prev
      const transientRef = Math.max(openingTransient, 0.003)
      const transientRatio = (t + eps) / (transientRef + eps)
      const vocalDensity = vocalDensities[i] ?? openingVocalDensity
      const brightNow = spectralBrightness[i] ?? mainBrightnessRef
      const motionNow = spectralMotion[i] ?? mainMotionRef
      const centroidNow = spectralCentroids[i] ?? mainCentroidRef
      const spectralDistance =
        Math.abs(brightNow - mainBrightnessRef) * 0.55 +
        Math.abs(motionNow - mainMotionRef) * 0.3 +
        Math.abs(centroidNow - mainCentroidRef) * 0.15
      const nextEnergy = i + 1 < energies.length ? energies[i + 1]! : e
      const nextVocalDensity =
        i + 1 < vocalDensities.length
          ? (vocalDensities[i + 1] ?? vocalDensity)
          : vocalDensity
      const aheadVocalMax = forwardVocalMax[i] ?? vocalDensity
      const aheadPeakMax = forwardPeakMax[i] ?? peakNorm
      const aheadEnergyMean = forwardEnergyMean[i] ?? e
      const aheadMotionMean = forwardMotionMean[i] ?? motionNow
      const entryAttackJump = Math.max(0, nextEnergy - e)
      const grooveDrive = Math.max(
        0,
        Math.min(
          1,
          motionNow * 0.55 +
            Math.max(0, Math.min(1, transientRatio - 0.75)) * 0.35 +
            Math.max(0, 0.35 - vocalDensity) * 0.25
        )
      )
      const vocalSurge = Math.max(0, aheadVocalMax - vocalDensity)
      const peakSurge = Math.max(0, aheadPeakMax - peakNorm)
      const energyDropAhead = Math.max(0, e - aheadEnergyMean)
      const flowInstability =
        vocalSurge * 1.55 +
        peakSurge * 1.2 +
        energyDropAhead * 2.2 +
        Math.max(0, motionNow - aheadMotionMean) * 0.22
      const priorEnergy = i > 0 ? energies[i - 1]! : e
      const prior2Energy = i > 1 ? energies[i - 2]! : priorEnergy
      const preValley = Math.max(0, (priorEnergy + prior2Energy) * 0.5 - e)
      const liftAhead = Math.max(0, aheadEnergyMean - e)
      const attackPenalty = Math.max(0, entryAttackJump - 0.018)
      const phraseRaw =
        preValley * 4.6 +
        liftAhead * 3.2 +
        grooveDrive * 0.75 -
        vocalDensity * 0.95 -
        attackPenalty * 5.2
      const phraseConfidence = Math.max(
        0,
        Math.min(1, (phraseRaw + 0.24) / 0.9)
      )
      const instabilityRaw =
        flowInstability * 0.7 +
        Math.abs(aheadEnergyMean - e) * 2.0 +
        Math.max(0, aheadPeakMax - peakNorm) * 1.1 +
        Math.max(0, aheadVocalMax - vocalDensity) * 1.2
      const stabilityScore = Math.max(0, Math.min(1, 1 - instabilityRaw * 0.45))

      // Phase alignment bonus (up to 0.40 score reduction)
      if (targetPhase !== null && p >= 0) {
        const phaseDist = Math.min(
          Math.abs(p - targetPhase),
          1 - Math.abs(p - targetPhase)
        )
        const phaseMatch = Math.max(0, 1 - phaseDist / 0.15) // Tightened window
        const phaseWeight = isFusion ? 0.7 : 1.5
        score -= phaseMatch * phaseWeight
      }

      // Prefer windows with some upward movement for smoother "arrival".
      if (slope > 0) score -= Math.min(0.12, slope * 2.5)

      // Penalize windows that are much quieter than the target.
      if (e < 0.015) score += 15.0 // Massive penalty for near-silence
      else if (e < target * 0.4) score += 0.5 // Penalty for being too quiet

      if (isFusion || forceNoVocalEntry) {
        score -= grooveDrive * (isFusion ? 0.24 : 0.12)
        score += flowInstability * (isFusion ? 0.55 : 0.32)
        score -= phraseConfidence * (isFusion ? 0.32 : 0.18)
        score -= stabilityScore * (isFusion ? 0.18 : 0.1)
        if (
          entryAttackJump > 0.022 &&
          (vocalDensity > 0.26 || nextVocalDensity > 0.26)
        ) {
          score += Math.min(
            2.1,
            entryAttackJump * 14 +
              Math.max(vocalDensity, nextVocalDensity) -
              0.26
          )
        }
      }

      if (isFusion) {
        score += spectralDistance * 0.62
        if (i <= fusionIntroGuardWindows && spectralDistance < 0.12) {
          score -= 0.1
        }
        if (e < fusionEnergyFloor) {
          const lowEnergyDelta = fusionEnergyFloor - e
          score += Math.min(
            isFusionPremium ? 1.4 : 1.0,
            lowEnergyDelta * (isFusionPremium ? 42 : 30)
          )
        }
        if (peakNorm > 0.82) {
          score += Math.min(1.3, (peakNorm - 0.82) * 3.2)
        } else if (peakNorm < 0.72 && e >= Math.max(0.02, target * 0.62)) {
          score -= 0.08
        }
        if (crest > 2.7) {
          score += Math.min(0.8, (crest - 2.7) * 0.16)
        }
      } else {
        score += spectralDistance * 0.28
      }

      if (preferControlledEntry) {
        const hotPenalty = Math.max(0, Math.min(0.3, (e - target * 1.3) * 2.4))
        score += hotPenalty
        if (transientRatio > 1.12) {
          score += Math.min(0.18, (transientRatio - 1.12) * 0.22)
        }
        if (i === 0) score += 0.22
        if (peakNorm > 0.86) {
          score += Math.min(0.6, (peakNorm - 0.86) * 2.6)
        }
      }

      if (punchyScoring) {
        if (transientRatio > 1) {
          score -= Math.min(0.3, (transientRatio - 1) * 0.14)
        } else {
          score += Math.min(0.14, (1 - transientRatio) * 0.12)
        }
        if (e < 0.05) score += 0.15
      }
      if (strictNoVocalEntry && phraseConfidence < 0.22 && i > 1) {
        score += 0.24
      }

      if (isFusion) {
        const vocalTarget = isFusionPremium ? 0.24 : 0.27
        if (vocalDensity > vocalTarget) {
          score += Math.min(
            1.4,
            (vocalDensity - vocalTarget) * (isFusionPremium ? 2.6 : 2.0)
          )
        } else {
          score -= Math.min(0.24, (vocalTarget - vocalDensity) * 0.7)
        }
        if (vocalDensity > fusionVocalHardCeiling) {
          const excess = vocalDensity - fusionVocalHardCeiling
          score += Math.min(
            isFusionPremium ? 2.4 : 1.8,
            excess * (isFusionPremium ? 5.0 : 3.8)
          )
          if (i <= fusionIntroGuardWindows) {
            score += Math.min(1.2, excess * 4.2)
          }
        }
        if (i < 10 && openingVocalDensity > 0.32) {
          const vocalDrop = openingVocalDensity - vocalDensity
          if (vocalDrop > 0) {
            score -= Math.min(0.52, vocalDrop * 0.78)
          }
        }
        if (forceNoVocalEntry || fallbackHint) {
          const strictTarget = strictNoVocalEntry
            ? 0.17
            : strictFusionVocalTarget
          if (vocalDensity > strictFusionVocalTarget) {
            score += Math.min(
              2.4,
              (vocalDensity - strictTarget) * (strictNoVocalEntry ? 5.0 : 3.8)
            )
          } else {
            score -= Math.min(
              0.36,
              (strictTarget - vocalDensity) * (strictNoVocalEntry ? 1.25 : 0.95)
            )
          }
          if (
            i <= fusionIntroGuardWindows &&
            vocalDensity > strictTarget + 0.04
          ) {
            score += Math.min(
              strictNoVocalEntry ? 2.4 : 1.8,
              (vocalDensity - strictTarget) * (strictNoVocalEntry ? 4.8 : 3.4)
            )
          }
          if (peakNorm > 0.84) {
            score += Math.min(1.2, (peakNorm - 0.84) * 3.4)
          }
          if (strictNoVocalEntry && vocalDensity > 0.24) {
            score += Math.min(2.6, (vocalDensity - 0.24) * 6.2)
          }
        }
      } else if (
        transition === 'crossfade_eq' ||
        transition === 'filter_sweep' ||
        transition === 'highpass_dissolve'
      ) {
        if (vocalDensity > 0.34) {
          score += Math.min(0.48, (vocalDensity - 0.34) * 0.62)
        }
      }

      if (
        (isFusion || forceNoVocalEntry) &&
        aheadVocalMax > hardVocalCeiling + (strictNoVocalEntry ? 0.0 : 0.03)
      ) {
        score +=
          3.8 +
          Math.min(
            2.8,
            (aheadVocalMax - hardVocalCeiling) *
              (strictNoVocalEntry ? 7.0 : 4.8)
          )
      }
      if (aheadPeakMax > hardPeakCeiling) {
        score += 1.4 + Math.min(2.0, (aheadPeakMax - hardPeakCeiling) * 7.0)
      }

      if ((isFusion || forceNoVocalEntry) && vocalDensity > hardVocalCeiling) {
        // Reduced vocal penalty for the very start (first 2 seconds) 
        // to prevent synthetics/drums from being mistaken for vocals.
        const positionMultiplier = i < 4 ? 0.2 : Math.min(1, i / 8)
        score += (5.0 + Math.min(3.4, (vocalDensity - hardVocalCeiling) * 8.0)) * positionMultiplier
      }
      if (peakNorm > hardPeakCeiling) {
        score += 2.0 + Math.min(2.2, (peakNorm - hardPeakCeiling) * 8.0)
      }
      if (crest > hardCrestCeiling) {
        score += Math.min(2.4, (crest - hardCrestCeiling) * 0.9)
      }

      windowScores[i] = score
      phraseConfidenceScores[i] = phraseConfidence
      stabilityScores[i] = stabilityScore

      if (i < 20) {
        logger(
          'debug',
          'AutoMix-Scoring',
          `Window ${i} (${(i * 0.5).toFixed(1)}s): FinalScore=${score.toFixed(3)} [LogDist=${logDistance.toFixed(3)}, Vocal=${vocalDensity.toFixed(2)}, Phrase=${phraseConfidence.toFixed(2)}, Stability=${stabilityScore.toFixed(2)}]`
        )
      }

      if (isFusion && i <= fusionIntroGuardWindows) {
        if (score < bestFusionIntroScore) {
          bestFusionIntroScore = score
          bestFusionIntroIdx = i
        }
        if (
          vocalDensity <= fusionIntroLowVocalThreshold &&
          score < bestFusionLowVocalIntroScore
        ) {
          bestFusionLowVocalIntroScore = score
          bestFusionLowVocalIntroIdx = i
        }
      }

      if (score < bestScore) {
        bestScore = score
        bestWindowIdx = i
      }
    }

    const rankedWindows = windowScores
      .map((score, idx) => ({ idx, score }))
      .sort((a, b) => a.score - b.score)
    const shortlistCount = strictNoVocalEntry
      ? 12
      : forceNoVocalEntry
        ? 9
        : isFusion
          ? 8
          : 6
    const shortlist = rankedWindows.slice(0, shortlistCount)
    // Force Window 0 into the shortlist if it is not already there.
    // The start of the song is too important to be discarded by initial scoring.
    if (!shortlist.some((c) => c.idx === 0)) {
      shortlist.push({ idx: 0, score: windowScores[0] ?? Number.POSITIVE_INFINITY })
    }

    if (shortlist.length > 0) {
      let rerankIdx = shortlist[0]!.idx
      let rerankBest = Number.POSITIVE_INFINITY
      for (const candidate of shortlist) {
        const i = candidate.idx
        const vocal = vocalDensities[i] ?? 1
        const peak = windowPeaks[i] ?? 1
        const crest = windowCrests[i] ?? 10
        const aheadVocal = forwardVocalMax[i] ?? vocal
        const aheadPeak = forwardPeakMax[i] ?? peak
        const e = energies[i] ?? 0
        const aheadE = forwardEnergyMean[i] ?? e
        const phrase = phraseConfidenceScores[i] ?? 0
        const stability = stabilityScores[i] ?? 0
        const instabilityPenalty =
          Math.max(0, aheadVocal - vocal) * 2.2 +
          Math.max(0, aheadPeak - peak) * 1.6 +
          Math.max(0, e - aheadE) * 2.0 +
          Math.max(0, 1 - stability) * 0.9
        const vocalPenalty =
          Math.max(0, vocal - (strictNoVocalEntry ? 0.22 : 0.3)) * 4.2 +
          Math.max(0, aheadVocal - (strictNoVocalEntry ? 0.24 : 0.34)) * 3.3
        const clipPenalty =
          Math.max(0, peak - 0.9) * 3.0 + Math.max(0, crest - 3.2) * 0.9
        
        // Quadratic Position Penalty: 
        // 0s = 0, 0.5s = 0.4, 1s = 1.6, 2s = 6.4, 3s = 14.4, 5s = 40.0
        // Gentle enough for the first 2-3s so audio quality (vocal density,
        // phrase boundary, stability) can outweigh a small positional shift.
        const positionPenalty = isFusion
          ? Math.pow(i * 0.4, 2) * 2.5
          : strictNoVocalEntry
            ? i * 0.15
            : i * 0.08

        const rerankScore =
          candidate.score * 0.8 + 
          instabilityPenalty * 0.5 + 
          vocalPenalty +
          clipPenalty +
          positionPenalty -
          phrase * 0.15 - 
          stability * 0.1 

        logger(
          'debug',
          'AutoMix-ReRank',
          `Candidate Window ${i}: RerankScore=${rerankScore.toFixed(3)} [Base=${(candidate.score * 0.8).toFixed(3)}, PosPen=${positionPenalty.toFixed(2)}, VocalPen=${vocalPenalty.toFixed(2)}]`
        )

        if (rerankScore < rerankBest) {
          rerankBest = rerankScore
          rerankIdx = i
        }
      }
      bestWindowIdx = rerankIdx
      bestScore = windowScores[bestWindowIdx] ?? bestScore
    }

    // --- FINAL DECISION ---
    // Re-ranking is the sole authority. All legacy overrides removed.

    const selectedEnergy = energies[bestWindowIdx] ?? openingEnergy
    const selectedPeak = windowPeaks[bestWindowIdx] ?? 0
    const selectedCrest = windowCrests[bestWindowIdx] ?? 1
    const selectedVocalDensity =
      vocalDensities[bestWindowIdx] ?? openingVocalDensity
    const selectedPhraseConfidence = phraseConfidenceScores[bestWindowIdx] ?? 0
    const selectedStability = stabilityScores[bestWindowIdx] ?? 0
    const selBright = spectralBrightness[bestWindowIdx] ?? mainBrightnessRef
    const selMotion = spectralMotion[bestWindowIdx] ?? mainMotionRef
    const selCentroid = spectralCentroids[bestWindowIdx] ?? mainCentroidRef
    const selectedSpectralDistance =
      Math.abs(selBright - mainBrightnessRef) * 0.55 +
      Math.abs(selMotion - mainMotionRef) * 0.3 +
      Math.abs(selCentroid - mainCentroidRef) * 0.15
    const peakRisk = Math.max(0, Math.min(1, (selectedPeak - 0.8) / 0.18))
    const crestRisk = Math.max(0, Math.min(1, (selectedCrest - 2.6) / 1.8))
    const energyRisk = Math.max(0, Math.min(1, (selectedEnergy - 0.22) / 0.22))
    const vocalRisk = Math.max(
      0,
      Math.min(1, (selectedVocalDensity - 0.2) / 0.45)
    )
    const spectralRisk = Math.max(
      0,
      Math.min(1, selectedSpectralDistance / 0.4)
    )
    const entryRisk = Math.max(
      peakRisk,
      crestRisk * 0.85 + energyRisk * 0.35,
      vocalRisk * 0.88 + spectralRisk * 0.22
    )
    const minEntryGain = strictNoVocalEntry ? 0.46 : 0.52
    this._incomingEntryGainComp = Math.max(
      minEntryGain,
      Math.min(1, 1 - entryRisk * 0.4)
    )
    if (strictNoVocalEntry && selectedPeak > 0.92) {
      this._incomingEntryGainComp = Math.min(this._incomingEntryGainComp, 0.62)
    }
    if (strictNoVocalEntry && selectedVocalDensity > 0.3) {
      this._incomingEntryGainComp = Math.min(this._incomingEntryGainComp, 0.58)
    }
    this._entryPhraseConfidence = selectedPhraseConfidence
    this._entryStability = selectedStability
    this._entryFxCenterShield = Math.max(
      0,
      Math.min(
        0.48,
        Math.max(0, selectedVocalDensity - 0.14) * 0.9 +
          Math.max(0, 1 - selectedStability) * 0.26 +
          Math.max(0, 0.45 - selectedPhraseConfidence) * 0.2
      )
    )
    this._entryFxLowDuckBoost = Math.max(
      0,
      Math.min(
        0.26,
        Math.max(0, selectedPeak - 0.78) * 0.7 +
          Math.max(0, selectedEnergy - 0.16) * 0.75
      )
    )
    this._entryFxAirSoftenBoost = Math.max(
      0,
      Math.min(
        0.24,
        Math.max(0, selectedSpectralDistance - 0.12) * 0.9 +
          Math.max(0, selectedVocalDensity - 0.24) * 0.35
      )
    )
    this._entryFxSidechainBoost = Math.max(
      0,
      Math.min(
        0.28,
        entryRisk * 0.3 +
          Math.max(0, selectedPhraseConfidence - 0.25) * 0.16 +
          Math.max(0, 1 - selectedStability) * 0.12
      )
    )

    if (bestWindowIdx > 0) {
      // Correct Skip Calculation: 
      // bestWindowIdx is the index of 500ms windows.
      const skipMs = bestWindowIdx * 500
      
      // Hard cap skip to keep Fusion in the opening bars.
      const openingVocalHeavy =
        isFusion &&
        (forceNoVocalEntry ||
          openingVocalDensity > (isFusionPremium ? 0.24 : 0.28))
      const baseMaxSkipMs = isFusion
        ? openingVocalHeavy
          ? fallbackHint
            ? isFusionPremium
              ? 3000
              : 4000
            : isFusionPremium
              ? 2000
              : 3000
          : isFusionPremium
            ? 800
            : 1200
        : strictNoVocalEntry
          ? Math.min(3000, Math.round(crossfadeDurationMs * 0.5))
          : forceNoVocalEntry
            ? Math.min(4000, Math.round(crossfadeDurationMs * 0.7))
            : Math.min(6000, Math.round(crossfadeDurationMs * 1.0))
      const fusionAbsoluteCapMs = isFusion
        ? openingVocalHeavy
          ? Math.max(1000, Math.min(3000, Math.round(crossfadeDurationMs * 0.2)))
          : Math.max(200, Math.min(800, Math.round(crossfadeDurationMs * 0.08)))
        : Number.POSITIVE_INFINITY
      const maxSkipMs =
        !isFusion && punchyScoring && !forceNoVocalEntry
          ? baseMaxSkipMs * 1.5
          : Math.min(baseMaxSkipMs, fusionAbsoluteCapMs)

      const finalSkipMs = Math.min(skipMs, maxSkipMs)
      const skipBytes = Math.round(finalSkipMs * this.bytesPerMs)
      // Ensure absolute 4-byte alignment (Int16 Stereo = 2 channels * 2 bytes)
      const finalSkip = skipBytes - (skipBytes % 4)

      if (finalSkip > 0 && finalSkip < this.ringBuffer.length - reserveBytes) {
        logger(
          'debug',
          'AutoMix-Skip',
          `Executing skip: ${finalSkipMs}ms (${finalSkip} bytes) | bestWindowIdx: ${bestWindowIdx} | maxAllowed: ${maxSkipMs}ms`
        )
        this.ringBuffer.skip(finalSkip)
        this._energySkipMs = Math.round(finalSkip / this.bytesPerMs)
        const spectralMatch = Math.max(
          0,
          Math.min(1, 1 - selectedSpectralDistance)
        )
        logger(
          'info',
          'AutoMix',
          `Skipped ${this._energySkipMs}ms in Track B to optimal entry (energy: ${(energies[bestWindowIdx]! * 100).toFixed(1)}%, vocal-density: ${((vocalDensities[bestWindowIdx] ?? 0) * 100).toFixed(0)}%, peak: ${((windowPeaks[bestWindowIdx] ?? 0) * 100).toFixed(0)}%, spectral-match: ${(spectralMatch * 100).toFixed(0)}%, phrase: ${(selectedPhraseConfidence * 100).toFixed(0)}%, stability: ${(selectedStability * 100).toFixed(0)}%, entry-gain: ${this._incomingEntryGainComp.toFixed(2)}, phase-align: ${targetPhase !== null}, transition: ${transition || 'unknown'})`
        )
      }
    }
  }

  /**
   * Enables an inline highpass sweep on the incoming track.
   * The filter starts heavy (thin sound) and opens fully by the end of the crossfade.
   * Call before startCrossfade().
   *
   * @param enabled - Whether to enable the highpass sweep.
   * @param peakAlpha - Peak alpha coefficient at start of sweep (0.12 default).
   *                    Higher = more bass removed initially. BPM-adaptive.
   */
  public setIncomingHighpass(enabled: boolean, peakAlpha?: number): void {
    this._hpEnabled = enabled
    if (typeof peakAlpha === 'number' && Number.isFinite(peakAlpha)) {
      this._hpPeakAlpha = Math.max(0.02, Math.min(0.1, peakAlpha))
    }
  }

  /**
   * Enables an inline lowpass sweep on Track B: starts muffled (treble
   * removed), opens to full spectrum over the first portion of the crossfade.
   * Combined with HP sweep: thin mid-band → bass fills (HP) → treble fills (LP).
   *
   * @param enabled - Whether to enable the lowpass sweep.
   * @param peakAlpha - Starting LP coefficient (default 0.08). Lower = more muffled at start.
   *   Sweep goes from peakAlpha → 1.0 (clean). Range clamped to [0.02, 0.20].
   * @param completionRatio - Fraction of crossfade over which LP opens (default 0.50).
   */
  public setIncomingLowpass(
    enabled: boolean,
    peakAlpha?: number,
    completionRatio?: number
  ): void {
    this._lpEnabled = enabled
    if (typeof peakAlpha === 'number' && Number.isFinite(peakAlpha)) {
      this._lpPeakAlpha = Math.max(0.02, Math.min(0.2, peakAlpha))
    }
    if (
      typeof completionRatio === 'number' &&
      Number.isFinite(completionRatio)
    ) {
      this._lpCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio))
    }
  }

  public setIncomingGain(multiplier: number): void {
    if (!Number.isFinite(multiplier)) {
      this._incomingGain = 1
      return
    }
    this._incomingGain = Math.max(0, Math.min(4, multiplier))
  }

  /**
   * Enables an inline stereo pan sweep on the incoming track.
   * Track B enters from the right channel and sweeps to center over the
   * first portion of the crossfade.  Creates a spatial "arrival" cue.
   *
   * @param enabled - Whether to enable the stereo pan sweep.
   * @param completionRatio - Fraction of crossfade over which pan completes (default 0.5).
   */
  /**
   * Returns the number of milliseconds skipped in Track B by
   * seekToEnergyMatch().  The player should add this to its
   * position baseline so lyrics stay synchronised.
   */
  public getEnergySkipMs(): number {
    return this._energySkipMs
  }

  public setIncomingPan(enabled: boolean, completionRatio?: number): void {
    this._panEnabled = enabled
    if (
      typeof completionRatio === 'number' &&
      Number.isFinite(completionRatio)
    ) {
      this._panCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio))
    }
  }

  /**
   * Enables an inline echo delay on the incoming track (Track B / Track C).
   * Track B enters with a subtle wet echo that dries out over the first
   * portion of the crossfade, creating a "space → clarity" emergence.
   *
   * @param enabled - Whether to enable the echo.
   * @param delayMs - Echo delay in milliseconds (clamped 50–800 ms).
   * @param mix - Wet/dry peak mix ratio (clamped 0.05–0.50).
   * @param feedback - Feedback coefficient (clamped 0.0–0.70).
   * @param completionRatio - Fraction of crossfade over which echo dries (default 0.65).
   */
  public setIncomingEcho(
    enabled: boolean,
    delayMs?: number,
    mix?: number,
    feedback?: number,
    completionRatio?: number
  ): void {
    this._echoEnabled = enabled
    if (!enabled) {
      this._echoDelayL = null
      this._echoDelayR = null
      this._echoWritePos = 0
      return
    }
    if (typeof delayMs === 'number' && Number.isFinite(delayMs)) {
      const clampedMs = Math.max(50, Math.min(800, delayMs))
      this._echoDelayFrames = Math.round((clampedMs / 1000) * this.sampleRate)
    }
    if (typeof mix === 'number' && Number.isFinite(mix)) {
      this._echoPeakMix = Math.max(0.05, Math.min(0.5, mix))
    }
    if (typeof feedback === 'number' && Number.isFinite(feedback)) {
      this._echoFeedback = Math.max(0.0, Math.min(0.45, feedback))
    }
    if (
      typeof completionRatio === 'number' &&
      Number.isFinite(completionRatio)
    ) {
      this._echoCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio))
    }
    if (this._echoDelayFrames > 0) {
      this._echoDelayL = new Float64Array(this._echoDelayFrames)
      this._echoDelayR = new Float64Array(this._echoDelayFrames)
      this._echoWritePos = 0
      this._bcfEchoDelayL = new Float64Array(this._echoDelayFrames)
      this._bcfEchoDelayR = new Float64Array(this._echoDelayFrames)
      this._bcfEchoWritePos = 0
    }
  }

  /**
   * Enables an outgoing stereo pan on Track A: sweeps from center → left.
   * Creates a spatial "departure" cue that mirrors Track B's entrance.
   */
  public setOutgoingPan(enabled: boolean, completionRatio?: number): void {
    this._panOutEnabled = enabled
    if (
      typeof completionRatio === 'number' &&
      Number.isFinite(completionRatio)
    ) {
      this._panOutCompletionRatio = Math.max(
        0.2,
        Math.min(1.0, completionRatio)
      )
    }
  }

  /**
   * Clears the buffered next track and resets crossfade state.
   */
  public extractRemainingBuffer(): Buffer | null {
    const bufs: Buffer[] = []
    if (this.ringBuffer && this.ringBuffer.length > 0) {
      const rbData = this.ringBuffer.read(this.ringBuffer.length)
      if (rbData) bufs.push(rbData)
    }
    if (this.nextSpillChunks.length > 0) bufs.push(...this.nextSpillChunks)
    if (this.nextPending) bufs.push(this.nextPending)

    const result = bufs.length > 0 ? Buffer.concat(bufs) : null
    this.clear()
    return result
  }

  /**
   * Returns how much of the "next track" has been consumed in milliseconds.
   * During a bridge crossfade, returns Track C's consumption instead of
   * Track B's, so the player's position tracking is correct.
   */
  public getConsumedMs(): number {
    return Math.round(
      (this._totalNextConsumedSamples * 1000) / this.sampleRate
    )
  }

  public clear(): void {
    if (this.nextStream) {
      this.nextStream.removeListener('data', this.onNextData)
      this.nextStream.removeListener('end', this.onNextEnd)
      this.nextStream.removeListener('close', this.onNextEnd)
      this.nextStream.removeListener('error', this.onNextEnd)
    }
    this._pauseNextStream()
    this.nextStream = null
    this.nextPending = null
    this.nextSpillChunks = []
    this.nextSpillBytes = 0
    this.mainPending = null
    this.crossfade = null
    this._incomingGain = 1
    this.bufferReady = false
    this.targetBufferBytes = 0
    this.minBufferBytes = 0
    this.ringBuffer?.dispose()
    this.ringBuffer = null
    this._bridgePumpRunning = false
    this._pumpPaused = false
    this._pumpPausedAt = 0
    this._pumpTotalPausedMs = 0
    this._bridgeCrossfadeActive = false
    this._bcfConsumedSamples = 0
    this._bcfCountFrozen = false
    this.onBridgeDrained = null
    this.onBridgeStarving = null
    this._clearBridgeCrossfade()
    if (this._bypassTriggered) {
      this._bypassTriggered = false
      this.filterBypassSetter?.(false)
    }
    this._panEnabled = false
    this._panOutEnabled = false
    this._lpEnabled = false
    this._lpPrevL = 0
    this._lpPrevR = 0
    this._echoEnabled = false
    this._echoDelayL = null
    this._echoDelayR = null
    this._echoWritePos = 0
    this._bcfEchoDelayL = null
    this._bcfEchoDelayR = null
    this._bcfEchoWritePos = 0
    this._energySkipMs = 0
    this._incomingEntryGainComp = 1
    this._entryPhraseConfidence = 0
    this._entryStability = 0
    this._entryFxCenterShield = 0
    this._entryFxLowDuckBoost = 0
    this._entryFxAirSoftenBoost = 0
    this._entryFxSidechainBoost = 0
    this._onsetBuffer = []
    this._prevRmsForOnset = 0
    this._detectedMainBpm = null
    this._mainBpmDetected = false
    this._mainBeatDecimate = 0
    this._mainOnsetAccum = 0
    this._mainDeltaAccum = 0
    this._rtBeatTracker.reset()
    this._rtBeatState = this._rtBeatTracker.getState()
    this._lastRealtimeBpmLogSec = 0
    this._nextRmsEma = 0
    this._nextRmsPeak = 0
    this._totalNextConsumedSamples = 0
    this._nextOpeningEnergyAcc = 0
    this._nextOpeningEnergyMs = 0
    this._nextOpeningEnergy = 0
    this._nextOnsetBuffer = []
    this._nextPrevRmsForOnset = 0
    this._detectedNextBpm = null
    this._nextBpmDetected = false
    this._nextOnsetChunkMs = 20
    this._nextBeatDecimate = 0
    this._nextOnsetAccum = 0
    this._nextDeltaAccum = 0
    this._nextBeatTracker.reset()
    this._nextBeatState = this._nextBeatTracker.getState()
    this._lastRealtimeNextBpmLogSec = 0
    this._nextKeyPcm = []
    this._nextKeyPcmBytes = 0
    this._nextKeyDetected = false
    this._detectedNextKey = null
    this._mainSpecLowLp = 0
    this._mainSpecMidLp = 0
    this._mainSpecHighLp = 0
    this._mainSpecPrevComposite = 0
    this._mainSpecBrightnessEma = 0.42
    this._mainSpecMotionEma = 0.22
    this._mainSpecCentroidEma = 0.38
    this._transitionName = null
    this._strictNoVocalEntry = false
    this._resetDynamicMixState()
  }

  private _pauseNextStream(): void {
    const stream = this.nextStream as Readable | null
    if (!stream) return
    if (typeof stream.pause === 'function') stream.pause()
  }

  private _resolveCurve(curve?: FadeCurve): FadeCurve {
    if (!curve) return DEFAULT_CURVE
    if (SUPPORTED_CURVES.has(curve)) return curve
    if (this.warnedCurve !== curve) {
      this.warnedCurve = curve
      logger(
        'warn',
        'Crossfade',
        `Unsupported curve "${curve}", falling back to ${DEFAULT_CURVE}.`
      )
    }
    return DEFAULT_CURVE
  }

  private _softClipSample(sample: number): number {
    // Robust Exponential Soft-Knee Limiter (Strictly Monotonic)
    // Prevents digital clipping while maintaining harmonic integrity.
    const abs = Math.abs(sample)
    if (abs <= 22000) return sample

    const sign = sample < 0 ? -1 : 1
    // Knee range: 22000 to 32767 (width 10767)
    // We approach the hard limit of 32767 asymptotically using an exponential curve.
    const over = (abs - 22000) / 10767
    const limited = 22000 + 10767 * (1 - Math.exp(-over))
    
    return sign * Math.round(limited)
  }

  private _toInt16Sample(sample: number): number {
    const clipped = this._softClipSample(sample)
    return clipped < -32768
      ? -32768
      : clipped > 32767
        ? 32767
        : (clipped + (clipped > 0 ? 0.5 : -0.5)) | 0
  }

  /**
   * Computes coherence-aware gains.
   * Beat-matched tracks are coherent; standard crossfade (SumSq=1) causes
   * a +3dB boost and clipping. We cross-fade between Equal Power and Equal Gain.
   */
  private _computeCoherenceGains(
    gainOut: number,
    gainIn: number,
    progress: number
  ): [number, number] {
    const beatLocked =
      this._rtBeatState.locked && this._rtBeatState.confidence > 0.45
    // Correlation estimation (Bio-inspired heuristic)
    const correlation = beatLocked
      ? 0.45 + this._rtBeatState.confidence * 0.45
      : 0.12 + (this._dynamicToneMismatchEma < 1.1 ? 0.08 : 0)

    const sumSq = gainOut * gainOut + gainIn * gainIn
    const sum = gainOut + gainIn

    // normP: Equal-power (preserves energy for uncorrelated signals)
    const normP = sumSq > 1e-6 ? 1 / Math.sqrt(sumSq) : 1
    // normG: Equal-gain (prevents clipping for coherent signals)
    const normG = sum > 1e-6 ? 1 / sum : 1

    const adaptiveNorm = normP * (1 - correlation) + normG * correlation

    // Anti-pumping bias: avoid sudden volume dips at 50% blend
    const dipGuard = 1 + Math.sin(progress * Math.PI) * 0.04 * (1 - correlation)
    const finalNorm = adaptiveNorm * dipGuard

    return [gainOut * finalNorm, gainIn * finalNorm]
  }

  private _computeOnePoleAlpha(cutoffHz: number): number {
    if (!Number.isFinite(cutoffHz) || cutoffHz <= 0 || this.sampleRate <= 0) {
      return 0.1
    }
    const alpha = 1 - Math.exp((-TWO_PI * cutoffHz) / this.sampleRate)
    return Math.max(0.0005, Math.min(0.999, alpha))
  }

  private _smoothStep01(value: number): number {
    const x = Math.max(0, Math.min(1, value))
    return x * x * (3 - 2 * x)
  }

  private _isFusionTransition(name: string | null | undefined): boolean {
    return (
      name === 'fusion_morph' ||
      name === 'harmonic_weave' ||
      name === 'crossfade_eq' ||
      name === 'filter_sweep' ||
      name === 'highpass_dissolve'
    )
  }

  private _resetDynamicMixState(): void {
    this._dynamicNextRmsEma = 0
    this._dynamicNextTransientEma = 0
    this._dynamicMainBrightnessEma = 0
    this._dynamicNextBrightnessEma = 0
    this._dynamicToneMismatchEma = 1
    this._dynamicPrevMainL = 0
    this._dynamicPrevMainR = 0
    this._dynamicPrevNextL = 0
    this._dynamicPrevNextR = 0
    this._dynamicFrameCursor = 0
    this._dynamicPulseHz = 0
    this._dynamicPulsePhaseOffset = 0
    this._fusionTailHoldEnabled = false
    this._fusionOutFloorPeak = 0.5
    this._fusionOutFloorTail = 0.05
    this._fusionBeatMorphEnabled = false
    this._fusionBeatMorphFromHz = 0
    this._fusionBeatMorphToHz = 0
    this._fusionBeatMorphStrength = 0
    this._fusionMainLpL = 0
    this._fusionMainLpR = 0
    this._fusionAmbientLpL = 0
    this._fusionAmbientLpR = 0
    this._fusionBandLowLp = 0
    this._fusionBandHighLp = 0
    this._fusionPrevBand = 0
    this._fusionVocalPresenceEma = 0
    this._incomingEntryGainComp = 1
    this._entryPhraseConfidence = 0
    this._entryStability = 0
    this._entryFxCenterShield = 0
    this._entryFxLowDuckBoost = 0
    this._entryFxAirSoftenBoost = 0
    this._entryFxSidechainBoost = 0
    this._mixMainLowLpL = 0
    this._mixMainLowLpR = 0
    this._mixNextLowLpL = 0
    this._mixNextLowLpR = 0
    this._mixMainHighLpL = 0
    this._mixMainHighLpR = 0
    this._mixNextHighLpL = 0
    this._mixNextHighLpR = 0
    this._strictNoVocalEntry = false
  }

  private _configureFusionMixProfile(durationFrames: number): void {
    this._fusionTailHoldEnabled = false
    this._fusionBeatMorphEnabled = false
    this._fusionBeatMorphFromHz = 0
    this._fusionBeatMorphToHz = 0
    this._fusionBeatMorphStrength = 0
    this._fusionOutFloorPeak = 0.5
    this._fusionOutFloorTail = 0.05
    this._fusionMainLpL = 0
    this._fusionMainLpR = 0

    if (!this._isFusionTransition(this._transitionName)) return
    if (durationFrames < Math.round(this.sampleRate * 1.2)) return

    const transition = this._transitionName
    const fusionPremium =
      transition === 'fusion_morph' || transition === 'harmonic_weave'
    const durationSec = durationFrames / this.sampleRate

    let holdPeak = fusionPremium ? 0.54 : 0.48
    if (durationSec >= 9) holdPeak += 0.04
    else if (durationSec >= 7) holdPeak += 0.02
    this._fusionOutFloorPeak = Math.max(0.36, Math.min(0.66, holdPeak))
    this._fusionOutFloorTail = fusionPremium ? 0.06 : 0.05
    this._fusionTailHoldEnabled = true

    const bpmA =
      (this._rtBeatState.locked && this._rtBeatState.bpm > 0
        ? this._rtBeatState.bpm
        : null) ??
      this._detectedMainBpm ??
      this.getMainTrackBpm()
    const bpmB =
      (this._nextBeatState.locked && this._nextBeatState.bpm > 0
        ? this._nextBeatState.bpm
        : null) ??
      this._detectedNextBpm ??
      this.getNextTrackBpm()

    if (!(bpmA && bpmA > 0 && bpmB && bpmB > 0)) return

    const fromHz = Math.max(0.7, Math.min(3.4, bpmA / 60))
    const toHz = Math.max(0.7, Math.min(3.4, bpmB / 60))
    const diffRatio = Math.abs(fromHz - toHz) / Math.max(fromHz, toHz, 1e-6)

    let strength = (fusionPremium ? 0.16 : 0.13) + diffRatio * 0.52
    strength = Math.max(0.14, Math.min(0.4, strength))

    this._fusionBeatMorphEnabled = diffRatio > 0.012
    this._fusionBeatMorphFromHz = fromHz
    this._fusionBeatMorphToHz = toHz
    this._fusionBeatMorphStrength = strength

    logger(
      'debug',
      'AutoMix',
      `Fusion profile: ${transition} BPM ${bpmA.toFixed(1)}→${bpmB.toFixed(1)} (hold ${Math.round(this._fusionOutFloorPeak * 100)}%, beat-morph ${Math.round(strength * 100)}%)`
    )
  }

  private _bootstrapDynamicPulse(): void {
    const liveBpm =
      this._rtBeatState.locked && this._rtBeatState.bpm > 0
        ? this._rtBeatState.bpm
        : null
    const bpm =
      liveBpm ??
      this._detectedMainBpm ??
      this.getNextTrackBpm() ??
      this.getMainTrackBpm()
    if (!bpm || !Number.isFinite(bpm) || bpm <= 0) {
      this._dynamicPulseHz = 0
      this._dynamicPulsePhaseOffset = 0
      return
    }
    this._dynamicPulseHz = Math.max(0.7, Math.min(3.4, bpm / 60))
    this._dynamicPulsePhaseOffset = this._rtBeatState.locked
      ? this._rtBeatState.phase
      : 0
  }

  private _computeDynamicMixState(
    mainL: number,
    mainR: number,
    nextL: number,
    nextR: number,
    progress: number
  ): {
    inBias: number
    outBias: number
    openLift: number
    echoDryLift: number
    transientNorm: number
    energyNorm: number
  } {
    if (!this._dynamicMixEnabled) {
      return {
        inBias: 0,
        outBias: 0,
        openLift: 0,
        echoDryLift: 0,
        transientNorm: 0,
        energyNorm: 0
      }
    }

    const amp = Math.min(
      1,
      Math.max(0, (Math.abs(nextL) + Math.abs(nextR)) / (2 * 32768))
    )
    this._dynamicNextRmsEma = this._dynamicNextRmsEma * 0.975 + amp * 0.025
    const transient = Math.max(0, amp - this._dynamicNextRmsEma)
    this._dynamicNextTransientEma =
      this._dynamicNextTransientEma * 0.9 + transient * 0.1

    const energyNorm = Math.max(
      0,
      Math.min(1, (this._dynamicNextRmsEma - 0.04) / 0.24)
    )
    const transientNorm = Math.max(
      0,
      Math.min(1, this._dynamicNextTransientEma / 0.11)
    )
    const mainDelta =
      (Math.abs(mainL - this._dynamicPrevMainL) +
        Math.abs(mainR - this._dynamicPrevMainR)) /
      (2 * 32768)
    const nextDelta =
      (Math.abs(nextL - this._dynamicPrevNextL) +
        Math.abs(nextR - this._dynamicPrevNextR)) /
      (2 * 32768)
    this._dynamicPrevMainL = mainL
    this._dynamicPrevMainR = mainR
    this._dynamicPrevNextL = nextL
    this._dynamicPrevNextR = nextR
    this._dynamicMainBrightnessEma =
      this._dynamicMainBrightnessEma * 0.93 + mainDelta * 0.07
    this._dynamicNextBrightnessEma =
      this._dynamicNextBrightnessEma * 0.93 + nextDelta * 0.07
    const toneRatio =
      (this._dynamicMainBrightnessEma + 0.001) /
      (this._dynamicNextBrightnessEma + 0.001)
    this._dynamicToneMismatchEma =
      this._dynamicToneMismatchEma * 0.9 + toneRatio * 0.1
    const toneOpenBoost = Math.max(
      0,
      Math.min(0.14, (this._dynamicToneMismatchEma - 1.15) * 0.18)
    )
    const toneSoften = Math.max(
      0,
      Math.min(0.1, (0.88 - this._dynamicToneMismatchEma) * 0.16)
    )
    const unlockedConfidence = Math.max(
      0,
      Math.min(1, transientNorm * 0.6 + energyNorm * 0.4)
    )
    const beatConfidence = this._rtBeatState.locked
      ? Math.max(0, Math.min(1, this._rtBeatState.confidence))
      : unlockedConfidence * 0.55

    let pulse = 0.5
    if (this._dynamicPulseHz > 0) {
      const timeSec = this._dynamicFrameCursor / this.sampleRate
      const phase =
        (this._dynamicPulsePhaseOffset + timeSec * this._dynamicPulseHz) % 1
      const sinus = (Math.sin(phase * Math.PI * 2) + 1) / 2
      const distToBeat = Math.min(Math.abs(phase), Math.abs(1 - phase))
      const beatAccent = Math.max(0, 1 - distToBeat / 0.18)
      const lockWeight = this._rtBeatState.locked
        ? Math.max(0.35, beatConfidence)
        : 0.22
      pulse = sinus * (1 - lockWeight) + beatAccent * lockWeight
    }
    this._dynamicFrameCursor++

    const earlyFactor = Math.max(0, 1 - progress)
    const pulseInfluence = 0.06 + beatConfidence * 0.07
    const pivotZone = Math.max(0, 1 - Math.abs(progress - 0.58) / 0.26)
    const pivotPunch = (transientNorm * 0.55 + energyNorm * 0.35) * pivotZone
    const dynamicGate = this._rtBeatState.locked
      ? 0.82 + beatConfidence * 0.18
      : 0.74 + unlockedConfidence * 0.16
    const inBias = Math.max(
      -0.08,
      Math.min(
        0.24,
        (energyNorm * 0.1 +
          transientNorm * 0.16 +
          (pulse - 0.5) * pulseInfluence +
          pivotPunch * 0.1 +
          toneOpenBoost * 0.42 -
          toneSoften * 0.2) *
          dynamicGate *
          (0.45 + earlyFactor * 0.55)
      )
    )
    const outBias = Math.max(
      0,
      Math.min(
        0.24,
        (transientNorm * 0.13 + energyNorm * 0.06 + pivotPunch * 0.08) *
          dynamicGate *
          (0.25 + earlyFactor * 0.75)
      )
    )
    const openLift = Math.max(
      0,
      Math.min(
        0.26,
        (transientNorm * 0.12 +
          energyNorm * 0.07 +
          pivotPunch * 0.1 +
          toneOpenBoost * (0.35 + earlyFactor * 0.65) -
          toneSoften * 0.25) *
          dynamicGate *
          earlyFactor
      )
    )
    const echoDryLift = Math.max(
      0,
      Math.min(
        0.55,
        (transientNorm * 0.38 +
          energyNorm * 0.18 +
          toneOpenBoost * 0.2 -
          toneSoften * 0.12) *
          dynamicGate
      )
    )

    return {
      inBias,
      outBias,
      openLift,
      echoDryLift,
      transientNorm,
      energyNorm
    }
  }

  private _applyFusionBeatMorph(
    mainL: number,
    mainR: number,
    progress: number,
    absoluteFrame: number
  ): { mainL: number; mainR: number; outGainScale: number } {
    if (
      !this._fusionBeatMorphEnabled ||
      this._fusionBeatMorphFromHz <= 0 ||
      this._fusionBeatMorphToHz <= 0
    ) {
      return { mainL, mainR, outGainScale: 1 }
    }

    const morphProgress = this._smoothStep01((progress - 0.06) / 0.88)
    const beatHz =
      this._fusionBeatMorphFromHz +
      (this._fusionBeatMorphToHz - this._fusionBeatMorphFromHz) * morphProgress
    const timeSec = absoluteFrame / this.sampleRate
    const phase = (this._dynamicPulsePhaseOffset + timeSec * beatHz) % 1

    const beatPulse = 0.5 - 0.5 * Math.cos(phase * TWO_PI)
    const linger = beatPulse ** (0.72 + morphProgress * 0.75)
    const drag = this._fusionBeatMorphStrength * (0.25 + morphProgress * 0.55)
    const transientScale = Math.max(0.52, 1 - linger * drag)

    this._fusionMainLpL +=
      this._fusionMainLpAlpha * (mainL - this._fusionMainLpL)
    this._fusionMainLpR +=
      this._fusionMainLpAlpha * (mainR - this._fusionMainLpR)

    const hiL = mainL - this._fusionMainLpL
    const hiR = mainR - this._fusionMainLpR
    const shapedL = this._fusionMainLpL + hiL * transientScale
    const shapedR = this._fusionMainLpR + hiR * transientScale

    const outGainScale =
      1 - linger * this._fusionBeatMorphStrength * (0.12 + morphProgress * 0.1)

    return { mainL: shapedL, mainR: shapedR, outGainScale }
  }

  private _shapeIncomingFusion(
    nextL: number,
    nextR: number,
    progress: number
  ): {
    nextL: number
    nextR: number
    gainScale: number
  } {
    if (!this._fusionBlendEnabled) {
      return { nextL, nextR, gainScale: 1 }
    }

    const mid = (nextL + nextR) * 0.5
    const side = (nextL - nextR) * 0.5
    const absMid = Math.abs(mid)
    const absSide = Math.abs(side)

    this._fusionBandLowLp +=
      this._fusionBandLowAlpha * (mid - this._fusionBandLowLp)
    this._fusionBandHighLp +=
      this._fusionBandHighAlpha * (mid - this._fusionBandHighLp)

    const vocalBand = this._fusionBandHighLp - this._fusionBandLowLp
    const centerFocus = absMid / (absMid + absSide + 1)
    const bandRatio = Math.abs(vocalBand) / (absMid + 1200)
    const consonantMotion =
      Math.abs(vocalBand - this._fusionPrevBand) / (Math.abs(vocalBand) + 1800)
    this._fusionPrevBand = vocalBand

    const vocalInstant =
      Math.max(0, Math.min(1, (bandRatio - 0.08) / 0.52)) *
      Math.max(0, Math.min(1, (centerFocus - 0.52) / 0.44)) *
      Math.max(0.35, 1 - Math.min(1, consonantMotion * 1.6))

    this._fusionVocalPresenceEma =
      this._fusionVocalPresenceEma * 0.965 + vocalInstant * 0.035
    const vocalPresence = this._fusionVocalPresenceEma

    this._fusionAmbientLpL +=
      this._fusionAmbientAlpha * (nextL - this._fusionAmbientLpL)
    this._fusionAmbientLpR +=
      this._fusionAmbientAlpha * (nextR - this._fusionAmbientLpR)

    const ambienceRise = this._smoothStep01((progress + 0.2) / 0.62)
    const ambienceTail = 1 - this._smoothStep01((progress - 0.72) / 0.28)
    const ambienceGain = ambienceRise * (0.38 + ambienceTail * 0.62)

    const vocalGuard = this._strictNoVocalEntry
      ? Math.max(0, Math.min(1, (vocalPresence - 0.1) / 0.46))
      : Math.max(0, Math.min(1, (vocalPresence - 0.16) / 0.64))
    const gateStart = 0.3 + vocalGuard * 0.4
    const gateSpan = Math.max(0.18, 0.34 - vocalGuard * 0.12)
    const coreGate = this._smoothStep01((progress - gateStart) / gateSpan)

    const coreFloor = Math.max(0.08, Math.min(0.32, progress * 0.26 + 0.08))
    const coreWeight = coreFloor + (1 - coreFloor) * coreGate
    const ambienceWeight = ambienceGain * (0.52 - coreGate * 0.22)
    const totalWeight = Math.max(1e-6, coreWeight + ambienceWeight)

    const ambienceL = this._fusionAmbientLpL + side * 0.24
    const ambienceR = this._fusionAmbientLpR - side * 0.24
    const shapedL =
      (nextL * coreWeight + ambienceL * ambienceWeight) / totalWeight
    const shapedR =
      (nextR * coreWeight + ambienceR * ambienceWeight) / totalWeight
    const shapedMid = (shapedL + shapedR) * 0.5
    const shapedSide = (shapedL - shapedR) * 0.5
    const introShield = 1 - this._smoothStep01((progress - 0.14) / 0.56)
    const centerDuckCapBase = this._strictNoVocalEntry ? 0.34 : 0.24
    const centerDuckCap = Math.max(
      centerDuckCapBase,
      Math.min(0.5, centerDuckCapBase + this._entryFxCenterShield * 0.4)
    )
    const centerDuck = Math.max(
      0,
      Math.min(
        centerDuckCap,
        vocalGuard *
          introShield *
          ((this._strictNoVocalEntry ? 0.34 : 0.24) +
            this._entryFxCenterShield * 0.22)
      )
    )
    const midScale = 1 - centerDuck
    const sideScale =
      1 +
      centerDuck *
        ((this._strictNoVocalEntry ? 0.42 : 0.3) +
          this._entryFxCenterShield * 0.32)
    const duckedL = shapedMid * midScale + shapedSide * sideScale
    const duckedR = shapedMid * midScale - shapedSide * sideScale

    const gainRise = this._smoothStep01((progress - 0.1) / 0.8)
    const strictShield = this._strictNoVocalEntry
      ? 1 - this._smoothStep01((progress - 0.52) / 0.3)
      : 0
    const gainScale = Math.max(
      this._strictNoVocalEntry ? 0.58 : 0.66,
      Math.min(
        1,
        0.7 +
          gainRise * 0.26 -
          vocalGuard * (this._strictNoVocalEntry ? 0.1 : 0.06) +
          introShield * 0.02 -
          strictShield * vocalGuard * 0.1 -
          this._entryFxCenterShield *
            (1 - this._smoothStep01((progress - 0.42) / 0.42)) *
            0.08
      )
    )
    return { nextL: duckedL, nextR: duckedR, gainScale }
  }

  private _applyAdaptiveBandUnmasking(
    mainL: number,
    mainR: number,
    nextL: number,
    nextR: number,
    progress: number,
    transientNorm: number,
    energyNorm: number
  ): {
    mainL: number
    mainR: number
    nextL: number
    nextR: number
    outGainScale: number
  } {
    if (!this._adaptiveBandBlendEnabled) {
      return { mainL, mainR, nextL, nextR, outGainScale: 1 }
    }

    // Advanced 4-Band Spectral Decomposition (Non-simplified)
    this._mixMainLowLpL += this._mixBandLowAlpha * (mainL - this._mixMainLowLpL)
    this._mixMainLowLpR += this._mixBandLowAlpha * (mainR - this._mixMainLowLpR)
    this._mixNextLowLpL += this._mixBandLowAlpha * (nextL - this._mixNextLowLpL)
    this._mixNextLowLpR += this._mixBandLowAlpha * (nextR - this._mixNextLowLpR)

    this._mixMainHighLpL +=
      this._mixBandHighAlpha * (mainL - this._mixMainHighLpL)
    this._mixMainHighLpR +=
      this._mixBandHighAlpha * (mainR - this._mixMainHighLpR)
    this._mixNextHighLpL +=
      this._mixBandHighAlpha * (nextL - this._mixNextHighLpL)
    this._mixNextHighLpR +=
      this._mixBandHighAlpha * (nextR - this._mixNextHighLpR)

    const mainLow =
      (Math.abs(this._mixMainLowLpL) + Math.abs(this._mixMainLowLpR)) * 0.5
    const nextLow =
      (Math.abs(this._mixNextLowLpL) + Math.abs(this._mixNextLowLpR)) * 0.5

    // Spectral Centroid Masking: Identify which track dominates each band
    const overlap = Math.sin(progress * Math.PI)
    const lowConflict =
      Math.min(mainLow, nextLow) / (Math.max(mainLow, nextLow) + 1e-6)

    // Bass Crossover (Best Fusion Logic):
    // In fusion_morph, we swap the bass band at the midpoint (50%) instead of
    // subtracting it. This is a standard pro DJ technique.
    // We use a small 100ms window around the midpoint to smooth the transition and avoid clicks.
    if (this._transitionName === 'fusion_morph') {
      const midpoint = 0.5
      const window =
        (100 / (this.crossfade?.durationFrames || 1)) * (this.sampleRate / 1000)
      const low = midpoint - window
      const high = midpoint + window

      if (progress < low) {
        nextL -= this._mixNextLowLpL
        nextR -= this._mixNextLowLpR
      } else if (progress > high) {
        mainL -= this._mixMainLowLpL
        mainR -= this._mixMainLowLpR
      } else {
        // Smooth cross-fade of the bass band itself within the 100ms window
        const t = (progress - low) / (high - low)
        const bassGainOut = Math.cos(t * Math.PI * 0.5)
        const bassGainIn = Math.sin(t * Math.PI * 0.5)

        const outgoingBassL = this._mixMainLowLpL * (1 - bassGainOut)
        const outgoingBassR = this._mixMainLowLpR * (1 - bassGainOut)
        const incomingBassL = this._mixNextLowLpL * (1 - bassGainIn)
        const incomingBassR = this._mixNextLowLpR * (1 - bassGainIn)

        mainL -= outgoingBassL
        mainR -= outgoingBassR
        nextL -= incomingBassL
        nextR -= incomingBassR
      }
    } else {
      // Dynamic Spectral Subtraction:
      // Track A gives up exactly what Track B needs to exist in the low-end.
      let lowSubtract = lowConflict * overlap * 0.45 * (1 + transientNorm)
      lowSubtract = Math.max(0, Math.min(0.35, lowSubtract))

      mainL -= this._mixMainLowLpL * lowSubtract
      mainR -= this._mixMainLowLpR * lowSubtract
    }

    // Transient Preservation: Prioritize the incoming track's kick/snare
    const transientGate = Math.max(0, transientNorm - 0.5) * overlap * 0.30

    // Space-remapping: Widening the sidechain only during peak overlap
    const sidechain = 0.05 + energyNorm * 0.15 * overlap + transientGate

    return { mainL, mainR, nextL, nextR, outGainScale: 1 - sidechain }
  }

  /**
   * Calculates the cross-correlation between two signals to find the optimal
   * phase alignment. This is the mathematical "essence" of a perfect blend,
   * ensuring that peaks align and prevent destructive interference (noise).
   */
  private _calculateOptimalLag(
    main: Buffer,
    next: Buffer,
    searchWindow: number
  ): number {
    let maxCorr = -1
    let optimalLag = 0
    const mainSamples = main.length >> 1
    const nextSamples = next.length >> 1
    const sampleLimit = Math.min(mainSamples, nextSamples, 2048)

    // Using a sliding dot product to find the lag that maximizes similarity.
    for (let lag = -searchWindow; lag <= searchWindow; lag++) {
      let dotProduct = 0
      let normA = 0
      let normB = 0

      for (let i = searchWindow; i < sampleLimit - searchWindow; i++) {
        const valA = main.readInt16LE(i * 2)
        const nextIdx = (i + lag) * 2
        if (nextIdx < 0 || nextIdx >= next.length - 1) continue
        const valB = next.readInt16LE(nextIdx)

        dotProduct += valA * valB
        normA += valA * valA
        normB += valB * valB
      }

      const correlation = dotProduct / (Math.sqrt(normA * normB) + 1e-6)
      if (correlation > maxCorr) {
        maxCorr = correlation
        optimalLag = lag
      }
    }
    return optimalLag
  }

  private _mixBuffers(
    main: Buffer,
    next: Buffer,
    runtime: CrossfadeRuntime
  ): Buffer {
    const sampleCount = main.length >> 1
    if (sampleCount === 0) return main

    const output = Buffer.allocUnsafe(main.length)

    // Critical: Ensure alignment. Node.js Buffers can have any byteOffset.
    // We use local helpers that handle alignment safely via readInt16LE.
    const getMain = (i: number): number => main.readInt16LE(i * 2)
    const getNext = (i: number): number => next.readInt16LE(i * 2)
    const setOut = (i: number, val: number): void => {
      output.writeInt16LE(val, i * 2)
    }

    const totalFrames = Math.floor(sampleCount / this.channels)
    const remainingFrames = runtime.isFinished
      ? 0
      : Math.max(0, runtime.durationFrames - runtime.elapsedFrames)
    const fadeFrames = Math.min(totalFrames, remainingFrames)

    const useHp = this._hpEnabled && this._hpDurationFrames > 0
    const isFusionStyle = runtime.style === 'fusion'
    const fusionWindowActive =
      isFusionStyle &&
      this._fusionBlendEnabled &&
      runtime.durationFrames >= Math.round(this.sampleRate * 1.8)
    const fusionTransitionActive =
      fusionWindowActive && this._isFusionTransition(this._transitionName)

    for (let frame = 0; frame < totalFrames; frame++) {
      let frameProgress = 1
      if (!runtime.isFinished) {
        frameProgress =
          frame < fadeFrames
            ? (runtime.elapsedFrames + frame) / runtime.durationFrames
            : 1
      }

      // Progress Debug: Log every ~1 second of transition
      if (frame === 0 && !runtime.isFinished && Math.floor(runtime.elapsedFrames / this.sampleRate) !== Math.floor((runtime.elapsedFrames - totalFrames) / this.sampleRate)) {
         logger('debug', 'Crossfade-Progress', `Guild ${this.guildId} | Progress: ${(frameProgress * 100).toFixed(1)}% | Elapsed: ${Math.round(runtime.elapsedFrames / this.sampleRate * 1000)}ms / ${Math.round(runtime.durationFrames / this.sampleRate * 1000)}ms | ConsumedNext: ${this.getConsumedMs()}ms`);
      }

      const [gainOut, gainIn] = this._fadeGains(frameProgress, runtime.curve)
      const base = frame * this.channels

      let nextL = getNext(base)
      let nextR = this.channels > 1 ? getNext(base + 1) : nextL
      let mainL = getMain(base)
      let mainR = this.channels > 1 ? getMain(base + 1) : mainL

      if (this._incomingGain !== 1) {
        nextL *= this._incomingGain
        nextR *= this._incomingGain
      }

      if (isFusionStyle) {
        // --- Advanced Fusion Blending ---
        if (this._incomingEntryGainComp < 0.999 && frameProgress < 0.4) {
          const compT = this._smoothStep01(frameProgress / 0.4)
          const entryComp =
            this._incomingEntryGainComp +
            (1 - this._incomingEntryGainComp) * compT
          nextL *= entryComp
          nextR *= entryComp
        }
        const attackWindow = this._strictNoVocalEntry ? 0.34 : 0.24
        const clipGuardPeak = this._strictNoVocalEntry ? 19500 : 22000
        if (frameProgress < attackWindow) {
          const incomingPeak = Math.max(Math.abs(nextL), Math.abs(nextR))
          if (incomingPeak > clipGuardPeak) {
            const attack = 1 - this._smoothStep01(frameProgress / attackWindow)
            const overshoot = Math.max(
              0,
              Math.min(1, (incomingPeak - clipGuardPeak) / 12000)
            )
            const tameScale =
              1 - attack * overshoot * (this._strictNoVocalEntry ? 0.42 : 0.3)
            nextL *= tameScale
            nextR *= tameScale
          }
        }

        const dyn = this._computeDynamicMixState(
          mainL,
          mainR,
          nextL,
          nextR,
          frameProgress
        )
        const dynamicProgress = Math.min(1, frameProgress + dyn.openLift)

        // Short eased ramp at the very beginning of Track B prevents attack clipping
        // while still keeping both tracks present.
        const entryRampSpan = this._strictNoVocalEntry ? 0.42 : 0.28
        const entryRampFloor = this._strictNoVocalEntry ? 0.64 : 0.78
        if (frameProgress < entryRampSpan) {
          const ramp =
            entryRampFloor +
            (1 - entryRampFloor) *
              this._smoothStep01(frameProgress / entryRampSpan)
          nextL *= ramp
          nextR *= ramp
        }
        if (this._strictNoVocalEntry && frameProgress < 0.36) {
          const shield =
            1 - (1 - this._smoothStep01(frameProgress / 0.36)) * 0.1
          nextL *= shield
          nextR *= shield
        }
        if (this._strictNoVocalEntry && frameProgress < 0.46) {
          const mid = (nextL + nextR) * 0.5
          const side = (nextL - nextR) * 0.5
          const baseCenterShield =
            1 - (1 - this._smoothStep01(frameProgress / 0.46)) * 0.22
          const shieldBoost =
            this._entryFxCenterShield *
            (1 - this._smoothStep01(frameProgress / 0.52))
          const centerShield = Math.max(
            0.56,
            Math.min(1, baseCenterShield - shieldBoost * 0.26)
          )
          const sideLift = 1 + (1 - centerShield) * (0.25 + shieldBoost * 0.42)
          nextL = mid * centerShield + side * sideLift
          nextR = mid * centerShield - side * sideLift
        }

        let mixOutGain = gainOut
        let mixInGain = gainIn
        if (this._dynamicMixEnabled) {
          mixOutGain = Math.max(0, mixOutGain * (1 - dyn.outBias))
          mixInGain = Math.max(0, mixInGain * (1 + dyn.inBias))

          // Coherence-aware normalization:
          // Prevents the +3dB "correlated sum" noise that causes clipping
          // during beat-matched transitions.
          const [adjOut, adjIn] = this._computeCoherenceGains(
            mixOutGain,
            mixInGain,
            frameProgress
          )
          mixOutGain = adjOut
          mixInGain = adjIn
        }

        if (fusionTransitionActive) {
          if (this._fusionBeatMorphEnabled) {
            const shapedMain = this._applyFusionBeatMorph(
              mainL,
              mainR,
              dynamicProgress,
              runtime.elapsedFrames + frame
            )
            mainL = shapedMain.mainL
            mainR = shapedMain.mainR
            mixOutGain *= shapedMain.outGainScale
          }

          if (this._fusionTailHoldEnabled) {
            const holdShape =
              1 - this._smoothStep01((dynamicProgress - 0.76) / 0.24)
            const outFloor =
              this._fusionOutFloorTail +
              (this._fusionOutFloorPeak - this._fusionOutFloorTail) * holdShape
            if (mixOutGain < outFloor) mixOutGain = outFloor

            const inCeil = 1.06 - outFloor * 0.42
            if (mixInGain > inCeil) mixInGain = inCeil

            const normSq = mixOutGain * mixOutGain + mixInGain * mixInGain
            if (normSq > 1.08) {
              const norm = Math.sqrt(normSq)
              mixOutGain /= norm
              mixInGain /= norm
            }
          }

          // Keep both tracks clearly audible in the center of the blend.
          const overlapMid = Math.sin(dynamicProgress * Math.PI)
          const glueMin = 0.06 + overlapMid * 0.12
          if (mixOutGain < glueMin) mixOutGain = glueMin
          if (mixInGain < glueMin) mixInGain = glueMin
          const glueNorm = mixOutGain * mixOutGain + mixInGain * mixInGain
          if (glueNorm > 1.1) {
            const scale = Math.sqrt(1.1 / glueNorm)
            mixOutGain *= scale
            mixInGain *= scale
          }
        }

        let hpAlpha = 0
        if (useHp && dynamicProgress < 1) {
          const hpMappedProgress = Math.min(1, dynamicProgress / 0.3)
          const hpProgress = (1 - Math.cos(hpMappedProgress * Math.PI)) / 2
          hpAlpha = this._hpPeakAlpha * (1 - hpProgress)
        }

        if (hpAlpha > 0.001) {
          this._hpPrevL = this._hpPrevL + hpAlpha * (nextL - this._hpPrevL)
          nextL = nextL - this._hpPrevL
          if (this.channels > 1) {
            this._hpPrevR = this._hpPrevR + hpAlpha * (nextR - this._hpPrevR)
            nextR = nextR - this._hpPrevR
          }
        } else {
          this._hpPrevL = 0
          this._hpPrevR = 0
        }

        if (this._lpEnabled && dynamicProgress < this._lpCompletionRatio) {
          const lpMappedProgress = Math.min(
            1,
            dynamicProgress / this._lpCompletionRatio
          )
          const lpProgress = (1 - Math.cos(lpMappedProgress * Math.PI)) / 2
          const lpAlpha =
            this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress
          this._lpPrevL += lpAlpha * (nextL - this._lpPrevL)
          nextL = this._lpPrevL
          if (this.channels > 1) {
            this._lpPrevR += lpAlpha * (nextR - this._lpPrevR)
            nextR = this._lpPrevR
          }
        } else if (this._lpEnabled) {
          this._lpPrevL = 0
          this._lpPrevR = 0
        }

        if (this._echoEnabled && this._echoDelayL && this._echoDelayR) {
          const delayLen = this._echoDelayFrames
          const readPos =
            (((this._echoWritePos - delayLen) % delayLen) + delayLen) % delayLen

          const delayedL = this._echoDelayL[readPos]!
          const delayedR = this._echoDelayR[readPos]!

          const fbL = nextL + delayedL * this._echoFeedback
          const fbR = nextR + delayedR * this._echoFeedback
          this._echoDelayL[this._echoWritePos] =
            fbL > 65534 ? 65534 : fbL < -65534 ? -65534 : fbL
          this._echoDelayR[this._echoWritePos] =
            fbR > 65534 ? 65534 : fbR < -65534 ? -65534 : fbR

          this._echoWritePos = (this._echoWritePos + 1) % delayLen

          if (dynamicProgress < this._echoCompletionRatio) {
            const echoT = dynamicProgress / this._echoCompletionRatio
            const baseWet = this._echoPeakMix * (1 - echoT)
            const echoWet = baseWet * (1 - dyn.echoDryLift)
            const echoDry = 1 - echoWet
            nextL = nextL * echoDry + delayedL * echoWet
            nextR = nextR * echoDry + delayedR * echoWet
          }
        }

        if (fusionTransitionActive) {
          const shapedIncoming = this._shapeIncomingFusion(
            nextL,
            nextR,
            dynamicProgress
          )
          nextL = shapedIncoming.nextL
          nextR = shapedIncoming.nextR
          mixInGain *= shapedIncoming.gainScale
        }

        const adaptiveUnmask = this._applyAdaptiveBandUnmasking(
          mainL,
          mainR,
          nextL,
          nextR,
          dynamicProgress,
          dyn.transientNorm,
          dyn.energyNorm
        )
        mainL = adaptiveUnmask.mainL
        mainR = adaptiveUnmask.mainR
        nextL = adaptiveUnmask.nextL
        nextR = adaptiveUnmask.nextR
        mixOutGain *= adaptiveUnmask.outGainScale

        // Bus headroom guard: keep headroom without flattening the blend.
        const mainAbsPeak =
          this.channels > 1
            ? Math.max(Math.abs(mainL), Math.abs(mainR))
            : Math.abs(mainL)
        const nextAbsPeak =
          this.channels > 1
            ? Math.max(Math.abs(nextL), Math.abs(nextR))
            : Math.abs(nextL)
        const predictedPeak = mainAbsPeak * mixOutGain + nextAbsPeak * mixInGain
        const targetBusPeak = fusionTransitionActive
          ? MIX_BUS_TARGET_PEAK_FUSION
          : MIX_BUS_TARGET_PEAK
        if (predictedPeak > targetBusPeak && predictedPeak > 1) {
          const headroomScale = Math.sqrt(targetBusPeak / predictedPeak)
          mixOutGain *= headroomScale
          mixInGain *= headroomScale
        }

        if (this._panEnabled && dynamicProgress < this._panCompletionRatio) {
          const panT = dynamicProgress / this._panCompletionRatio
          const panL = (1 - Math.cos(panT * Math.PI)) / 2 // 0 → 1 smooth
          nextL *= panL
        }

        if (
          this._panOutEnabled &&
          this.channels > 1 &&
          dynamicProgress < this._panOutCompletionRatio
        ) {
          const panT = dynamicProgress / this._panOutCompletionRatio
          const panR = (1 + Math.cos(panT * Math.PI)) / 2 // 1 → 0 smooth
          mainR *= panR
        }

        let mixedL = mainL * mixOutGain + nextL * mixInGain
        let mixedR =
          this.channels > 1 ? mainR * mixOutGain + nextR * mixInGain : mixedL
        const mixedPeak =
          this.channels > 1
            ? Math.max(Math.abs(mixedL), Math.abs(mixedR))
            : Math.abs(mixedL)
        if (mixedPeak > targetBusPeak && mixedPeak > 1) {
          const limiterScale = Math.max(
            0.9,
            Math.sqrt(targetBusPeak / mixedPeak)
          )
          mixedL *= limiterScale
          mixedR *= limiterScale
        }
        mixedL = this._softClipSample(mixedL)
        mixedR = this.channels > 1 ? this._softClipSample(mixedR) : mixedL
        setOut(base, this._toInt16Sample(mixedL))

        if (this.channels > 1) {
          setOut(base + 1, this._toInt16Sample(mixedR))
        }
      } else {
        // --- Standard Crossfade ---
        // Simple, high-performance volume blending with peak protection.
        let outG = gainOut
        let inG = gainIn
        
        const predictedPeak = (Math.abs(mainL) * outG + Math.abs(nextL) * inG)
        if (predictedPeak > MIX_BUS_TARGET_PEAK) {
          const scale = MIX_BUS_TARGET_PEAK / predictedPeak
          outG *= scale
          inG *= scale
        }

        setOut(base, this._toInt16Sample(mainL * outG + nextL * inG))
        if (this.channels > 1) {
          setOut(
            base + 1,
            this._toInt16Sample(mainR * outG + nextR * inG)
          )
        }
      }
    }

    if (!runtime.isFinished) {
      runtime.elapsedFrames += fadeFrames
      if (runtime.elapsedFrames >= runtime.durationFrames) {
        runtime.isFinished = true
      }
    }

    if (runtime.isFinished && !this._bypassTriggered) {
      this._bypassTriggered = true
      this._incomingGain = 1.0
      this.filterBypassSetter?.(true)
      this.filterStateResetter?.()
    }

    return output
  }

  private _fadeGains(progress: number, curve: FadeCurve): [number, number] {
    const clamped = Math.min(1, Math.max(0, progress))
    if (curve === 'linear') {
      return [1 - clamped, clamped]
    }

    // Constant-power cosine/sine curve for transparent equal-power crossfades.
    const angle = clamped * HALF_PI
    const gainOut = Math.cos(angle)
    const gainIn = Math.sin(angle)

    return [gainOut, gainIn]
  }

  /**
   * Updates live analysis for the preloaded next track (Track B).
   *
   * This runs continuously while Track B buffers so automix decisions can
   * use real internal signals instead of relying on external metadata.
   */
  private _updateNextTrackAnalysis(chunk: Buffer): void {
    const samples = chunk.length >> 1
    if (samples === 0) return

    let sumSq = 0
    let count = 0
    for (let i = 0; i < samples; i += 32) {
      const s = chunk.readInt16LE(i * 2)
      sumSq += s * s
      count++
    }
    if (count === 0) return

    const rms = Math.sqrt(sumSq / count) / 32768
    this._nextRmsEma = this._nextRmsEma * 0.85 + rms * 0.15
    this._nextRmsPeak = Math.max(this._nextRmsPeak * 0.9985, rms)

    const chunkMs = (chunk.length / 2 / this.channels / this.sampleRate) * 1000
    if (chunkMs > 0) this._nextOnsetChunkMs = chunkMs

    if (this._nextOpeningEnergyMs < this._nextOpeningWindowMs && chunkMs > 0) {
      const remainingWindow =
        this._nextOpeningWindowMs - this._nextOpeningEnergyMs
      const usedMs = Math.min(remainingWindow, chunkMs)
      this._nextOpeningEnergyAcc += rms * usedMs
      this._nextOpeningEnergyMs += usedMs
      if (this._nextOpeningEnergyMs > 0) {
        this._nextOpeningEnergy =
          this._nextOpeningEnergyAcc / this._nextOpeningEnergyMs
      }
    }

    const onset = Math.max(0, rms - this._nextPrevRmsForOnset)
    this._nextPrevRmsForOnset = rms

    // Only maintain onset buffer until BPM fallback fires
    if (!this._nextBpmDetected) {
      this._nextOnsetBuffer.push(onset)
      const maxOnsets = Math.max(
        64,
        Math.round(20000 / Math.max(1, this._nextOnsetChunkMs))
      )
      if (this._nextOnsetBuffer.length > maxOnsets) {
        this._nextOnsetBuffer.shift()
      }
    } else if (this._nextOnsetBuffer.length > 0) {
      this._nextOnsetBuffer.length = 0
    }

    if (chunkMs > 0) {
      // Decimate beat tracker when locked
      const locked = this._nextBeatState.locked
      if (!locked) {
        this._nextBeatState = this._nextBeatTracker.push(onset, chunkMs / 1000)
      } else {
        this._nextOnsetAccum = Math.max(this._nextOnsetAccum, onset)
        this._nextDeltaAccum += chunkMs / 1000
        this._nextBeatDecimate++
        if (this._nextBeatDecimate >= 4) {
          this._nextBeatState = this._nextBeatTracker.push(this._nextOnsetAccum, this._nextDeltaAccum)
          this._nextOnsetAccum = 0
          this._nextDeltaAccum = 0
          this._nextBeatDecimate = 0
        }
      }
      if (
        this._nextBeatState.locked &&
        this._nextBeatState.bpm > 0 &&
        (!this._detectedNextBpm ||
          Math.abs(this._detectedNextBpm - this._nextBeatState.bpm) > 0.9)
      ) {
        this._detectedNextBpm = Math.round(this._nextBeatState.bpm * 10) / 10
        this._nextBpmDetected = true
        const shouldLog =
          this._nextBeatState.timeSec - this._lastRealtimeNextBpmLogSec >= 30
        if (shouldLog) {
          this._lastRealtimeNextBpmLogSec = this._nextBeatState.timeSec
          logger(
            'debug',
            'AutoMix',
            `Next track BPM locked in preload: ${this._detectedNextBpm} (confidence ${(this._nextBeatState.confidence * 100).toFixed(0)}%)`
          )
        }
      }
    }

    if (
      !this._nextBpmDetected &&
      this._nextOnsetBuffer.length >= Math.round(6000 / this._nextOnsetChunkMs)
    ) {
      const onsetsPerSec = 1000 / this._nextOnsetChunkMs
      this._detectedNextBpm = estimateBpmFromOnsets(
        this._nextOnsetBuffer,
        onsetsPerSec
      )
      this._nextBpmDetected = true
      if (this._detectedNextBpm) {
        logger(
          'info',
          'AutoMix',
          `Next track BPM detected from preload audio: ${this._detectedNextBpm}`
        )
      }
    }

    if (
      !this._nextKeyDetected &&
      this._nextKeyPcmBytes < this._nextKeyMaxBytes
    ) {
      this._nextKeyPcm.push(Buffer.from(chunk))
      this._nextKeyPcmBytes += chunk.length
      if (this._nextKeyPcmBytes >= this.sampleRate * this.channels * 2 * 5) {
        const fullPcm = Buffer.concat(this._nextKeyPcm)
        this._detectedNextKey = estimateKeyFromPcm(
          fullPcm,
          this.sampleRate,
          this.channels
        )
        this._nextKeyDetected = true
        this._nextKeyPcm = []
        if (this._detectedNextKey) {
          logger(
            'info',
            'AutoMix',
            `Next track key detected from preload audio: ${this._detectedNextKey.key} (${this._detectedNextKey.camelot}, confidence: ${(this._detectedNextKey.confidence * 100).toFixed(0)}%)`
          )
        }
      }
    }
  }

  /**
   * Update the smoothed RMS energy of the main stream (track A).
   * Called on every chunk flowing through _transform.
   */
  private _updateEnergy(chunk: Buffer): void {
    const samples = chunk.length >> 1
    if (samples === 0) return
    let sumSq = 0
    let count = 0
    let sumBass = 0
    let sumMid = 0
    let sumTreble = 0
    let sumFlux = 0
    for (let i = 0; i < samples; i += 32) {
      const s = chunk.readInt16LE(i * 2)
      sumSq += s * s
      this._mainSpecLowLp += this._mainSpecLowAlpha * (s - this._mainSpecLowLp)
      this._mainSpecMidLp += this._mainSpecMidAlpha * (s - this._mainSpecMidLp)
      this._mainSpecHighLp +=
        this._mainSpecHighAlpha * (s - this._mainSpecHighLp)
      const bass = Math.abs(this._mainSpecLowLp)
      const midBand = Math.abs(this._mainSpecMidLp - this._mainSpecLowLp)
      const treble = Math.abs(s - this._mainSpecHighLp)
      sumBass += bass
      sumMid += midBand
      sumTreble += treble
      const composite = midBand + treble * 1.15
      sumFlux += Math.abs(composite - this._mainSpecPrevComposite)
      this._mainSpecPrevComposite = composite
      count++
    }
    if (count === 0) return
    const rms = Math.sqrt(sumSq / count) / 32768 // normalized 0-1
    this._mainRmsEma = this._mainRmsEma * 0.85 + rms * 0.15 // Fast-responding EMA
    this._mainRmsPeak = Math.max(this._mainRmsPeak * 0.9985, rms) // Slowly decaying peak

    const toneTotal = sumBass + sumMid + sumTreble + 1
    const brightness = Math.max(
      0,
      Math.min(1, (sumTreble * 1.1 + sumMid * 0.42) / toneTotal)
    )
    const motion = Math.max(
      0,
      Math.min(1, sumFlux / (sumMid + sumTreble + 1) / 0.65)
    )
    const centroidNorm = Math.max(
      0,
      Math.min(
        1,
        (sumBass * 140 + sumMid * 900 + sumTreble * 3200) / toneTotal / 3800
      )
    )
    this._mainSpecBrightnessEma =
      this._mainSpecBrightnessEma * 0.92 + brightness * 0.08
    this._mainSpecMotionEma = this._mainSpecMotionEma * 0.9 + motion * 0.1
    this._mainSpecCentroidEma =
      this._mainSpecCentroidEma * 0.92 + centroidNorm * 0.08

    const chunkMs = (chunk.length / 2 / this.channels / this.sampleRate) * 1000
    if (chunkMs > 0) this._onsetChunkMs = chunkMs
    const onset = Math.max(0, rms - this._prevRmsForOnset)
    this._prevRmsForOnset = rms

    // Only maintain onset buffer until BPM fallback fires — after that it's unused
    if (!this._mainBpmDetected) {
      this._onsetBuffer.push(onset)
      const maxOnsets = Math.max(64, Math.round(20000 / Math.max(1, this._onsetChunkMs)))
      if (this._onsetBuffer.length > maxOnsets) {
        this._onsetBuffer.shift()
      }
    } else if (this._onsetBuffer.length > 0) {
      this._onsetBuffer.length = 0 // free memory
    }

    if (chunkMs > 0) {
      // Decimate beat tracker when locked — run every 4th chunk (~80ms), accumulate onset peaks
      const locked = this._rtBeatState.locked
      if (!locked) {
        this._rtBeatState = this._rtBeatTracker.push(onset, chunkMs / 1000)
      } else {
        this._mainOnsetAccum = Math.max(this._mainOnsetAccum, onset)
        this._mainDeltaAccum += chunkMs / 1000
        this._mainBeatDecimate++
        if (this._mainBeatDecimate >= 4) {
          this._rtBeatState = this._rtBeatTracker.push(this._mainOnsetAccum, this._mainDeltaAccum)
          this._mainOnsetAccum = 0
          this._mainDeltaAccum = 0
          this._mainBeatDecimate = 0
        }
      }
      if (
        this._rtBeatState.locked &&
        this._rtBeatState.bpm > 0 &&
        (!this._detectedMainBpm ||
          Math.abs(this._detectedMainBpm - this._rtBeatState.bpm) > 0.9)
      ) {
        this._detectedMainBpm = Math.round(this._rtBeatState.bpm * 10) / 10
        const shouldLog =
          this._rtBeatState.timeSec - this._lastRealtimeBpmLogSec >= 30
        if (shouldLog) {
          this._lastRealtimeBpmLogSec = this._rtBeatState.timeSec
          logger(
            'debug',
            'AutoMix',
            `Main track BPM locked in real-time: ${this._detectedMainBpm} (confidence ${(this._rtBeatState.confidence * 100).toFixed(0)}%)`
          )
        }
      }
    }

    if (
      !this._mainBpmDetected &&
      this._onsetBuffer.length >= Math.round(8000 / this._onsetChunkMs)
    ) {
      const onsetsPerSec = 1000 / this._onsetChunkMs
      this._detectedMainBpm = estimateBpmFromOnsets(
        this._onsetBuffer,
        onsetsPerSec
      )
      this._mainBpmDetected = true
      if (this._detectedMainBpm) {
        logger(
          'info',
          'AutoMix',
          `Main track BPM detected from audio: ${this._detectedMainBpm}`
        )
      }
    }

    if (
      !this._mainKeyDetected &&
      this._mainKeyPcmBytes < this._mainKeyMaxBytes
    ) {
      this._mainKeyPcm.push(Buffer.from(chunk))
      this._mainKeyPcmBytes += chunk.length
      if (this._mainKeyPcmBytes >= this.sampleRate * this.channels * 2 * 5) {
        const fullPcm = Buffer.concat(this._mainKeyPcm)
        this._detectedMainKey = estimateKeyFromPcm(
          fullPcm,
          this.sampleRate,
          this.channels
        )
        this._mainKeyDetected = true
        this._mainKeyPcm = [] // Free memory
        if (this._detectedMainKey) {
          logger(
            'info',
            'AutoMix',
            `Main track key detected from audio: ${this._detectedMainKey.key} (${this._detectedMainKey.camelot}, confidence: ${(this._detectedMainKey.confidence * 100).toFixed(0)}%)`
          )
        }
      }
    }
  }

  private _mainEnergyResult = { rms: 0, peak: 0 }

  /**
   * Returns the current smoothed energy of the main stream.
   * Used by the player for intelligent transition point detection.
   */
  public getMainEnergy(): { rms: number; peak: number } {
    this._mainEnergyResult.rms = this._mainRmsEma
    this._mainEnergyResult.peak = this._mainRmsPeak
    return this._mainEnergyResult
  }

  /**
   * Calculates the average RMS energy of Track B's opening seconds
   * from the ring buffer (non-destructive peek).
   * Returns 0 if ring buffer is not ready.
   */
  /**
   * Returns the BPM detected from the main stream's onset envelope,
   * or null if not enough data has been accumulated yet.
   */
  public getMainTrackBpm(): number | null {
    if (this._rtBeatState.locked && this._rtBeatState.bpm > 0) {
      const live = Math.round(this._rtBeatState.bpm * 10) / 10
      this._detectedMainBpm = live
      this._mainBpmDetected = true
      return live
    }
    if (
      !this._mainBpmDetected &&
      this._onsetBuffer.length >= Math.round(4000 / this._onsetChunkMs)
    ) {
      const onsetsPerSec = 1000 / this._onsetChunkMs
      this._detectedMainBpm = estimateBpmFromOnsets(
        this._onsetBuffer,
        onsetsPerSec
      )
      this._mainBpmDetected = true
      if (this._detectedMainBpm) {
        logger(
          'info',
          'AutoMix',
          `Main track BPM detected from audio (eager): ${this._detectedMainBpm}`
        )
      }
    }
    return this._detectedMainBpm
  }

  public getRealtimeBeatState(): RealtimeBeatState {
    return this._rtBeatState
  }

  /**
   * Returns the musical key detected from the main stream's captured PCM,
   * or null if not enough audio has been accumulated yet.
   */
  public getMainTrackKey(): KeyResult | null {
    if (
      !this._mainKeyDetected &&
      this._mainKeyPcmBytes >= this.sampleRate * this.channels * 2 * 3
    ) {
      const fullPcm = Buffer.concat(this._mainKeyPcm)
      this._detectedMainKey = estimateKeyFromPcm(
        fullPcm,
        this.sampleRate,
        this.channels
      )
      this._mainKeyDetected = true
      this._mainKeyPcm = [] // Free memory
      if (this._detectedMainKey) {
        logger(
          'info',
          'AutoMix',
          `Main track key detected from audio (eager): ${this._detectedMainKey.key} (${this._detectedMainKey.camelot})`
        )
      }
    }
    return this._detectedMainKey
  }

  /**
   * Detects BPM from the buffered next track (Track B) ring buffer.
   * Non-destructive — peeks up to ~10 s of PCM data.
   * Returns null if the ring buffer is too small or detection fails.
   */
  public getNextTrackBpm(): number | null {
    if (this._nextBeatState.locked && this._nextBeatState.bpm > 0) {
      const live = Math.round(this._nextBeatState.bpm * 10) / 10
      this._detectedNextBpm = live
      this._nextBpmDetected = true
      return live
    }
    if (
      !this._nextBpmDetected &&
      this._nextOnsetBuffer.length >= Math.round(4000 / this._nextOnsetChunkMs)
    ) {
      const onsetsPerSec = 1000 / this._nextOnsetChunkMs
      this._detectedNextBpm = estimateBpmFromOnsets(
        this._nextOnsetBuffer,
        onsetsPerSec
      )
      this._nextBpmDetected = true
      if (this._detectedNextBpm) {
        logger(
          'info',
          'AutoMix',
          `Next track BPM detected from preload audio (eager): ${this._detectedNextBpm}`
        )
      }
    }
    if (this._detectedNextBpm) return this._detectedNextBpm

    if (
      !this.ringBuffer ||
      this.ringBuffer.length < Math.round(3000 * this.bytesPerMs)
    )
      return null

    const maxBytes = Math.min(
      Math.round(10000 * this.bytesPerMs),
      this.ringBuffer.length
    )
    const peek = this.ringBuffer.peek(maxBytes)
    if (!peek || peek.length < 4) return null

    const fallback = estimateBpmFromPcm(peek, this.sampleRate, this.channels)
    if (fallback) {
      this._detectedNextBpm = fallback
      this._nextBpmDetected = true
    }
    return fallback
  }

  public getNextTrackOpeningEnergy(): number {
    if (this._nextOpeningEnergyMs >= 500 && this._nextOpeningEnergy > 0) {
      return this._nextOpeningEnergy
    }

    if (!this.ringBuffer || this.ringBuffer.length < 4) return 0

    const maxBytes = Math.min(
      Math.round(3000 * this.bytesPerMs),
      this.ringBuffer.length
    )
    const peek = this.ringBuffer.peek(maxBytes)
    if (!peek || peek.length < 4) return 0

    const samples = peek.length >> 1
    let sumSq = 0
    let count = 0
    for (let i = 0; i < samples; i += 8) {
      const s = peek.readInt16LE(i * 2)
      sumSq += s * s
      count++
    }
    if (count === 0) return 0
    return Math.sqrt(sumSq / count) / 32768
  }

  public getNextTrackBeatState(): RealtimeBeatState {
    return this._nextBeatState
  }

  /**
   * Detects the musical key from the buffered next track (Track B) ring buffer.
   * Non-destructive — peeks up to ~10 s of PCM data.
   * Uses Goertzel-based chroma analysis + Krumhansl-Kessler key profiles.
   * Returns null if the ring buffer is too small or detection fails.
   */
  public getNextTrackKey(): KeyResult | null {
    if (
      !this._nextKeyDetected &&
      this._nextKeyPcmBytes >= this.sampleRate * this.channels * 2 * 3
    ) {
      const fullPcm = Buffer.concat(this._nextKeyPcm)
      this._detectedNextKey = estimateKeyFromPcm(
        fullPcm,
        this.sampleRate,
        this.channels
      )
      this._nextKeyDetected = true
      this._nextKeyPcm = []
      if (this._detectedNextKey) {
        logger(
          'info',
          'AutoMix',
          `Next track key detected from preload audio (eager): ${this._detectedNextKey.key} (${this._detectedNextKey.camelot})`
        )
      }
    }
    if (this._detectedNextKey) return this._detectedNextKey

    if (
      !this.ringBuffer ||
      this.ringBuffer.length < Math.round(3000 * this.bytesPerMs)
    )
      return null

    const maxBytes = Math.min(
      Math.round(10000 * this.bytesPerMs),
      this.ringBuffer.length
    )
    const peek = this.ringBuffer.peek(maxBytes)
    if (!peek || peek.length < 4) return null

    const fallback = estimateKeyFromPcm(peek, this.sampleRate, this.channels)
    if (fallback) {
      this._detectedNextKey = fallback
      this._nextKeyDetected = true
    }
    return fallback
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    let data = chunk
    if (this.mainPending && this.mainPending.length > 0) {
      data = Buffer.concat([this.mainPending, chunk])
      this.mainPending = null
    }

    const remainder = data.length % 4
    if (remainder > 0) {
      this.mainPending = Buffer.from(data.subarray(data.length - remainder))
      data = data.subarray(0, data.length - remainder)
    }

    if (!data.length || !this.crossfade || !this.ringBuffer) {
      if (data.length) {
        this._updateEnergy(data)
        this.push(data)
      }
      callback()
      return
    }

    this._updateEnergy(data)

    const needed = data.length

    this._drainSpillToRing()

    const totalBuffered = this.ringBuffer.length + this.nextSpillBytes
    const resumeAt = this.crossfade?.isFinished
      ? Math.max(needed, Math.round(this.targetBufferBytes * 0.75))
      : needed
    if (totalBuffered < resumeAt) {
      this._resumeNextStream()
    }

    const nextChunk = this.ringBuffer.read(needed)
    if (nextChunk) {
      // Track consumed samples for position reporting EVERY time we read.
      // This fixes the lyrics freeze/jump bug.
      this._totalNextConsumedSamples += nextChunk.length / (this.channels * 2)
    }

    if (!nextChunk) {
      const silence = Buffer.alloc(needed, 0)
      this.push(this._mixBuffers(data, silence, this.crossfade))
      callback()
      return
    }

    let paddedNext = nextChunk
    if (nextChunk.length !== data.length) {
      paddedNext = Buffer.allocUnsafe(data.length)
      paddedNext.fill(0)
      nextChunk.copy(paddedNext, 0, 0, nextChunk.length)
    }

    if (this.crossfade.isFinished) {
      if (!this._bypassTriggered) {
        this._bypassTriggered = true
        this.filterBypassSetter?.(true)
        this.filterStateResetter?.()
      }

      const output = this.filterProcessor
        ? this.filterProcessor(paddedNext)
        : paddedNext

      if (this._incomingGain !== 1) {
        // Instant restore gain to 1.0 after crossfade is finished.
        // No ramp-up needed as it causes perceived low volume.
        this._incomingGain = 1.0
      }

      this.push(output)
      callback()
      return
    }

    const mixed = this._mixBuffers(data, paddedNext, this.crossfade)
    this.push(mixed)

    callback()
  }

  override _flush(callback: TransformCallback): void {
    this._flushed = true
    if (!this.crossfade && !this.ringBuffer) {
      this.clear()
      callback()
      return
    }

    const FRAME_SIZE = 3840
    const FRAME_MS = (FRAME_SIZE / 2 / this.channels / this.sampleRate) * 1000 // ~20 ms
    const INITIAL_BURST_MS = 200 // pre-fill 200 ms on entry
    const MAX_AHEAD_MS = 60 // stay max 60 ms ahead of wall clock (was 100)
    const PUMP_CHECK_MS = 20 // check pace every 20 ms (was 15)
    const MAX_PER_TICK = 3 // hard cap per tick (max 3x real-time catch-up)
    const STARVATION_TIMEOUT_MS = 5000 // end stream after 5 s of no data

    const ringLen = this.ringBuffer?.length ?? 0
    const spillLen = this.nextSpillBytes
    const streamAlive =
      this.nextStream &&
      !(this.nextStream as any).destroyed &&
      !(this.nextStream as any).readableEnded
    logger(
      'debug',
      'Crossfade',
      `Bridge pump starting in _flush { ringMs: ${Math.round(ringLen / this.bytesPerMs)}, spillMs: ${Math.round(spillLen / this.bytesPerMs)}, streamAlive: ${!!streamAlive} }`
    )

    this._resumeNextStream()
    this._drainSpillToRing()

    const pump = () => {
      if (this._bridgePumpRunning) return

      if (!this.crossfade) {
        const WAIT_LIMIT_MS = 15_000
        const WAIT_POLL_MS = 50
        const waitStart = Date.now()
        const waitForCrossfade = () => {
          if (this.crossfade) {
            pump()
            return
          }
          if (Date.now() - waitStart > WAIT_LIMIT_MS) {
            logger(
              'warn',
              'Crossfade',
              'Bridge pump: crossfade never initialized within wait window; ending stream'
            )
            callback()
            return
          }
          setTimeout(waitForCrossfade, WAIT_POLL_MS)
        }
        logger(
          'debug',
          'Crossfade',
          'Bridge pump: waiting for crossfade initialization (source ended during pre-lead)'
        )
        waitForCrossfade()
        return
      }

      this._bridgePumpRunning = true
      this._pumpTotalPausedMs = 0
      this._pumpPausedAt = 0
      let starvationStart: number | null = null
      let bridgeSilenceStart: number | null = null
      const pumpStartTime = Date.now()
      let totalPushedMs = 0
      let filteredBCarry = Buffer.alloc(0)

      const step = () => {
        if (!this.crossfade) {
          this._bridgePumpRunning = false
          callback()
          return
        }

        if (this._pumpPaused) {
          setTimeout(step, 50)
          return
        }

        this._drainSpillToRing()
        this._resumeNextStream()

        if (this._bcfRing) {
          this._bcfDrainSpill()
          this._bcfResumeStream()
        }

        const wallElapsed = Date.now() - pumpStartTime - this._pumpTotalPausedMs
        const budgetMs =
          totalPushedMs === 0 ? INITIAL_BURST_MS : wallElapsed + MAX_AHEAD_MS

        let pushed = 0
        while (totalPushedMs < budgetMs && pushed < MAX_PER_TICK) {
          if (!this.ringBuffer) break
          let nextChunk = this.ringBuffer.read(FRAME_SIZE)

          if (nextChunk) {
            starvationStart = null
            if (!this._bcfCountFrozen) {
              this._totalNextConsumedSamples += nextChunk.length / (this.channels * 2)
            }
            if (
              this._bridgeCrossfadeActive &&
              !this._bcfRuntime &&
              !this._bcfCountFrozen
            ) {
              this._bcfConsumedSamples += nextChunk.length / (this.channels * 2)
            }
          }

          const streamDead =
            !this.nextStream ||
            (this.nextStream as any).destroyed ||
            (this.nextStream as any).readableEnded === true

          if (!nextChunk && !streamDead) {
            if (!starvationStart) {
              starvationStart = Date.now()
            } else if (Date.now() - starvationStart > STARVATION_TIMEOUT_MS) {
              if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                logger(
                  'warn',
                  'Crossfade',
                  `Bridge starvation timeout during B→C blend — forcing swap to Track C`
                )
                this._bcfRuntime.isFinished = true
                this._swapBridgeCrossfade()
                starvationStart = null
                setTimeout(step, 5)
                return
              }
              logger(
                'warn',
                'Crossfade',
                `Audio bridge starvation timeout (${STARVATION_TIMEOUT_MS} ms); ending stream`
              )
              this._bridgePumpRunning = false
              const bridgeDoneCb = this.onBridgeDrained
              this.clear()
              bridgeDoneCb?.()
              callback()
              return
            }
            break
          }

          if (!nextChunk && streamDead) {
            if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
              logger(
                'info',
                'Crossfade',
                'Track B exhausted during bridge crossfade — force-completing blend to Track C'
              )

              const RESCUE_SILENCE = Buffer.alloc(FRAME_SIZE, 0) // silence for Track B
              let rescuedFrames = 0
              const MAX_RESCUE = 2000 // safety cap (~40 s)

              while (
                !this._bcfRuntime!.isFinished &&
                rescuedFrames < MAX_RESCUE
              ) {
                this._bcfDrainSpill()
                this._bcfResumeStream()

                const cChunk = this._bcfRing?.read(FRAME_SIZE)
                if (!cChunk) break // Track C also exhausted — give up

                const framesInChunk = FRAME_SIZE / 2 / this.channels
                this._totalNextConsumedSamples += framesInChunk

                const bcfRT = this._bcfRuntime!
                const fadeRemain = Math.max(
                  0,
                  bcfRT.durationFrames - bcfRT.elapsedFrames
                )
                const fadeF = Math.min(framesInChunk, fadeRemain)
                const mixed = Buffer.allocUnsafe(FRAME_SIZE)

                for (let f = 0; f < framesInChunk; f++) {
                  const progress =
                    f < fadeF
                      ? (bcfRT.elapsedFrames + f) / bcfRT.durationFrames
                      : 1
                  const [, gainIn] = this._fadeGains(
                    Math.min(1, progress),
                    bcfRT.curve
                  )
                  const base = f * this.channels

                  let cL = cChunk.readInt16LE(base * 2)
                  let cR =
                    this.channels > 1 ? cChunk.readInt16LE((base + 1) * 2) : cL

                  if (this._hpEnabled && progress < 1) {
                    const hpP = Math.min(1, progress / 0.3)
                    const hpAlpha =
                      this._hpPeakAlpha *
                      (1 - (1 - Math.cos(hpP * Math.PI)) / 2)
                    if (hpAlpha > 0.001) {
                      this._bcfHpPrevL += hpAlpha * (cL - this._bcfHpPrevL)
                      cL -= this._bcfHpPrevL
                      this._bcfHpPrevR += hpAlpha * (cR - this._bcfHpPrevR)
                      cR -= this._bcfHpPrevR
                    }
                  }
                  if (this._lpEnabled && progress < this._lpCompletionRatio) {
                    const lpP = Math.min(1, progress / this._lpCompletionRatio)
                    const lpProgress = (1 - Math.cos(lpP * Math.PI)) / 2
                    const lpAlpha =
                      this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress
                    this._bcfLpPrevL += lpAlpha * (cL - this._bcfLpPrevL)
                    cL = Math.round(this._bcfLpPrevL)
                    this._bcfLpPrevR += lpAlpha * (cR - this._bcfLpPrevR)
                    cR = Math.round(this._bcfLpPrevR)
                  }

                  if (
                    this._echoEnabled &&
                    this._bcfEchoDelayL &&
                    this._bcfEchoDelayR
                  ) {
                    const delayLen = this._echoDelayFrames
                    const readPos =
                      (((this._bcfEchoWritePos - delayLen) % delayLen) +
                        delayLen) %
                      delayLen
                    const delayedL = this._bcfEchoDelayL[readPos]!
                    const delayedR = this._bcfEchoDelayR[readPos]!
                    const rfbL = cL + delayedL * this._echoFeedback
                    const rfbR = cR + delayedR * this._echoFeedback
                    this._bcfEchoDelayL[this._bcfEchoWritePos] =
                      rfbL > 65534 ? 65534 : rfbL < -65534 ? -65534 : rfbL
                    this._bcfEchoDelayR[this._bcfEchoWritePos] =
                      rfbR > 65534 ? 65534 : rfbR < -65534 ? -65534 : rfbR
                    this._bcfEchoWritePos =
                      (this._bcfEchoWritePos + 1) % delayLen
                    if (progress < this._echoCompletionRatio) {
                      const echoT = progress / this._echoCompletionRatio
                      const echoWet = this._echoPeakMix * (1 - echoT)
                      const echoDry = 1 - echoWet
                      cL = cL * echoDry + delayedL * echoWet
                      cR = cR * echoDry + delayedR * echoWet
                    }
                  }

                  cL = this._softClipSample(cL)
                  cR = this._softClipSample(cR)

                  const [adjOut, adjIn] = this._computeCoherenceGains(
                    0,
                    gainIn,
                    progress
                  )
                  const mixL = cL * adjIn
                  const mixR = cR * adjIn
                  mixed.writeInt16LE(this._toInt16Sample(mixL), base * 2)
                  if (this.channels > 1) {
                    mixed.writeInt16LE(
                      this._toInt16Sample(mixR),
                      (base + 1) * 2
                    )
                  }
                }

                bcfRT.elapsedFrames += fadeF
                if (bcfRT.elapsedFrames >= bcfRT.durationFrames) {
                  bcfRT.isFinished = true
                }
                this.push(mixed)
                totalPushedMs += FRAME_MS
                rescuedFrames++
              }

              if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                this._bcfRuntime.isFinished = true
              }
              logger(
                'info',
                'Crossfade',
                `Bridge crossfade rescue complete — swapping to Track C (${rescuedFrames} frames rescued)`
              )
              this._swapBridgeCrossfade()
              starvationStart = null
              setTimeout(step, 5)
              return
            }

            const MAX_BRIDGE_SILENCE_MS = 90_000 // max 90 s of silence
            const bcfHasData =
              this._bcfRing && this._bcfRing.length >= FRAME_SIZE
            if (bcfHasData && (this._bcfRuntime || this._bcfReady)) {
              if (bridgeSilenceStart) {
                const silenceElapsed = Date.now() - bridgeSilenceStart
                logger(
                  'info',
                  'Crossfade',
                  `Bridge crossfade ready after ${Math.round(silenceElapsed)}ms of silence — resuming blend`
                )
                bridgeSilenceStart = null
              }
              starvationStart = null
              nextChunk = Buffer.alloc(FRAME_SIZE, 0)
            } else {
              if (!bridgeSilenceStart) {
                bridgeSilenceStart = Date.now()
                logger(
                  'warn',
                  'Crossfade',
                  'Bridge pump starving (ring empty, stream dead) — pushing silence while awaiting crossfade trigger'
                )
                this.onBridgeStarving?.()
              }

              const silenceElapsed = Date.now() - bridgeSilenceStart
              if (silenceElapsed > MAX_BRIDGE_SILENCE_MS) {
                logger(
                  'warn',
                  'Crossfade',
                  `Bridge silence timeout (${Math.round(silenceElapsed)}ms) — ending stream`
                )
                this._bridgePumpRunning = false
                const bridgeDoneCb = this.onBridgeDrained
                this.clear()
                bridgeDoneCb?.()
                callback()
                return
              }

              const silence = Buffer.alloc(FRAME_SIZE, 0)
              this.push(silence)
              totalPushedMs += FRAME_MS
              pushed++

              setTimeout(step, 5)
              return
            }
          }

          if (!nextChunk) break

          let outBuf = nextChunk

          if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
            this._bcfDrainSpill()
            this._bcfResumeStream()

            const trackCChunk = this._bcfRing?.read(FRAME_SIZE)
            if (trackCChunk) {
              this._bcfConsumedSamples +=
                trackCChunk.length / (this.channels * 2)

              const rawFiltered = this.filterProcessor
                ? this.filterProcessor(outBuf)
                : outBuf

              let filteredB =
                filteredBCarry.length > 0
                  ? Buffer.concat([filteredBCarry, rawFiltered])
                  : rawFiltered

              if (filteredB.length > FRAME_SIZE) {
                filteredBCarry = Buffer.from(filteredB.subarray(FRAME_SIZE))
                filteredB = filteredB.subarray(0, FRAME_SIZE)
              } else {
                filteredBCarry = Buffer.alloc(0)
                if (filteredB.length < FRAME_SIZE) {
                  const padded = Buffer.allocUnsafe(FRAME_SIZE)
                  padded.fill(0)
                  filteredB.copy(padded, 0, 0, filteredB.length)
                  filteredB = padded
                }
              }

              let paddedC = trackCChunk
              if (paddedC.length < FRAME_SIZE) {
                const padded = Buffer.allocUnsafe(FRAME_SIZE)
                padded.fill(0)
                paddedC.copy(padded, 0, 0, paddedC.length)
                paddedC = padded
              }

              const totalFrames = FRAME_SIZE / 2 / this.channels
              const bcfRT = this._bcfRuntime
              const fadeFrames = Math.min(
                totalFrames,
                Math.max(0, bcfRT.durationFrames - bcfRT.elapsedFrames)
              )
              const mixed = Buffer.allocUnsafe(FRAME_SIZE)

              const lag =
                bcfRT.elapsedFrames === 0
                  ? this._calculateOptimalLag(filteredB, paddedC, 128)
                  : 0

              for (let f = 0; f < totalFrames; f++) {
                const progress =
                  f < fadeFrames
                    ? (bcfRT.elapsedFrames + f) / bcfRT.durationFrames
                    : 1
                const [gainOut, gainInBase] = this._fadeGains(
                  Math.min(1, progress),
                  bcfRT.curve
                )

                // Smooth gain recovery
                let gainIn = gainInBase
                if (this._incomingGain !== 1) {
                  const gainRecovery = this._smoothStep01(progress)
                  const currentInGain =
                    this._incomingGain +
                    (1.0 - this._incomingGain) * gainRecovery
                  gainIn *= currentInGain
                }

                const base = f * this.channels
                const nextBase = base + lag * this.channels

                const safeNextBase = Math.max(
                  0,
                  Math.min(nextBase, FRAME_SIZE / 2 - this.channels)
                )

                let cL = paddedC.readInt16LE(safeNextBase * 2)
                let cR =
                  this.channels > 1
                    ? paddedC.readInt16LE((safeNextBase + 1) * 2)
                    : cL

                if (this._hpEnabled && progress < 1) {
                  const hpP = Math.min(1, progress / 0.3)
                  const hpAlpha =
                    this._hpPeakAlpha * (1 - (1 - Math.cos(hpP * Math.PI)) / 2)
                  if (hpAlpha > 0.001) {
                    this._bcfHpPrevL += hpAlpha * (cL - this._bcfHpPrevL)
                    cL -= this._bcfHpPrevL
                    this._bcfHpPrevR += hpAlpha * (cR - this._bcfHpPrevR)
                    cR -= this._bcfHpPrevR
                  } else {
                    this._bcfHpPrevL = 0
                    this._bcfHpPrevR = 0
                  }
                }

                if (this._lpEnabled && progress < this._lpCompletionRatio) {
                  const lpP = Math.min(1, progress / this._lpCompletionRatio)
                  const lpProgress = (1 - Math.cos(lpP * Math.PI)) / 2
                  const lpAlpha =
                    this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress
                  this._bcfLpPrevL += lpAlpha * (cL - this._bcfLpPrevL)
                  cL = Math.round(this._bcfLpPrevL)
                  this._bcfLpPrevR += lpAlpha * (cR - this._bcfLpPrevR)
                  cR = Math.round(this._bcfLpPrevR)
                }

                if (
                  this._echoEnabled &&
                  this._bcfEchoDelayL &&
                  this._bcfEchoDelayR
                ) {
                  const delayLen = this._echoDelayFrames
                  const readPos =
                    (((this._bcfEchoWritePos - delayLen) % delayLen) +
                      delayLen) %
                    delayLen

                  const delayedL = this._bcfEchoDelayL[readPos]!
                  const delayedR = this._bcfEchoDelayR[readPos]!

                  const bfbL2 = cL + delayedL * this._echoFeedback
                  const bfbR2 = cR + delayedR * this._echoFeedback
                  this._bcfEchoDelayL[this._bcfEchoWritePos] =
                    bfbL2 > 65534 ? 65534 : bfbL2 < -65534 ? -65534 : bfbL2
                  this._bcfEchoDelayR[this._bcfEchoWritePos] =
                    bfbR2 > 65534 ? 65534 : bfbR2 < -65534 ? -65534 : bfbR2

                  this._bcfEchoWritePos = (this._bcfEchoWritePos + 1) % delayLen

                  if (progress < this._echoCompletionRatio) {
                    const echoT = progress / this._echoCompletionRatio
                    const echoWet = this._echoPeakMix * (1 - echoT)
                    const echoDry = 1 - echoWet
                    cL = cL * echoDry + delayedL * echoWet
                    cR = cR * echoDry + delayedR * echoWet
                  }
                }

                cL = this._softClipSample(cL)
                cR = this._softClipSample(cR)

                if (this._panEnabled && progress < this._panCompletionRatio) {
                  const panT = progress / this._panCompletionRatio
                  const panL = (1 - Math.cos(panT * Math.PI)) / 2
                  cL *= panL
                }

                const bL = filteredB.readInt16LE(base * 2)
                const bR =
                  this.channels > 1 ? filteredB.readInt16LE((base + 1) * 2) : bL

                const [adjOut, adjIn] = this._computeCoherenceGains(
                  gainOut,
                  gainIn,
                  progress
                )

                let mixL = bL * adjOut + cL * adjIn
                let mixR = bR * adjOut + cR * adjIn

                // Headroom Guard for Bridge Blend
                const predPeak = Math.max(
                  Math.abs(bL) * adjOut + Math.abs(cL) * adjIn,
                  Math.abs(bR) * adjOut + Math.abs(cR) * adjIn
                )
                if (predPeak > MIX_BUS_TARGET_PEAK_FUSION) {
                  const scale = MIX_BUS_TARGET_PEAK_FUSION / predPeak
                  mixL *= scale
                  mixR *= scale
                }

                mixed.writeInt16LE(this._toInt16Sample(mixL), base * 2)
                if (this.channels > 1) {
                  mixed.writeInt16LE(
                    this._toInt16Sample(mixR),
                    (base + 1) * 2
                  )
                }
              }

              bcfRT.elapsedFrames += fadeFrames
              // Track consumed samples for position reporting during bridge blend
              if (!this._bcfCountFrozen) {
                this._totalNextConsumedSamples += fadeFrames
              }

              if (bcfRT.elapsedFrames >= bcfRT.durationFrames) {
                bcfRT.isFinished = true
                logger(
                  'info',
                  'Crossfade',
                  'Bridge crossfade: blend complete — swapping to Track C'
                )
                this._swapBridgeCrossfade()
                starvationStart = null
              }

              const canPush = this.push(mixed)
              totalPushedMs += FRAME_MS
              pushed++
              if (!canPush) break
              continue
            }
          }

          if (this._incomingGain !== 1) {
            this._incomingGain = 1.0
          }

          if (outBuf.length < FRAME_SIZE) {
            const padded = Buffer.allocUnsafe(FRAME_SIZE)
            padded.fill(0)
            outBuf.copy(padded, 0, 0, outBuf.length)
            outBuf = padded
          }

          if (
            this.crossfade &&
            !this.crossfade.isFinished &&
            !this._bcfRuntime
          ) {
            const framesInChunk = FRAME_SIZE / 2 / this.channels
            this.crossfade.elapsedFrames += framesInChunk
            if (this.crossfade.elapsedFrames >= this.crossfade.durationFrames) {
              this.crossfade.isFinished = true
            }
          }

          if (this.filterProcessor) {
            outBuf = this.filterProcessor(outBuf)
          }

          const actualMs =
            (outBuf.length / 2 / this.channels / this.sampleRate) * 1000
          const canPush = this.push(outBuf)
          totalPushedMs += actualMs
          pushed++

          if (!canPush) break
        }

        setTimeout(step, pushed > 0 ? PUMP_CHECK_MS : 5)
      }

      step()
    }

    pump()
  }
}
