import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'
import LFO from './dsp/lfo.js'

const MAX_DELAY_MS = 20
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

export default class Vibrato {
  constructor() {
    this.priority = 10
    this.lfo = new LFO('SINE')
    this.leftDelay = new DelayLine(bufferSize)
    this.rightDelay = new DelayLine(bufferSize)
  }

  update(filters) {
    const vibratoSettings = filters.vibrato || {}
    const frequency = vibratoSettings.frequency || 0
    let depth = vibratoSettings.depth ?? 0

    depth = Math.max(0, Math.min(depth, 2.0))

    this.lfo.update(frequency, depth)
  }

  process(chunk) {
    if (this.lfo.depth === 0 || this.lfo.frequency === 0) {
      this.leftDelay.clear()
      this.rightDelay.clear()
      return chunk
    }

    const maxDelayWidth = this.lfo.depth * (SAMPLE_RATE * 0.005)
    const centerDelay = maxDelayWidth

    for (let i = 0; i < chunk.length; i += 4) {
      const lfoValue = this.lfo.getValue()

      const delay = centerDelay + lfoValue * maxDelayWidth

      const leftSample = chunk.readInt16LE(i)
      this.leftDelay.write(leftSample)

      const delayedLeft = this.leftDelay.read(delay)
      chunk.writeInt16LE(clamp16Bit(delayedLeft), i)

      const rightSample = chunk.readInt16LE(i + 2)
      this.rightDelay.write(rightSample)
      const delayedRight = this.rightDelay.read(delay)
      chunk.writeInt16LE(clamp16Bit(delayedRight), i + 2)
    }

    return chunk
  }
}
