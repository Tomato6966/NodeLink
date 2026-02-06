import { SAMPLE_RATE } from '../../constants.ts'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'
import LFO from './dsp/lfo.js'

const MAX_DELAY_MS = 15
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

export default class Flanger {
  constructor() {
    this.priority = 10

    this.delayLeft = new DelayLine(bufferSize)
    this.delayRight = new DelayLine(bufferSize)

    this.lfoLeft = new LFO('SINE')
    this.lfoRight = new LFO('SINE')
    this.lfoRight.phase = Math.PI / 4

    this.rate = 0
    this.depth = 0
    this.delay = 5
    this.feedback = 0
    this.mix = 0.5

    this.lastLeftOutput = 0
    this.lastRightOutput = 0
  }

  update(filters) {
    const settings = filters.flanger || {}

    this.rate = Math.max(0, Math.min(settings.rate || 0, 10))

    this.depth = Math.max(0, Math.min(settings.depth || 0, 1.0))

    this.delay = Math.max(1, Math.min(settings.delay || 5, MAX_DELAY_MS - 5))

    this.feedback = Math.max(-0.95, Math.min(settings.feedback || 0, 0.95))

    this.mix = Math.max(0, Math.min(settings.mix || 0.5, 1.0))

    this.lfoLeft.update(this.rate, this.depth)
    this.lfoRight.update(this.rate, this.depth)
  }

  process(chunk) {
    if (this.rate === 0 || this.depth === 0 || this.mix === 0) {
      return chunk
    }

    const baseDelaySamples = (this.delay * SAMPLE_RATE) / 1000
    const maxModulation = this.depth * (SAMPLE_RATE * 0.003)

    for (let i = 0; i < chunk.length; i += 4) {
      const leftInput = chunk.readInt16LE(i)
      const rightInput = chunk.readInt16LE(i + 2)

      const lfoValueLeft = this.lfoLeft.getValue()
      const lfoValueRight = this.lfoRight.getValue()

      const delayTimeLeft = baseDelaySamples + lfoValueLeft * maxModulation
      const delayTimeRight = baseDelaySamples + lfoValueRight * maxModulation

      const delayedLeft = this.delayLeft.read(delayTimeLeft)
      const delayedRight = this.delayRight.read(delayTimeRight)

      const wetLeft = delayedLeft + this.lastLeftOutput * this.feedback
      const wetRight = delayedRight + this.lastRightOutput * this.feedback

      const outputLeft = leftInput * (1.0 - this.mix) + wetLeft * this.mix
      const outputRight = rightInput * (1.0 - this.mix) + wetRight * this.mix

      this.lastLeftOutput = wetLeft
      this.lastRightOutput = wetRight

      this.delayLeft.write(clamp16Bit(leftInput + wetLeft * this.feedback))
      this.delayRight.write(clamp16Bit(rightInput + wetRight * this.feedback))

      chunk.writeInt16LE(clamp16Bit(outputLeft), i)
      chunk.writeInt16LE(clamp16Bit(outputRight), i + 2)
    }

    return chunk
  }

  clear() {
    this.delayLeft.clear()
    this.delayRight.clear()
    this.lastLeftOutput = 0
    this.lastRightOutput = 0
    this.lfoLeft.phase = 0
    this.lfoRight.phase = Math.PI / 4
  }
}
