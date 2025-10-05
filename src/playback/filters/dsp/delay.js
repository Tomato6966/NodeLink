export default class DelayLine {
  constructor(size) {
    this.buffer = Buffer.alloc(size * 2)
    this.size = size
    this.writeIndex = 0
  }

  write(sample) {
    this.buffer.writeInt16LE(sample, this.writeIndex * 2)
    this.writeIndex = (this.writeIndex + 1) % this.size
  }

  read(delayInSamples) {
    const safeDelay = Math.max(
      0,
      Math.min(Math.floor(delayInSamples), this.size - 1)
    )
    const readIndex = (this.writeIndex - safeDelay + this.size) % this.size

    return this.buffer.readInt16LE(readIndex * 2)
  }

  clear() {
    this.buffer.fill(0)
  }
}
