import { type Readable, Transform, type TransformCallback } from 'node:stream'
import type { FadeCurve } from '../../typings/playback/processing.types.ts'
import { logger } from '../../utils.ts'
import { RingBuffer } from '../structs/RingBuffer.ts'

const HALF_PI = Math.PI / 2
const DEFAULT_CURVE: FadeCurve = 'sinusoidal'
const SUPPORTED_CURVES = new Set<FadeCurve>(['linear', 'sine', 'sinusoidal'])

interface CrossfadeRuntime {
  durationFrames: number
  elapsedFrames: number
  curve: FadeCurve
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
  private bufferSize: number
  private targetBufferBytes: number
  private minBufferBytes: number
  private ringBuffer: RingBuffer | null = null
  private nextStream: Readable | null = null
  private nextPending: Buffer | null = null
  private nextSpill: Buffer | null = null
  private mainPending: Buffer | null = null
  private crossfade: CrossfadeRuntime | null = null
  private bufferReady = false
  private warnedCurve: FadeCurve | null = null

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

    // Drain buffered overflow first to preserve contiguous ordering.
    this._drainSpillToRing()

    const remaining = this.bufferSize - this.ringBuffer.length
    if (remaining <= 0) {
      this._appendSpill(data)
      this._pauseNextStream()
      return
    }

    if (data.length > remaining) {
      this.ringBuffer.write(data.subarray(0, remaining))
      this._appendSpill(data.subarray(remaining))
      this.bufferReady = true
      this._pauseNextStream()
      return
    }

    this.ringBuffer.write(data)
    if (this.ringBuffer.length >= this.targetBufferBytes) {
      this.bufferReady = true
      this._pauseNextStream()
    }
  }

  private readonly onNextEnd = () => {
    this._pauseNextStream()
  }

  private _appendSpill(data: Buffer): void {
    if (!data.length) return
    if (!this.nextSpill || this.nextSpill.length === 0) {
      this.nextSpill = Buffer.from(data)
      return
    }
    this.nextSpill = Buffer.concat([this.nextSpill, data])
  }

  private _drainSpillToRing(): void {
    if (!this.ringBuffer || !this.nextSpill || this.nextSpill.length === 0)
      return

    const remaining = this.bufferSize - this.ringBuffer.length
    if (remaining <= 0) return

    const toWrite = Math.min(remaining, this.nextSpill.length)
    const writeBytes = toWrite - (toWrite % 4)
    if (writeBytes <= 0) return

    this.ringBuffer.write(this.nextSpill.subarray(0, writeBytes))
    this.nextSpill =
      writeBytes >= this.nextSpill.length
        ? null
        : Buffer.from(this.nextSpill.subarray(writeBytes))

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

  /**
   * Creates a new CrossfadeController.
   *
   * @param sampleRate - PCM sample rate (Hz).
   * @param channels - Number of audio channels.
   * @example
   * ```ts
   * const controller = new CrossfadeController(48000, 2)
   * ```
   */
  constructor(sampleRate = 48000, channels = 2) {
    super()
    this.sampleRate = sampleRate
    this.channels = channels
    this.bytesPerMs = (this.sampleRate * this.channels * 2) / 1000
    this.bufferSize = Math.round(this.bytesPerMs * 1000)
    this.targetBufferBytes = 0
    this.minBufferBytes = 0
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
    this.clear()
    this.nextStream = stream

    const durationMs = Math.max(0, options.durationMs)
    const minBufferMs =
      options.minBufferMs !== undefined
        ? Math.max(0, options.minBufferMs)
        : durationMs
    const bufferMs =
      options.bufferMs !== undefined
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
  }

  /**
   * Returns the buffered duration (ms) available for crossfade.
   */
  public getBufferedMs(): number {
    if (!this.ringBuffer) return 0
    return this.ringBuffer.length / this.bytesPerMs
  }

  /**
   * Returns the current crossfade status.
   */
  public getState(): { active: boolean; bufferedMs: number; targetMs: number; isFinished: boolean } {
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
  public startCrossfade(durationMs: number, curve?: FadeCurve): boolean {
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
      isFinished: false
    }
    return true
  }

  /**
   * Clears the buffered next track and resets crossfade state.
   */
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
    this.nextSpill = null
    this.mainPending = null
    this.crossfade = null
    this.bufferReady = false
    this.targetBufferBytes = 0
    this.minBufferBytes = 0
    this.ringBuffer?.dispose()
    this.ringBuffer = null
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

  private _mixBuffers(
    main: Buffer,
    next: Buffer,
    runtime: CrossfadeRuntime
  ): Buffer {
    const sampleCount = main.length >> 1
    if (sampleCount === 0) return main

    const output = Buffer.allocUnsafe(main.length)

    const mainAligned = main.byteOffset % 2 === 0
    const nextAligned = next.byteOffset % 2 === 0
    const outAligned = output.byteOffset % 2 === 0

    const mainView = mainAligned
      ? new Int16Array(main.buffer, main.byteOffset, sampleCount)
      : null
    const nextView = nextAligned
      ? new Int16Array(next.buffer, next.byteOffset, sampleCount)
      : null
    const outView = outAligned
      ? new Int16Array(output.buffer, output.byteOffset, sampleCount)
      : null

    const totalFrames = Math.floor(sampleCount / this.channels)
    const remainingFrames = runtime.isFinished ? 0 : Math.max(
      0,
      runtime.durationFrames - runtime.elapsedFrames
    )
    const fadeFrames = Math.min(totalFrames, remainingFrames)

    const getMain = (i: number): number =>
      mainView ? (mainView[i] ?? 0) : main.readInt16LE(i * 2)
    const getNext = (i: number): number =>
      nextView ? (nextView[i] ?? 0) : next.readInt16LE(i * 2)
    const setOut = (i: number, val: number): void => {
      if (outView) outView[i] = val
      else output.writeInt16LE(val, i * 2)
    }

    for (let frame = 0; frame < totalFrames; frame++) {
      let frameProgress = 1
      if (!runtime.isFinished) {
        frameProgress =
          frame < fadeFrames
            ? (runtime.elapsedFrames + frame) / runtime.durationFrames
            : 1
      }
      
      const [gainOut, gainIn] = this._fadeGains(frameProgress, runtime.curve)
      const base = frame * this.channels
      for (let c = 0; c < this.channels; c++) {
        const idx = base + c
        const mixed = getMain(idx) * gainOut + getNext(idx) * gainIn
        const clamped =
          mixed < -32768 ? -32768 : mixed > 32767 ? 32767 : Math.round(mixed)
        setOut(idx, clamped)
      }
    }

    if (!runtime.isFinished) {
      runtime.elapsedFrames += fadeFrames
      if (runtime.elapsedFrames >= runtime.durationFrames) {
        runtime.isFinished = true
      }
    }

    return output
  }

  private _fadeGains(progress: number, curve: FadeCurve): [number, number] {
    const clamped = Math.min(1, Math.max(0, progress))
    if (curve === 'linear') {
      return [1 - clamped, clamped]
    }
    const fadeOut = Math.cos(clamped * HALF_PI)
    const fadeIn = Math.sin(clamped * HALF_PI)
    return [fadeOut, fadeIn]
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
      if (data.length) this.push(data)
      callback()
      return
    }

    this._drainSpillToRing()

    const needed = data.length
    if (this.ringBuffer.length < needed) {
      this._resumeNextStream()
    }

    const nextChunk = this.ringBuffer.read(needed)
    if (!nextChunk) {
      // If we don't have next track data yet, but crossfade is active,
      // it means we are in a buffer underrun for the next track.
      // We still mix Song A at its current fade level with silence.
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

    this.push(this._mixBuffers(data, paddedNext, this.crossfade))
    callback()
  }

  override _final(callback: TransformCallback): void {
    this.clear()
    callback()
  }
}
