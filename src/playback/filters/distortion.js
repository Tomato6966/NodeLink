import { clamp16Bit } from './dsp/clamp16Bit.js'

const MAX_INT_16 = 32767

export default class Distortion {
  constructor() {
    this.priority = 10
    this.sinOffset = 0
    this.sinScale = 0
    this.cosOffset = 0
    this.cosScale = 0
    this.tanOffset = 0
    this.tanScale = 0
    this.offset = 0
    this.scale = 1
  }

  update(filters) {
    const {
      sinOffset = 0,
      sinScale = 0,
      cosOffset = 0,
      cosScale = 0,
      tanOffset = 0,
      tanScale = 0,
      offset = 0,
      scale = 1
    } = filters.distortion || {}

    this.sinOffset = sinOffset
    this.sinScale = sinScale
    this.cosOffset = cosOffset
    this.cosScale = cosScale
    this.tanOffset = tanOffset
    this.tanScale = tanScale
    this.offset = offset
    this.scale = scale
  }

  process(chunk) {
    if (
      this.sinScale === 0 &&
      this.cosScale === 0 &&
      this.tanScale === 0 &&
      this.offset === 0 &&
      this.scale === 1
    ) {
      return chunk
    }

    for (let i = 0; i < chunk.length; i += 4) {
      const currentLeftSample = chunk.readInt16LE(i)
      const currentRightSample = chunk.readInt16LE(i + 2)

      const normalizedLeft = currentLeftSample / MAX_INT_16
      const normalizedRight = currentRightSample / MAX_INT_16

      let distortedLeft = 0
      let distortedRight = 0

      if (this.sinScale !== 0) {
        distortedLeft += Math.sin(
          normalizedLeft * this.sinScale + this.sinOffset
        )
        distortedRight += Math.sin(
          normalizedRight * this.sinScale + this.sinOffset
        )
      }

      if (this.cosScale !== 0) {
        distortedLeft += Math.cos(
          normalizedLeft * this.cosScale + this.cosOffset
        )
        distortedRight += Math.cos(
          normalizedRight * this.cosScale + this.cosOffset
        )
      }

      if (this.tanScale !== 0) {
        const tanInputLeft = Math.max(
          -Math.PI / 2 + 0.01,
          Math.min(
            Math.PI / 2 - 0.01,
            normalizedLeft * this.tanScale + this.tanOffset
          )
        )
        const tanInputRight = Math.max(
          -Math.PI / 2 + 0.01,
          Math.min(
            Math.PI / 2 - 0.01,
            normalizedRight * this.tanScale + this.tanOffset
          )
        )

        distortedLeft += Math.tan(tanInputLeft)
        distortedRight += Math.tan(tanInputRight)
      }

      distortedLeft = (distortedLeft * this.scale + this.offset) * MAX_INT_16
      distortedRight = (distortedRight * this.scale + this.offset) * MAX_INT_16

      chunk.writeInt16LE(clamp16Bit(distortedLeft), i)
      chunk.writeInt16LE(clamp16Bit(distortedRight), i + 2)
    }

    return chunk
  }
}
