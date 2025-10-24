import { clamp16Bit } from './dsp/clamp16Bit.js'

// 4-point, 3rd-order Hermite interpolation (Catmull-Rom)
function cubicInterpolate(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t

  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

export default class Timescale {
  constructor() {
    this.priority = 1
    this.speed = 1.0
    this.pitch = 1.0
    this.rate = 1.0

    this.finalRate = 1.0
    this.inputBuffer = Buffer.alloc(0)
  }

  update(filters) {
    const settings = filters.timescale || {}

    this.speed = settings.speed ?? 1.0
    this.pitch = settings.pitch ?? 1.0
    this.rate = settings.rate ?? 1.0

    this.finalRate = this.speed * this.pitch * this.rate
  }

  process(chunk) {
    if (this.finalRate === 1.0) {
      return chunk
    }

    if (this.finalRate === 0) {
      return Buffer.alloc(0)
    }

    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk])

    if (this.inputBuffer.length < 16) {
      return Buffer.alloc(0)
    }

    const outputLength = Math.floor(this.inputBuffer.length / this.finalRate)
    const finalOutputLength = outputLength - (outputLength % 4)
    const outputBuffer = Buffer.alloc(finalOutputLength)

    let outputPos = 0
    while (outputPos < finalOutputLength) {
      const inputFrame = (outputPos / 4) * this.finalRate
      const i1 = Math.floor(inputFrame)
      const frac = inputFrame - i1

      const p0_idx = i1 - 1
      const p1_idx = i1
      const p2_idx = i1 + 1
      const p3_idx = i1 + 2

      if ((p3_idx + 1) * 4 > this.inputBuffer.length) {
        break
      }

      const p0_L =
        p0_idx < 0
          ? this.inputBuffer.readInt16LE(p1_idx * 4)
          : this.inputBuffer.readInt16LE(p0_idx * 4)
      const p1_L = this.inputBuffer.readInt16LE(p1_idx * 4)
      const p2_L = this.inputBuffer.readInt16LE(p2_idx * 4)
      const p3_L = this.inputBuffer.readInt16LE(p3_idx * 4)
      const out_L = cubicInterpolate(p0_L, p1_L, p2_L, p3_L, frac)
      outputBuffer.writeInt16LE(clamp16Bit(out_L), outputPos)

      const p0_R =
        p0_idx < 0
          ? this.inputBuffer.readInt16LE(p1_idx * 4 + 2)
          : this.inputBuffer.readInt16LE(p0_idx * 4 + 2)
      const p1_R = this.inputBuffer.readInt16LE(p1_idx * 4 + 2)
      const p2_R = this.inputBuffer.readInt16LE(p2_idx * 4 + 2)
      const p3_R = this.inputBuffer.readInt16LE(p3_idx * 4 + 2)
      const out_R = cubicInterpolate(p0_R, p1_R, p2_R, p3_R, frac)
      outputBuffer.writeInt16LE(clamp16Bit(out_R), outputPos + 2)

      outputPos += 4
    }

    const consumedInputBytes = Math.floor((outputPos / 4) * this.finalRate) * 4
    this.inputBuffer = this.inputBuffer.slice(consumedInputBytes)

    return outputBuffer.slice(0, outputPos)
  }
}
