import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'
import LFO from './dsp/lfo.js'

const MAX_DELAY_MS = 50
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

export default class Chorus {
  constructor() {
    this.priority = 10
    this.lfos = [
      new LFO('SINE'),
      new LFO('SINE'),
      new LFO('SINE'),
      new LFO('SINE')
    ]
    this.lfos[0].phase = 0
    this.lfos[1].phase = Math.PI / 2
    this.lfos[2].phase = Math.PI
    this.lfos[3].phase = (3 * Math.PI) / 2

    this.delays = [
      new DelayLine(bufferSize),
      new DelayLine(bufferSize),
      new DelayLine(bufferSize),
      new DelayLine(bufferSize)
    ]

    this.rate = 0
    this.depth = 0
    this.delay = 25
    this.mix = 0.5
    this.feedback = 0
  }

  update(filters) {
    const chorusSettings = filters.chorus || {}

    this.rate = chorusSettings.rate || 0
    this.depth = Math.max(0, Math.min(chorusSettings.depth || 0, 1.0))
    this.delay = Math.max(
      1,
      Math.min(chorusSettings.delay || 25, MAX_DELAY_MS - 5)
    )
    this.mix = Math.max(0, Math.min(chorusSettings.mix || 0.5, 1.0))
    this.feedback = Math.max(0, Math.min(chorusSettings.feedback || 0, 0.95))

    const rate2 = this.rate * 1.1

    this.lfos[0].update(this.rate, this.depth)
    this.lfos[1].update(this.rate, this.depth)
    this.lfos[2].update(rate2, this.depth)
    this.lfos[3].update(rate2, this.depth)
  }

  process(chunk) {
    if (this.rate === 0 || this.depth === 0 || this.mix === 0) {
      return chunk
    }

    const delayWidth = this.depth * (SAMPLE_RATE * 0.004)
    const centerDelaySamples = this.delay * (SAMPLE_RATE / 1000)
    const centerDelaySamples2 = centerDelaySamples * 1.2

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const lfo1L = this.lfos[0].getValue()
      const lfo1R = this.lfos[1].getValue()
      const delay1L = centerDelaySamples + lfo1L * delayWidth
      const delay1R = centerDelaySamples + lfo1R * delayWidth
      const delayed1L = this.delays[0].read(delay1L)
      const delayed1R = this.delays[1].read(delay1R)

      const lfo2L = this.lfos[2].getValue()
      const lfo2R = this.lfos[3].getValue()
      const delay2L = centerDelaySamples2 + lfo2L * delayWidth
      const delay2R = centerDelaySamples2 + lfo2R * delayWidth
      const delayed2L = this.delays[2].read(delay2L)
      const delayed2R = this.delays[3].read(delay2R)

      const wetLeft = (delayed1L + delayed2L) * 0.5
      const wetRight = (delayed1R + delayed2R) * 0.5

      const finalList = leftSample * (1 - this.mix) + wetLeft * this.mix
      const finalRight = rightSample * (1 - this.mix) + wetRight * this.mix

      this.delays[0].write(clamp16Bit(leftSample + delayed1L * this.feedback))
      this.delays[1].write(clamp16Bit(rightSample + delayed1R * this.feedback))
      this.delays[2].write(clamp16Bit(leftSample + delayed2L * this.feedback))
      this.delays[3].write(clamp16Bit(rightSample + delayed2R * this.feedback))

      chunk.writeInt16LE(clamp16Bit(finalList), i)
      chunk.writeInt16LE(clamp16Bit(finalRight), i + 2)
    }

    return chunk
  }

  clear() {
    for (const delay of this.delays) {
      delay.clear()
    }
    this.lfos[0].phase = 0
    this.lfos[1].phase = Math.PI / 2
    this.lfos[2].phase = Math.PI
    this.lfos[3].phase = (3 * Math.PI) / 2
  }
}
