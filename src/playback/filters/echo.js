import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'

const MAX_DELAY_S = 5
const bufferSize = Math.ceil(SAMPLE_RATE * MAX_DELAY_S)

export default class Echo {
  constructor() {
    this.priority = 10
    this.delay = 0
    this.feedback = 0
    this.mix = 0

    this.delayTimeSamples = 0
    this.leftDelay = new DelayLine(bufferSize)
    this.rightDelay = new DelayLine(bufferSize)
  }

  update(filters) {
    const settings = filters.echo || {}

    this.delay = Math.max(0, Math.min(settings.delay || 0, MAX_DELAY_S * 1000))
    this.feedback = Math.max(0, Math.min(settings.feedback || 0, 1.0))
    this.mix = Math.max(0, Math.min(settings.mix || 0, 1.0))

    this.delayTimeSamples = this.delay * (SAMPLE_RATE / 1000)
  }

  process(chunk) {
    if (this.delay === 0 || this.mix === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const delayedLeft = this.leftDelay.read(this.delayTimeSamples)
      const delayedRight = this.rightDelay.read(this.delayTimeSamples)

      this.leftDelay.write(clamp16Bit(leftSample + delayedLeft * this.feedback))
      this.rightDelay.write(
        clamp16Bit(rightSample + delayedRight * this.feedback)
      )

      const newLeft = leftSample * (1 - this.mix) + delayedLeft * this.mix
      const newRight = rightSample * (1 - this.mix) + delayedRight * this.mix

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }

  clear() {
    this.leftDelay.clear()
    this.rightDelay.clear()
  }
}
