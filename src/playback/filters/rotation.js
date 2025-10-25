import { clamp16Bit } from './dsp/clamp16Bit.js'
import LFO from './dsp/lfo.js'

export default class Rotation {
  constructor() {
    this.priority = 10
    this.lfo = new LFO('SINE')
  }

  update(filters) {
    const { rotationHz = 0 } = filters.rotation || {}
    this.lfo.update(rotationHz, 1)
  }

  process(chunk) {
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
}
