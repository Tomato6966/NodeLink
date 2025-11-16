import { SAMPLE_RATE } from '../../constants.js'
import { clamp16Bit } from './dsp/clamp16Bit.js'

const MAX_OUTPUT_GAIN = 0.98

export default class Karaoke {
  constructor() {
    this.priority = 10
    this.level = 0
    this.monoLevel = 0
    this.filterBand = 0
    this.filterWidth = 0

    this.lp_b0 = this.lp_b1 = this.lp_b2 = this.lp_a1 = this.lp_a2 = 0
    this.hp_b0 = this.hp_b1 = this.hp_b2 = this.hp_a1 = this.hp_a2 = 0

    this.lp_left_x1 = this.lp_left_x2 = this.lp_left_y1 = this.lp_left_y2 = 0
    this.lp_right_x1 =
      this.lp_right_x2 =
      this.lp_right_y1 =
      this.lp_right_y2 =
        0
    this.hp_left_x1 = this.hp_left_x2 = this.hp_left_y1 = this.hp_left_y2 = 0
    this.hp_right_x1 =
      this.hp_right_x2 =
      this.hp_right_y1 =
      this.hp_right_y2 =
        0

    this._prevGain = MAX_OUTPUT_GAIN
    this._inv32768 = 1 / 32768
  }

  updateCoefficients() {
    if (this.filterBand === 0 || this.filterWidth === 0) {
      this.lp_b0 = this.hp_b0 = 1
      this.lp_b1 = this.lp_b2 = this.lp_a1 = this.lp_a2 = 0
      this.hp_b1 = this.hp_b2 = this.hp_a1 = this.hp_a2 = 0
      return
    }
    const fc = Math.max(1, Math.min(SAMPLE_RATE * 0.49, this.filterBand))
    const width = Math.max(1e-6, this.filterWidth)
    const Q = Math.max(0.0001, fc / width)

    const preWarp = Math.tan(Math.PI * (fc / SAMPLE_RATE))
    const omegaRatio = preWarp / (1 + preWarp * preWarp)
    const sinTerm = Math.min(1, Math.max(-1, omegaRatio * 2))
    const alpha = Math.abs(Math.sin(sinTerm)) / Math.max(1e-12, 2 * Q)
    const cosOmega0 = Math.cos(2 * Math.PI * (fc / SAMPLE_RATE))

    this.lp_b0 = (1 - cosOmega0) / 2
    this.lp_b1 = 1 - cosOmega0
    this.lp_b2 = (1 - cosOmega0) / 2
    let lpA0 = 1 + alpha
    if (Math.abs(lpA0) < 1e-12) lpA0 = 1e-12
    this.lp_a1 = (-2 * cosOmega0) / lpA0
    this.lp_a2 = (1 - alpha) / lpA0
    this.lp_b0 /= lpA0
    this.lp_b1 /= lpA0
    this.lp_b2 /= lpA0

    this.hp_b0 = (1 + cosOmega0) / 2
    this.hp_b1 = -(1 + cosOmega0)
    this.hp_b2 = (1 + cosOmega0) / 2
    let hpA0 = 1 + alpha
    if (Math.abs(hpA0) < 1e-12) hpA0 = 1e-12
    this.hp_a1 = (-2 * cosOmega0) / hpA0
    this.hp_a2 = (1 - alpha) / hpA0
    this.hp_b0 /= hpA0
    this.hp_b1 /= hpA0
    this.hp_b2 /= hpA0
  }

  update(filters) {
    const {
      level = 0,
      monoLevel = 0,
      filterBand = 0,
      filterWidth = 0
    } = filters.karaoke || {}
    this.level = Math.max(0, Math.min(1, level))
    this.monoLevel = Math.max(0, Math.min(1, monoLevel))
    this.filterBand = filterBand
    this.filterWidth = filterWidth
    this.updateCoefficients()
    this.lp_left_x1 = this.lp_left_x2 = this.lp_left_y1 = this.lp_left_y2 = 0
    this.lp_right_x1 =
      this.lp_right_x2 =
      this.lp_right_y1 =
      this.lp_right_y2 =
        0
    this.hp_left_x1 = this.hp_left_x2 = this.hp_left_y1 = this.hp_left_y2 = 0
    this.hp_right_x1 =
      this.hp_right_x2 =
      this.hp_right_y1 =
      this.hp_right_y2 =
        0
  }

  process(chunk) {
    if (this.level === 0 && this.monoLevel === 0) return chunk

    const frames = chunk.length >> 2
    if (frames === 0) return chunk

    const inv32768 = this._inv32768
    const lp_b0 = this.lp_b0,
      lp_b1 = this.lp_b1,
      lp_b2 = this.lp_b2,
      lp_a1 = this.lp_a1,
      lp_a2 = this.lp_a2
    const hp_b0 = this.hp_b0,
      hp_b1 = this.hp_b1,
      hp_b2 = this.hp_b2,
      hp_a1 = this.hp_a1,
      hp_a2 = this.hp_a2
    let lpLx1 = this.lp_left_x1,
      lpLx2 = this.lp_left_x2,
      lpLy1 = this.lp_left_y1,
      lpLy2 = this.lp_left_y2
    let lpRx1 = this.lp_right_x1,
      lpRx2 = this.lp_right_x2,
      lpRy1 = this.lp_right_y1,
      lpRy2 = this.lp_right_y2
    let hpLx1 = this.hp_left_x1,
      hpLx2 = this.hp_left_x2,
      hpLy1 = this.hp_left_y1,
      hpLy2 = this.hp_left_y2
    let hpRx1 = this.hp_right_x1,
      hpRx2 = this.hp_right_x2,
      hpRy1 = this.hp_right_y1,
      hpRy2 = this.hp_right_y2

    let originalEnergy = 0
    for (let i = 0; i < chunk.length; i += 4) {
      const l = chunk.readInt16LE(i) * inv32768
      const r = chunk.readInt16LE(i + 2) * inv32768
      originalEnergy += l * l + r * r
    }
    const denom = frames * 2 || 1
    originalEnergy /= denom

    const processedLeft = new Float32Array(frames)
    const processedRight = new Float32Array(frames)

    const doFilter =
      this.level > 0 && this.filterBand !== 0 && this.filterWidth !== 0
    const monoLevel = this.monoLevel
    const level = this.level

    let fi = 0
    for (let i = 0; i < chunk.length; i += 4) {
      let left = chunk.readInt16LE(i) * inv32768
      let right = chunk.readInt16LE(i + 2) * inv32768

      if (monoLevel > 0) {
        const mid = (left + right) * 0.5
        left = left - mid * monoLevel
        right = right - mid * monoLevel
      }

      if (doFilter) {
        const lowLeft =
          lp_b0 * left +
          lp_b1 * lpLx1 +
          lp_b2 * lpLx2 -
          lp_a1 * lpLy1 -
          lp_a2 * lpLy2
        lpLx2 = lpLx1
        lpLx1 = left
        lpLy2 = lpLy1
        lpLy1 = lowLeft
        const lowRight =
          lp_b0 * right +
          lp_b1 * lpRx1 +
          lp_b2 * lpRx2 -
          lp_a1 * lpRy1 -
          lp_a2 * lpRy2
        lpRx2 = lpRx1
        lpRx1 = right
        lpRy2 = lpRy1
        lpRy1 = lowRight
        const highLeft =
          hp_b0 * left +
          hp_b1 * hpLx1 +
          hp_b2 * hpLx2 -
          hp_a1 * hpLy1 -
          hp_a2 * hpLy2
        hpLx2 = hpLx1
        hpLx1 = left
        hpLy2 = hpLy1
        hpLy1 = highLeft
        const highRight =
          hp_b0 * right +
          hp_b1 * hpRx1 +
          hp_b2 * hpRx2 -
          hp_a1 * hpRy1 -
          hp_a2 * hpRy2
        hpRx2 = hpRx1
        hpRx1 = right
        hpRy2 = hpRy1
        hpRy1 = highRight

        const cancelled = highLeft - highRight
        left = lowLeft + cancelled * level
        right = lowRight + cancelled * level
      }

      processedLeft[fi] = left
      processedRight[fi] = right
      fi++
    }

    let processedEnergy = 0
    for (let i = 0; i < frames; i++) {
      const l = processedLeft[i]
      const r = processedRight[i]
      processedEnergy += l * l + r * r
    }
    processedEnergy /= denom

    let gain = 1
    if (processedEnergy > 1e-15)
      gain = Math.sqrt(Math.max(1e-12, originalEnergy) / processedEnergy)
    gain = Math.min(gain, MAX_OUTPUT_GAIN)

    const prev = this._prevGain || MAX_OUTPUT_GAIN
    const attackFactor = gain > prev ? 0.06 : 0.3
    const smoothedTarget = prev + (gain - prev) * attackFactor
    let current = prev
    const step = (smoothedTarget - current) / Math.max(1, frames)

    let wi = 0
    for (let i = 0; i < chunk.length; i += 4) {
      current += step
      let outL = processedLeft[wi] * current
      let outR = processedRight[wi] * current

      const peak = Math.max(Math.abs(outL), Math.abs(outR))
      if (peak > 0.9999) {
        const limiterScale = 0.9999 / peak
        outL *= limiterScale
        outR *= limiterScale
      }

      chunk.writeInt16LE(clamp16Bit(outL * 32768), i)
      chunk.writeInt16LE(clamp16Bit(outR * 32768), i + 2)
      wi++
    }

    this.lp_left_x1 = lpLx1
    this.lp_left_x2 = lpLx2
    this.lp_left_y1 = lpLy1
    this.lp_left_y2 = lpLy2
    this.lp_right_x1 = lpRx1
    this.lp_right_x2 = lpRx2
    this.lp_right_y1 = lpRy1
    this.lp_right_y2 = lpRy2
    this.hp_left_x1 = hpLx1
    this.hp_left_x2 = hpLx2
    this.hp_left_y1 = hpLy1
    this.hp_left_y2 = hpLy2
    this.hp_right_x1 = hpRx1
    this.hp_right_x2 = hpRx2
    this.hp_right_y1 = hpRy1
    this.hp_right_y2 = hpRy2

    this._prevGain = smoothedTarget
    return chunk
  }
}
