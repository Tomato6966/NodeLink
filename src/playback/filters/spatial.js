import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'
import LFO from './dsp/lfo.js'

const MAX_DELAY_MS = 30
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

export default class Spatial {
  constructor() {
    this.priority = 10
    this.leftDelay = new DelayLine(bufferSize)
    this.rightDelay = new DelayLine(bufferSize)
    this.lfo = new LFO('SINE')

    this.depth = 0
    this.rate = 0
  }

  update(filters) {
    const settings = filters.spatial || {}
    this.depth = Math.max(0, Math.min(settings.depth || 0, 1.0))
    this.rate = settings.rate || 0

    this.lfo.update(this.rate, 1.0)
  }

  process(chunk) {
    if (this.depth === 0) {
      return chunk
    }

    const wet = this.depth * 0.5
    const dry = 1.0 - wet
    const feedback = -0.3

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const lfoValue = this.lfo.getValue()

      const delayTimeL = (5 + lfoValue * 2) * (SAMPLE_RATE / 1000)
      const delayTimeR = (5 - lfoValue * 2) * (SAMPLE_RATE / 1000)

      const delayedLeft = this.leftDelay.read(delayTimeL)
      const delayedRight = this.rightDelay.read(delayTimeR)

      this.leftDelay.write(clamp16Bit(leftSample + delayedLeft * feedback))
      this.rightDelay.write(clamp16Bit(rightSample + delayedRight * feedback))

      const newLeft = leftSample * dry + delayedRight * wet
      const newRight = rightSample * dry + delayedLeft * wet

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }
}
