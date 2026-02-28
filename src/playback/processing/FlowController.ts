import { Transform, type TransformCallback } from 'node:stream'
import type {
  AudioMixer,
  FiltersState
} from '../../typings/playback/player.types.ts'
import type {
  IFadeTransformer,
  IFiltersManager,
  IScratchTransformer,
  ITapeTransformer,
  IVolumeTransformer,
  ScratchStyle
} from '../../typings/playback/processing.types.ts'

const FRAME_SIZE = 3840
const EMPTY_BUFFER = Buffer.alloc(0)

/**
 * Controller that coordinates filters, volume, fading, scratching, and mixing in a single stream.
 * @public
 */
export class FlowController extends Transform {
  private readonly filters: IFiltersManager
  private readonly volume: IVolumeTransformer
  private readonly fade: IFadeTransformer
  private readonly tape: ITapeTransformer
  private readonly scratch: IScratchTransformer
  private readonly audioMixer: AudioMixer | null
  private pendingBuffer: Buffer
  private pendingLength: number

  /**
   * Creates a new FlowController.
   * @param filters - The FiltersManager instance.
   * @param volume - The VolumeTransformer instance.
   * @param fade - The FadeTransformer instance.
   * @param tape - The TapeTransformer instance.
   * @param scratch - The ScratchTransformer instance.
   * @param audioMixer - Optional AudioMixer instance.
   */
  constructor(
    filters: IFiltersManager,
    volume: IVolumeTransformer,
    fade: IFadeTransformer,
    tape: ITapeTransformer,
    scratch: IScratchTransformer,
    audioMixer: AudioMixer | null = null
  ) {
    super({ highWaterMark: FRAME_SIZE * 4 })

    this.filters = filters
    this.volume = volume
    this.fade = fade
    this.tape = tape
    this.scratch = scratch
    this.audioMixer = audioMixer
    this.pendingBuffer = Buffer.allocUnsafe(FRAME_SIZE)
    this.pendingLength = 0
  }

  private _processFrame(frame: Buffer): void {
    let output: Buffer = frame

    output = this.filters.process(output)
    output = this.tape.process(output)
    output = this.scratch.process(output)
    output = this.volume.process(output)
    output = this.fade.process(output)

    if (
      this.audioMixer &&
      this.audioMixer.enabled !== false &&
      this.audioMixer.hasActiveLayers()
    ) {
      try {
        const layerChunks = this.audioMixer.readLayerChunks(output.length)
        output = this.audioMixer.mixBuffers(output, layerChunks)
      } catch (_error) {
        // Ignore mixing errors in flow
      }
    }

    this.push(output)
  }

  /**
   * Sets the volume gain.
   * @param volume - New volume level.
   */
  public setVolume(volume: number): void {
    this.volume.setVolume(volume)
  }

  /**
   * Updates the audio filters.
   * @param filters - New filters state.
   */
  public setFilters(filters: FiltersState): void {
    this.filters.update(filters)
  }

  /**
   * Sets the fade gain immediately.
   * @param volume - New fade volume.
   */
  public setFadeVolume(volume: number): void {
    this.fade.setGain(volume)
  }

  /**
   * Schedules a fade effect.
   * @param volume - Target volume.
   * @param durationMs - Duration of the fade in milliseconds.
   * @param curve - Fading curve type.
   */
  public fadeTo(volume: number, durationMs: number, curve?: string): void {
    this.fade.fadeTo(volume, durationMs, curve)
  }

  /**
   * Schedules a tape effect.
   * @param durationMs - Duration of the ramp in milliseconds.
   * @param type - Ramp type ('start' or 'stop').
   * @param curve - Fading curve type.
   */
  public tapeTo(
    durationMs: number,
    type: 'start' | 'stop',
    curve?: string
  ): void {
    this.tape.tapeTo(durationMs, type, curve)
  }

  /**
   * Schedules a scratch effect.
   * @param durationMs - Duration of the scratch movement.
   * @param style - The style of scratch to apply.
   */
  public scratchTo(durationMs: number, style: ScratchStyle): void {
    this.scratch.scratchTo(durationMs, style)
  }

  public checkTapeRampCompleted(): boolean {
    return this.tape.checkRampCompleted()
  }

  public checkScratchEffectCompleted(): boolean {
    return this.scratch.checkEffectCompleted()
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    let offset = 0

    if (this.pendingLength > 0) {
      const needed = FRAME_SIZE - this.pendingLength
      const toCopy = Math.min(needed, chunk.length)
      chunk.copy(this.pendingBuffer, this.pendingLength, 0, toCopy)
      this.pendingLength += toCopy
      offset += toCopy

      if (this.pendingLength === FRAME_SIZE) {
        this._processFrame(this.pendingBuffer)
        this.pendingLength = 0
      }
    }

    const remaining = chunk.length - offset
    const fullFrameBytes = remaining - (remaining % FRAME_SIZE)
    const end = offset + fullFrameBytes

    for (let i = offset; i < end; i += FRAME_SIZE) {
      this._processFrame(chunk.subarray(i, i + FRAME_SIZE))
    }

    if (end < chunk.length) {
      this.pendingLength = chunk.length - end
      chunk.copy(this.pendingBuffer, 0, end)
    }

    callback()
  }

  public override _flush(callback: TransformCallback): void {
    let remaining =
      this.pendingLength > 0
        ? this.pendingBuffer.subarray(0, this.pendingLength)
        : EMPTY_BUFFER
    this.pendingLength = 0

    const flushed = this.filters.flush()
    if (flushed.length > 0) {
      remaining =
        remaining.length > 0 ? Buffer.concat([remaining, flushed]) : flushed
    }

    if (remaining.length > 0) {
      remaining = this.tape.process(remaining)
      remaining = this.scratch.process(remaining)
      remaining = this.volume.process(remaining)
      remaining = this.fade.process(remaining)

      if (
        this.audioMixer &&
        this.audioMixer.enabled !== false &&
        this.audioMixer.hasActiveLayers()
      ) {
        try {
          const layerChunks = this.audioMixer.readLayerChunks(remaining.length)
          remaining = this.audioMixer.mixBuffers(remaining, layerChunks)
        } catch (_error) {
          // Ignore mixing errors in flow
        }
      }

      const finalRemainder = remaining.length % 4
      if (finalRemainder > 0) {
        remaining = remaining.subarray(0, remaining.length - finalRemainder)
      }

      if (remaining.length > 0) this.push(remaining)
    }

    // Drain loop: Continue producing silence frames while effects are active.
    // This ensures trackEnd scratch effects are fully audible even after source EOF.
    const silence = Buffer.alloc(FRAME_SIZE, 0)
    let drainLimit = 150 // ~1.2s safety limit
    while (
      (this.scratch.isActive() || this.tape.isActive()) &&
      drainLimit-- > 0
    ) {
      this._processFrame(silence)
    }

    callback()
  }
}
