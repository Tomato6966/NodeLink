import { SAMPLE_RATE } from '../../constants.ts'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import DelayLine from './dsp/delay.js'

const COMB_DELAYS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_DELAYS = [556, 441, 341, 225]
const STEREO_SPREAD = 23
const SCALE_WET = 3.0
const SCALE_DRY = 2.0
const SCALE_DAMP = 0.4
const SCALE_ROOM = 0.28
const OFFSET_ROOM = 0.7

class CombFilter {
  constructor(size) {
    this.buffer = new DelayLine(size)
    this.filterStore = 0
    this.damp1 = 0
    this.damp2 = 0
    this.feedback = 0
  }

  setDamp(val) {
    this.damp1 = val
    this.damp2 = 1 - val
  }

  setFeedback(val) {
    this.feedback = val
  }

  process(input) {
    const output = this.buffer.read(0)
    this.filterStore = output * this.damp2 + this.filterStore * this.damp1
    this.buffer.write(clamp16Bit(input + this.filterStore * this.feedback))
    return output
  }

  clear() {
    this.buffer.clear()
    this.filterStore = 0
  }
}

export default class Reverb {
  constructor() {
    this.priority = 10

    this.combFiltersL = COMB_DELAYS.map(
      (delay) => new CombFilter(Math.floor((delay * SAMPLE_RATE) / 44100))
    )
    this.combFiltersR = COMB_DELAYS.map(
      (delay) =>
        new CombFilter(
          Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100)
        )
    )

    this.allpassFiltersL = ALLPASS_DELAYS.map(
      (delay) => new DelayLine(Math.floor((delay * SAMPLE_RATE) / 44100))
    )
    this.allpassFiltersR = ALLPASS_DELAYS.map(
      (delay) =>
        new DelayLine(
          Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100)
        )
    )

    this.allpassCoeff = 0.5

    this.allpassStateL = ALLPASS_DELAYS.map(() => ({ x1: 0, y1: 0 }))
    this.allpassStateR = ALLPASS_DELAYS.map(() => ({ x1: 0, y1: 0 }))

    this.wet = 0
    this.dry = 1.0
    this.roomSize = 0.5
    this.damping = 0.5
    this.width = 1.0
  }

  update(filters) {
    const settings = filters.reverb || {}

    const mix = Math.max(0, Math.min(settings.mix || 0, 1.0))
    this.wet = mix * SCALE_WET
    this.dry = (1.0 - mix) * SCALE_DRY

    this.roomSize = Math.max(0, Math.min(settings.roomSize || 0.5, 1.0))
    const roomScaled = this.roomSize * SCALE_ROOM + OFFSET_ROOM

    this.damping = Math.max(0, Math.min(settings.damping || 0.5, 1.0))
    const dampScaled = this.damping * SCALE_DAMP

    this.width = Math.max(0, Math.min(settings.width || 1.0, 1.0))

    for (const comb of [...this.combFiltersL, ...this.combFiltersR]) {
      comb.setFeedback(roomScaled)
      comb.setDamp(dampScaled)
    }
  }

  process(chunk) {
    if (this.wet === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const leftInput = chunk.readInt16LE(i)
      const rightInput = chunk.readInt16LE(i + 2)

      const monoInput = (leftInput + rightInput) * 0.5

      let leftOut = 0
      let rightOut = 0

      for (let j = 0; j < this.combFiltersL.length; j++) {
        leftOut += this.combFiltersL[j].process(monoInput)
        rightOut += this.combFiltersR[j].process(monoInput)
      }

      for (let j = 0; j < this.allpassFiltersL.length; j++) {
        leftOut = this.processAllpass(
          leftOut,
          this.allpassFiltersL[j],
          this.allpassStateL[j]
        )
        rightOut = this.processAllpass(
          rightOut,
          this.allpassFiltersR[j],
          this.allpassStateR[j]
        )
      }

      const wet1 = this.wet * (this.width * 0.5 + 0.5)
      const wet2 = this.wet * ((1.0 - this.width) * 0.5)

      const finalLeft = leftInput * this.dry + leftOut * wet1 + rightOut * wet2
      const finalRight =
        rightInput * this.dry + rightOut * wet1 + leftOut * wet2

      chunk.writeInt16LE(clamp16Bit(finalLeft), i)
      chunk.writeInt16LE(clamp16Bit(finalRight), i + 2)
    }

    return chunk
  }

  processAllpass(input, delayLine, state) {
    const delayed = delayLine.read(0)
    const output = -input + delayed + this.allpassCoeff * (input - state.y1)

    delayLine.write(clamp16Bit(input))
    state.y1 = output

    return output
  }

  clear() {
    for (const comb of [...this.combFiltersL, ...this.combFiltersR]) {
      comb.clear()
    }

    for (const allpass of [...this.allpassFiltersL, ...this.allpassFiltersR]) {
      allpass.clear()
    }

    for (const state of [...this.allpassStateL, ...this.allpassStateR]) {
      state.x1 = 0
      state.y1 = 0
    }
  }
}
