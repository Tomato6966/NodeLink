import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

/**
 * Applies various distortion effects (sin, cos, tan, etc.).
 * @public
 */
export default class Distortion extends BaseFilter {
  public priority = 10
  private sinOffset = 0
  private sinScale = 1
  private cosOffset = 0
  private cosScale = 1
  private tanOffset = 0
  private tanScale = 1
  private offset = 0
  private scale = 1

  /**
   * Updates the distortion settings.
   * @param settings - Filter settings containing `distortion`.
   */
  public override update(settings: FilterSettings): void {
    const dist = settings.distortion || {}

    this.sinOffset = dist.sinOffset ?? 0
    this.sinScale = dist.sinScale ?? 1
    this.cosOffset = dist.cosOffset ?? 0
    this.cosScale = dist.cosScale ?? 1
    this.tanOffset = dist.tanOffset ?? 0
    this.tanScale = dist.tanScale ?? 1
    this.offset = dist.offset ?? 0
    this.scale = dist.scale ?? 1
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    if (
      this.sinOffset === 0 &&
      this.sinScale === 1 &&
      this.cosOffset === 0 &&
      this.cosScale === 1 &&
      this.tanOffset === 0 &&
      this.tanScale === 1 &&
      this.offset === 0 &&
      this.scale === 1
    ) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768

      let processed =
        Math.sin(sample * this.sinScale + this.sinOffset) +
        Math.cos(sample * this.cosScale + this.cosOffset) +
        Math.tan(sample * this.tanScale + this.tanOffset) +
        (sample * this.scale + this.offset)

      processed = Math.max(-1, Math.min(1, processed))

      chunk.writeInt16LE(clamp16Bit(processed * 32768), i)
    }

    return chunk
  }

  /**
   * Flushes any pending data.
   * @returns An empty Buffer.
   */
  public override flush(): Buffer {
    return Buffer.alloc(0)
  }
}
