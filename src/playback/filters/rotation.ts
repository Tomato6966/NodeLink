import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import LFO from './dsp/lfo.ts'

/**
 * Rotates audio between left and right channels at a specific frequency.
 * @public
 */
export default class Rotation extends BaseFilter {
  public priority = 10
  private lfo: LFO

  constructor() {
    super()
    this.lfo = new LFO('SINE')
  }

  /**
   * Updates the rotation settings.
   * @param settings - Filter settings containing `rotation`.
   */
  public override update(settings: FilterSettings): void {
    const { rotationHz = 0 } = settings.rotation || {}
    this.lfo.update(rotationHz, 1)
  }

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public override process(chunk: Buffer): Buffer {
    if (this.lfo.frequency === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const lfoValue = this.lfo.getValue()

      const leftFactor = (1 - lfoValue) / 2
      const rightFactor = (1 + lfoValue) / 2

      const currentLeftSample = chunk.readInt16LE(i)
      const currentRightSample = chunk.readInt16LE(i + 2)

      const newLeftSample = currentLeftSample * leftFactor
      const newRightSample = currentRightSample * rightFactor

      chunk.writeInt16LE(clamp16Bit(newLeftSample), i)
      chunk.writeInt16LE(clamp16Bit(newRightSample), i + 2)
    }

    return chunk
  }

  /**
   * Flushes any pending data.
   * @returns An empty Buffer.
   */
  public override flush(): Buffer {
    this.lfo.phase = 0
    return Buffer.alloc(0)
  }
}
