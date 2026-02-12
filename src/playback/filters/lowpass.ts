import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

/**
 * Applies a simple low-pass filter to the audio.
 * @public
 */
export default class Lowpass extends BaseFilter {
  public priority = 10
  private smoothing = 0
  private smoothingFactor = 0
  private prevLeftOutput = 0
  private prevRightOutput = 0

  /**
   * Updates the low-pass filter settings.
   * @param settings - Filter settings containing `lowpass`.
   */
  public override update(settings: FilterSettings): void {
    const { smoothing = 0 } = settings.lowpass || {}

    if (smoothing > 1.0) {
      this.smoothing = smoothing
      this.smoothingFactor = 1.0 / smoothing
    } else {
      this.smoothing = 0
      this.smoothingFactor = 0
    }
    this.prevLeftOutput = 0
    this.prevRightOutput = 0
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    if (this.smoothing <= 1.0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const currentLeftSample = chunk.readInt16LE(i)
      const newLeftSample =
        this.prevLeftOutput +
        this.smoothingFactor * (currentLeftSample - this.prevLeftOutput)
      this.prevLeftOutput = newLeftSample
      chunk.writeInt16LE(clamp16Bit(newLeftSample), i)

      const currentRightSample = chunk.readInt16LE(i + 2)
      const newRightSample =
        this.prevRightOutput +
        this.smoothingFactor * (currentRightSample - this.prevRightOutput)
      this.prevRightOutput = newRightSample
      chunk.writeInt16LE(clamp16Bit(newRightSample), i + 2)
    }

    return chunk
  }

  /**
   * Flushes any pending data.
   * @returns An empty Buffer.
   */
  public override flush(): Buffer {
    this.prevLeftOutput = 0
    this.prevRightOutput = 0
    return Buffer.alloc(0)
  }
}
