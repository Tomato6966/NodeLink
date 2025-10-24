import { clamp16Bit } from './dsp/clamp16Bit.js'

export default class Highpass {
  constructor() {
    this.priority = 10
    this.smoothing = 0
    this.smoothingFactor = 0
    this.prevLeftInput = 0
    this.prevRightInput = 0
    this.prevLeftLowpassOutput = 0
    this.prevRightLowpassOutput = 0
  }

  update(filters) {
    const { smoothing = 0 } = filters.highpass || {}

    if (smoothing > 1.0) {
      this.smoothing = smoothing
      this.smoothingFactor = 1.0 / smoothing
    } else {
      this.smoothing = 0
      this.smoothingFactor = 0
    }
    this.prevLeftInput = 0
    this.prevRightInput = 0
    this.prevLeftLowpassOutput = 0
    this.prevRightLowpassOutput = 0
  }

  process(chunk) {
    if (this.smoothing <= 1.0) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const currentLeftSample = chunk.readInt16LE(i)
      const currentRightSample = chunk.readInt16LE(i + 2)

      const newLeftLowpassOutput =
        this.prevLeftLowpassOutput +
        this.smoothingFactor * (currentLeftSample - this.prevLeftLowpassOutput)
      this.prevLeftLowpassOutput = newLeftLowpassOutput

      const newLeftSample = currentLeftSample - newLeftLowpassOutput
      chunk.writeInt16LE(clamp16Bit(newLeftSample), i)

      const newRightLowpassOutput =
        this.prevRightLowpassOutput +
        this.smoothingFactor *
          (currentRightSample - this.prevRightLowpassOutput)
      this.prevRightLowpassOutput = newRightLowpassOutput

      const newRightSample = currentRightSample - newRightLowpassOutput
      chunk.writeInt16LE(clamp16Bit(newRightSample), i + 2)
    }

    return chunk
  }
}
