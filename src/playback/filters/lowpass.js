import { clamp16Bit } from './dsp/clamp16Bit.js'

export default class Lowpass {
  constructor() {
    this.priority = 10
    this.smoothing = 0
    this.smoothingFactor = 0
    this.prevLeftOutput = 0
    this.prevRightOutput = 0
  }

  update(filters) {
    const { smoothing = 0 } = filters.lowpass || {}

    if (smoothing > 1.0) {
      this.smoothing = smoothing
      this.smoothingFactor = 1.0 / smoothing
    } else {
      this.smoothing = 0
      this.smoothingFactor = 0
    }
    this.prevLeftOutput = 0
    this.prevRightOutput = 0
  }

  process(chunk) {
    if (this.smoothing <= 1.0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const currentLeftSample = chunk.readInt16LE(i)
      const newLeftSample =
        this.prevLeftOutput +
        this.smoothingFactor * (currentLeftSample - this.prevLeftOutput)
      this.prevLeftOutput = newLeftSample
      chunk.writeInt16LE(clamp16Bit(newLeftSample), i)

      const currentRightSample = chunk.readInt16LE(i + 2)
      const newRightSample =
        this.prevRightOutput +
        this.smoothingFactor * (currentRightSample - this.prevRightOutput)
      this.prevRightOutput = newRightSample
      chunk.writeInt16LE(clamp16Bit(newRightSample), i + 2)
    }

    return chunk
  }
}
