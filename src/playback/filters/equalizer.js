import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'

const BAND_FREQUENCIES = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000,
  16000
]

const BAND_Q_FACTORS = [
  1.2, 1.2, 1.1, 1.0, 0.9, 0.9, 0.8, 0.8, 0.9, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4
]

const MAX_GAIN_DB = 12.0
const MIN_GAIN_DB = -12.0

export default class Equalizer {
  constructor() {
    this.priority = 10
    this.filtersState = []
    this.filtersCoefficients = []
    this.isEnabled = false
  }

  initFilters() {
    this.filtersState = []
    this.filtersCoefficients = []
    for (let i = 0; i < BAND_FREQUENCIES.length; i++) {
      this.filtersState.push({
        xl1: 0,
        xl2: 0,
        yl1: 0,
        yl2: 0,
        xr1: 0,
        xr2: 0,
        yr1: 0,
        yr2: 0
      })
      this.filtersCoefficients.push({
        b0: 1,
        b1: 0,
        b2: 0,
        a1: 0,
        a2: 0
      })
    }
  }

  updateBandCoefficients(bandIndex, gain) {
    const freq = BAND_FREQUENCIES[bandIndex]
    if (!freq) return

    const gainDb = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gain * 15.0))

    if (Math.abs(gainDb) < 0.01) {
      this.filtersCoefficients[bandIndex] = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
      return
    }

    const A = 10 ** (gainDb / 40)
    const omega0 = (2 * Math.PI * freq) / SAMPLE_RATE
    const sin_omega0 = Math.sin(omega0)
    const cos_omega0 = Math.cos(omega0)
    
    const Q = BAND_Q_FACTORS[bandIndex]
    const alpha = sin_omega0 / (2 * Q)

    const b0 = 1 + alpha * A
    const b1 = -2 * cos_omega0
    const b2 = 1 - alpha * A
    let a0 = 1 + alpha / A
    const a1 = -2 * cos_omega0
    const a2 = 1 - alpha / A

    if (Math.abs(a0) < 1e-10) {
      a0 = 1e-10
    }

    this.filtersCoefficients[bandIndex] = {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0
    }
  }

  update(filters) {
    if (!this.filtersState.length || !this.filtersCoefficients.length) {
      this.initFilters()
    }

    const equalizerBands = Array.isArray(filters.equalizer)
      ? filters.equalizer
      : []

    if (equalizerBands.length === 0) {
      this.isEnabled = false
      return
    }

    this.isEnabled = true

    for (let i = 0; i < BAND_FREQUENCIES.length; i++) {
      this.filtersCoefficients[i] = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
      this.filtersState[i] = {
        xl1: 0,
        xl2: 0,
        yl1: 0,
        yl2: 0,
        xr1: 0,
        xr2: 0,
        yr1: 0,
        yr2: 0
      }
    }

    for (const bandSetting of equalizerBands) {
      const { band, gain = 0 } = bandSetting
      if (band >= 0 && band < BAND_FREQUENCIES.length) {
        this.updateBandCoefficients(band, gain)
      }
    }
  }

  process(chunk) {
    if (!this.isEnabled || !this.filtersState.length) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      let currentLeftSample = chunk.readInt16LE(i)
      let currentRightSample = chunk.readInt16LE(i + 2)

      for (let b = 0; b < BAND_FREQUENCIES.length; b++) {
        const coeffs = this.filtersCoefficients[b]
        const state = this.filtersState[b]

        const newLeftSample =
          coeffs.b0 * currentLeftSample +
          coeffs.b1 * state.xl1 +
          coeffs.b2 * state.xl2 -
          coeffs.a1 * state.yl1 -
          coeffs.a2 * state.yl2
        
        if (!Number.isFinite(newLeftSample)) {
          state.xl1 = state.xl2 = state.yl1 = state.yl2 = 0
          continue
        }
        
        state.xl2 = state.xl1
        state.xl1 = currentLeftSample
        state.yl2 = state.yl1
        state.yl1 = newLeftSample
        currentLeftSample = newLeftSample

        const newRightSample =
          coeffs.b0 * currentRightSample +
          coeffs.b1 * state.xr1 +
          coeffs.b2 * state.xr2 -
          coeffs.a1 * state.yr1 -
          coeffs.a2 * state.yr2
        
        if (!Number.isFinite(newRightSample)) {
          state.xr1 = state.xr2 = state.yr1 = state.yr2 = 0
          continue
        }
        
        state.xr2 = state.xr1
        state.xr1 = currentRightSample
        state.yr2 = state.yr1
        state.yr1 = newRightSample
        currentRightSample = newRightSample
      }

      chunk.writeInt16LE(clamp16Bit(currentLeftSample), i)
      chunk.writeInt16LE(clamp16Bit(currentRightSample), i + 2)
    }

    return chunk
  }
}
