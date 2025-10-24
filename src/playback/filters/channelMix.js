import { clamp16Bit } from './dsp/clamp16Bit.js'

export default class ChannelMix {
  constructor() {
    this.priority = 10
    this.leftToLeft = 1.0
    this.leftToRight = 0.0
    this.rightToLeft = 0.0
    this.rightToRight = 1.0
  }

  update(filters) {
    const {
      leftToLeft = 1.0,
      leftToRight = 0.0,
      rightToLeft = 0.0,
      rightToRight = 1.0
    } = filters.channelMix || {}

    this.leftToLeft = Math.max(0.0, Math.min(1.0, leftToLeft))
    this.leftToRight = Math.max(0.0, Math.min(1.0, leftToRight))
    this.rightToLeft = Math.max(0.0, Math.min(1.0, rightToLeft))
    this.rightToRight = Math.max(0.0, Math.min(1.0, rightToRight))
  }

  process(chunk) {
    if (
      this.leftToLeft === 1.0 &&
      this.leftToRight === 0.0 &&
      this.rightToLeft === 0.0 &&
      this.rightToRight === 1.0
    ) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const currentLeftSample = chunk.readInt16LE(i)
      const currentRightSample = chunk.readInt16LE(i + 2)

      const newLeftSample =
        currentLeftSample * this.leftToLeft +
        currentRightSample * this.rightToLeft
      const newRightSample =
        currentLeftSample * this.leftToRight +
        currentRightSample * this.rightToRight

      chunk.writeInt16LE(clamp16Bit(newLeftSample), i)
      chunk.writeInt16LE(clamp16Bit(newRightSample), i + 2)
    }

    return chunk
  }
}
