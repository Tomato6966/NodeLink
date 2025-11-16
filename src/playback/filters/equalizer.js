import { SAMPLE_RATE } from '../../constants.js'

const BAND_FREQUENCIES = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000,
  16000
]

const BAND_Q_FACTORS = [
  4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32, 4.32,
  4.32, 4.32
]

const BAND_COUNT = 15
const DEFAULT_MAKEUP_GAIN = 4.0

export default class Equalizer {
  constructor() {
    this.priority = 10
    this.filtersState = []
    this.filtersCoefficients = []
    this.bandGains = new Float32Array(BAND_COUNT)
    this.isEnabled = false

    this.makeupGain = DEFAULT_MAKEUP_GAIN

    this.initFilters()
    this.calculateAllBandCoefficients()
  }

  initFilters() {
    this.filtersState = []
    for (let i = 0; i < BAND_COUNT; i++) {
      this.filtersState.push({
        l_x1: 0,
        l_x2: 0,
        l_y1: 0,
        l_y2: 0,
        r_x1: 0,
        r_x2: 0,
        r_y1: 0,
        r_y2: 0
      })
    }
  }

  calculateBandpassCoefficients(bandIndex) {
    const freq = BAND_FREQUENCIES[bandIndex]
    const Q = BAND_Q_FACTORS[bandIndex]
    const omega0 = (2 * Math.PI * freq) / SAMPLE_RATE
    const sin_omega0 = Math.sin(omega0)
    const cos_omega0 = Math.cos(omega0)
    const alpha = sin_omega0 / (2 * Q)
    const b0 = alpha,
      b1 = 0,
      b2 = -alpha
    const a0 = 1 + alpha,
      a1 = -2 * cos_omega0,
      a2 = 1 - alpha
    this.filtersCoefficients[bandIndex] = {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0
    }
  }

  calculateAllBandCoefficients() {
    this.filtersCoefficients = []
    for (let i = 0; i < BAND_COUNT; i++) {
      this.calculateBandpassCoefficients(i)
    }
  }

  update(filters) {
    const equalizerBands = Array.isArray(filters.equalizer)
      ? filters.equalizer
      : []

    if (equalizerBands.length === 0) {
      if (this.isEnabled) {
        this.bandGains.fill(0)
      }
      this.isEnabled = false
      this.makeupGain = DEFAULT_MAKEUP_GAIN
      return
    }

    this.isEnabled = true
    const updatedBands = new Set(equalizerBands.map((b) => b.band))

    for (let i = 0; i < BAND_COUNT; i++) {
      if (!updatedBands.has(i)) this.bandGains[i] = 0
    }

    for (const bandSetting of equalizerBands) {
      const { band, gain = 0 } = bandSetting
      if (band >= 0 && band < BAND_COUNT) {
        this.bandGains[band] = Math.max(Math.min(gain, 1.0), -0.25)
      }
    }

    let positiveGainSum = 0
    for (let i = 0; i < BAND_COUNT; i++) {
      if (this.bandGains[i] > 0) {
        positiveGainSum += this.bandGains[i]
      }
    }

    if (positiveGainSum > 1.0) {
      this.makeupGain =
        DEFAULT_MAKEUP_GAIN / (1.0 + (positiveGainSum - 1.0) * 0.5)
    } else {
      this.makeupGain = DEFAULT_MAKEUP_GAIN
    }
  }

  process(chunk) {
    if (!this.isEnabled) {
      return chunk
    }

    const samples = chunk.length / 4

    for (let i = 0; i < samples; i++) {
      const offset = i * 4

      const leftFloat = chunk.readInt16LE(offset) / 32768.0
      const rightFloat = chunk.readInt16LE(offset + 2) / 32768.0

      let resultLeft = leftFloat * 0.25
      let resultRight = rightFloat * 0.25

      for (let b = 0; b < BAND_COUNT; b++) {
        const coeffs = this.filtersCoefficients[b]
        const state = this.filtersState[b]
        const gain = this.bandGains[b]

        let bandResultLeft =
          coeffs.b0 * leftFloat +
          coeffs.b1 * state.l_x1 +
          coeffs.b2 * state.l_x2 -
          coeffs.a1 * state.l_y1 -
          coeffs.a2 * state.l_y2
        if (!Number.isFinite(bandResultLeft)) {
          bandResultLeft = 0
          state.l_x1 = 0
          state.l_x2 = 0
          state.l_y1 = 0
          state.l_y2 = 0
        } else {
          state.l_x2 = state.l_x1
          state.l_x1 = leftFloat
          state.l_y2 = state.l_y1
          state.l_y1 = bandResultLeft
        }

        let bandResultRight =
          coeffs.b0 * rightFloat +
          coeffs.b1 * state.r_x1 +
          coeffs.b2 * state.r_x2 -
          coeffs.a1 * state.r_y1 -
          coeffs.a2 * state.r_y2
        if (!Number.isFinite(bandResultRight)) {
          bandResultRight = 0
          state.r_x1 = 0
          state.r_x2 = 0
          state.r_y1 = 0
          state.r_y2 = 0
        } else {
          state.r_x2 = state.r_x1
          state.r_x1 = rightFloat
          state.r_y2 = state.r_y1
          state.r_y1 = bandResultRight
        }

        resultLeft += bandResultLeft * gain
        resultRight += bandResultRight * gain
      }

      const outputLeft = resultLeft * this.makeupGain
      const outputRight = resultRight * this.makeupGain

      const finalLeft = Math.tanh(outputLeft)
      const finalRight = Math.tanh(outputRight)

      chunk.writeInt16LE(Math.round(finalLeft * 32767), offset)
      chunk.writeInt16LE(Math.round(finalRight * 32767), offset + 2)
    }

    return chunk
  }
}
