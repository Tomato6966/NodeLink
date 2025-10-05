import { clamp16Bit } from './dsp/clamp16Bit.js'

export default class Timescale {
  constructor() {
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

    this.inputBuffer = Buffer.concat([this.inputBuffer, chunk])

    const requiredInputForOneOutput = Math.ceil(2 * this.finalRate)
    if (this.inputBuffer.length < requiredInputForOneOutput * 2) {
      return Buffer.alloc(0)
    }

    const outputLength = Math.floor(this.inputBuffer.length / this.finalRate)
    const finalOutputLength = outputLength - (outputLength % 4)
    const outputBuffer = Buffer.alloc(finalOutputLength)

    let outputPos = 0
    while (outputPos < finalOutputLength) {
      const inputIndex = (outputPos / 2) * this.finalRate
      const i0 = Math.floor(inputIndex)
      const i1 = i0 + 1
      const frac = inputIndex - i0

      if (i1 * 2 + 3 >= this.inputBuffer.length) {
        break
      }

      const s0_L = this.inputBuffer.readInt16LE(i0 * 2)
      const s1_L = this.inputBuffer.readInt16LE(i1 * 2)
      const out_L = s0_L * (1 - frac) + s1_L * frac
      outputBuffer.writeInt16LE(clamp16Bit(out_L), outputPos)

      const s0_R = this.inputBuffer.readInt16LE(i0 * 2 + 2)
      const s1_R = this.inputBuffer.readInt16LE(i1 * 2 + 2)
      const out_R = s0_R * (1 - frac) + s1_R * frac
      outputBuffer.writeInt16LE(clamp16Bit(out_R), outputPos + 2)

      outputPos += 4
    }

    const consumedInputBytes = Math.floor((outputPos / 2) * this.finalRate) * 2
    this.inputBuffer = this.inputBuffer.slice(consumedInputBytes)

    return outputBuffer.slice(0, outputPos)
  }
}
