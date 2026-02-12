import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

/**
 * Applies a simple high-pass filter to the audio.
 * @public
 */
export default class Highpass extends BaseFilter {
  public priority = 10
  private smoothing = 0
  private smoothingFactor = 0
  private prevLeftOutput = 0
  private prevRightOutput = 0

  /**
   * Updates the high-pass filter settings.
   * @param settings - Filter settings containing `highpass`.
   */
  public override update(settings: FilterSettings): void {
    const { smoothing = 0 } = settings.highpass || {}

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
      const newLeftLow =
        this.prevLeftOutput +
        this.smoothingFactor * (currentLeftSample - this.prevLeftOutput)
      this.prevLeftOutput = newLeftLow
      chunk.writeInt16LE(clamp16Bit(currentLeftSample - newLeftLow), i)

      const currentRightSample = chunk.readInt16LE(i + 2)
      const newRightLow =
        this.prevRightOutput +
        this.smoothingFactor * (currentRightSample - this.prevRightOutput)
      this.prevRightOutput = newRightLow
      chunk.writeInt16LE(clamp16Bit(currentRightSample - newRightLow), i + 2)
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
