import { clamp16Bit } from './dsp/clamp16Bit.js'
import LFO from './dsp/lfo.js'

export default class Tremolo {
  constructor() {
    this.priority = 10
    this.lfo = new LFO('SINE')
  }

  update(filters) {
    let { frequency = 0, depth = 0 } = filters.tremolo || {}

    depth = Math.max(0, Math.min(depth, 1.0))

    this.lfo.update(frequency, depth)
  }

  process(chunk) {
    if (this.lfo.depth === 0 || this.lfo.frequency === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i)
      const multiplier = this.lfo.process()

      const newSample = sample * multiplier

      chunk.writeInt16LE(clamp16Bit(newSample), i)
    }

    return chunk
  }
}
