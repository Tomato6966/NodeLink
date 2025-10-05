import { clamp16Bit } from './dsp/clamp16Bit.js'
import { SAMPLE_RATE } from '../../constants.js'

export default class Karaoke {
  constructor() {
    this.level = 0
    this.monoLevel = 0
    this.filterBand = 0
    this.filterWidth = 0

    this.xl1 = 0
    this.xl2 = 0
    this.yl1 = 0
    this.yl2 = 0
    this.xr1 = 0
    this.xr2 = 0
    this.yr1 = 0
    this.yr2 = 0

    this.b0 = 0
    this.b1 = 0
    this.b2 = 0
    this.a0 = 1
    this.a1 = 0
    this.a2 = 0
  }

  updateCoefficients() {
    if (this.filterBand === 0 || this.filterWidth === 0) {
      this.b0 = 1
      this.b1 = 0
      this.b2 = 0
      this.a1 = 0
      this.a2 = 0
      return
    }

    const omega0 = (2 * Math.PI * this.filterBand) / SAMPLE_RATE
    const Q = this.filterBand / (this.filterWidth * (1 - this.level + 0.001))
    const alpha = Math.sin(omega0) / (2 * Q)
    const cos_omega0 = Math.cos(omega0)

    this.b0 = 1
    this.b1 = -2 * cos_omega0
    this.b2 = 1
    this.a0 = 1 + alpha
    if (Math.abs(this.a0) < 1e-9) this.a0 = 1e-9

    this.a1 = -2 * cos_omega0
    this.a2 = 1 - alpha

    this.b0 /= this.a0
    this.b1 /= this.a0
    this.b2 /= this.a0
    this.a1 /= this.a0
    this.a2 /= this.a0
    this.a0 = 1
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

    this.xl1 = 0
    this.xl2 = 0
    this.yl1 = 0
    this.yl2 = 0
    this.xr1 = 0
    this.xr2 = 0
    this.yr1 = 0
    this.yr2 = 0
  }

  process(chunk) {
    if (this.level === 0 && this.monoLevel === 0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      let currentLeftSample = chunk.readInt16LE(i)
      let currentRightSample = chunk.readInt16LE(i + 2)

      if (this.monoLevel > 0) {
        const mono = (currentLeftSample + currentRightSample) / 2
        currentLeftSample = currentLeftSample - mono * this.monoLevel
        currentRightSample = currentRightSample - mono * this.monoLevel
      }

      if (this.level > 0 && this.filterBand !== 0 && this.filterWidth !== 0) {
        const newLeftSample =
          this.b0 * currentLeftSample +
          this.b1 * this.xl1 +
          this.b2 * this.xl2 -
          this.a1 * this.yl1 -
          this.a2 * this.yl2
        this.xl2 = this.xl1
        this.xl1 = currentLeftSample
        this.yl2 = this.yl1
        this.yl1 = newLeftSample
        currentLeftSample = newLeftSample

        const newRightSample =
          this.b0 * currentRightSample +
          this.b1 * this.xr1 +
          this.b2 * this.xr2 -
          this.a1 * this.yr1 -
          this.a2 * this.yr2
        this.xr2 = this.xr1
        this.xr1 = currentRightSample
        this.yr2 = this.yr1
        this.yr1 = newRightSample
        currentRightSample = newRightSample
      }

      chunk.writeInt16LE(clamp16Bit(currentLeftSample), i)
      chunk.writeInt16LE(clamp16Bit(currentRightSample), i + 2)
    }

    return chunk
  }
}
