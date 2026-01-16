import { SAMPLE_RATE } from '../../constants.js'
import Allpass from './dsp/allpass.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import LFO from './dsp/lfo.js'

const MAX_STAGES = 12

export default class Phaser {
  constructor() {
    this.priority = 10
    this.leftLfo = new LFO('SINE')
    this.rightLfo = new LFO('SINE')
    this.rightLfo.phase = Math.PI / 2

    this.stages = 4
    this.rate = 0
    this.depth = 1.0
    this.feedback = 0
    this.mix = 0.5

    this.minFrequency = 100
    this.maxFrequency = 2500

    this.leftFilters = Array.from({ length: MAX_STAGES }, () => new Allpass())
    this.rightFilters = Array.from({ length: MAX_STAGES }, () => new Allpass())

    this.lastLeftFeedback = 0
    this.lastRightFeedback = 0
  }

  update(filters) {
    const settings = filters.phaser || {}

    this.stages = Math.max(2, Math.min(settings.stages || 4, MAX_STAGES))
    this.rate = settings.rate || 0
    this.depth = Math.max(0, Math.min(settings.depth || 1.0, 1.0))
    this.feedback = Math.max(0, Math.min(settings.feedback || 0, 0.9))
    this.mix = Math.max(0, Math.min(settings.mix || 0.5, 1.0))

    this.minFrequency = settings.minFrequency || 100
    this.maxFrequency = settings.maxFrequency || 2500

    this.leftLfo.update(this.rate, this.depth)
    this.rightLfo.update(this.rate, this.depth)
  }

  process(chunk) {
    if (this.rate === 0 || this.depth === 0 || this.mix === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const leftLfoValue = (this.leftLfo.getValue() + 1) / 2
      const rightLfoValue = (this.rightLfo.getValue() + 1) / 2

      const sweepRange = this.maxFrequency - this.minFrequency
      const currentLeftFreq = this.minFrequency + sweepRange * leftLfoValue
      const currentRightFreq = this.minFrequency + sweepRange * rightLfoValue

      const tanLeft = Math.tan((Math.PI * currentLeftFreq) / SAMPLE_RATE)
      const a_left = (1 - tanLeft) / (1 + tanLeft)

      const tanRight = Math.tan((Math.PI * currentRightFreq) / SAMPLE_RATE)
      const a_right = (1 - tanRight) / (1 + tanRight)

      let wetLeft = leftSample + this.lastLeftFeedback * this.feedback
      for (let j = 0; j < this.stages; j++) {
        this.leftFilters[j].setCoefficient(a_left)
        wetLeft = this.leftFilters[j].process(wetLeft)
      }
      this.lastLeftFeedback = wetLeft
      const finalLeft = leftSample * (1 - this.mix) + wetLeft * this.mix

      let wetRight = rightSample + this.lastRightFeedback * this.feedback
      for (let j = 0; j < this.stages; j++) {
        this.rightFilters[j].setCoefficient(a_right)
        wetRight = this.rightFilters[j].process(wetRight)
      }
      this.lastRightFeedback = wetRight
      const finalRight = rightSample * (1 - this.mix) + wetRight * this.mix

      chunk.writeInt16LE(clamp16Bit(finalLeft), i)
      chunk.writeInt16LE(clamp16Bit(finalRight), i + 2)
    }

    return chunk
  }

  clear() {
    for (const filter of [...this.leftFilters, ...this.rightFilters]) {
      filter.x1 = 0
      filter.y1 = 0
    }
    this.lastLeftFeedback = 0
    this.lastRightFeedback = 0
    this.leftLfo.phase = 0
    this.rightLfo.phase = Math.PI / 2
  }
}
