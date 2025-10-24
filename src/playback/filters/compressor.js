import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'

function dbToLinear(db) {
  return 10 ** (db / 20)
}

function linearToDb(linear) {
  if (linear === 0) return -144
  return 20 * Math.log10(linear)
}

export default class Compressor {
  constructor() {
    this.priority = 10
    this.threshold = 0
    this.ratio = 1
    this.attack = 0
    this.release = 0
    this.gain = 0

    this.attackCoeff = 0
    this.releaseCoeff = 0
    this.makeupGainLinear = 1.0

    this.envelope = 0
  }

  update(filters) {
    const settings = filters.compressor || {}

    this.threshold = settings.threshold || 0
    this.ratio = settings.ratio || 1
    this.attack = settings.attack || 0
    this.release = settings.release || 0
    this.gain = settings.gain || 0

    this.attackCoeff =
      this.attack > 0
        ? Math.exp(-1.0 / ((this.attack / 1000) * SAMPLE_RATE))
        : 0
    this.releaseCoeff =
      this.release > 0
        ? Math.exp(-1.0 / ((this.release / 1000) * SAMPLE_RATE))
        : 0
    this.makeupGainLinear = dbToLinear(this.gain)
  }

  process(chunk) {
    if (this.threshold === 0 && this.ratio === 1 && this.gain === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const leftSample = chunk.readInt16LE(i)
      const rightSample = chunk.readInt16LE(i + 2)

      const peak = Math.max(Math.abs(leftSample), Math.abs(rightSample))

      if (peak > this.envelope) {
        this.envelope =
          this.attackCoeff * this.envelope + (1 - this.attackCoeff) * peak
      } else {
        this.envelope =
          this.releaseCoeff * this.envelope + (1 - this.releaseCoeff) * peak
      }

      const envelopeDb = linearToDb(this.envelope / 32767.0)
      let gainReductionDb = 0

      if (this.ratio > 1 && envelopeDb > this.threshold) {
        gainReductionDb =
          (this.threshold - envelopeDb) * (1.0 - 1.0 / this.ratio)
      }

      const targetGainLinear =
        dbToLinear(gainReductionDb) * this.makeupGainLinear

      const newLeft = leftSample * targetGainLinear
      const newRight = rightSample * targetGainLinear

      chunk.writeInt16LE(clamp16Bit(newLeft), i)
      chunk.writeInt16LE(clamp16Bit(newRight), i + 2)
    }

    return chunk
  }
}
