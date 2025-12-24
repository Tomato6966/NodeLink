
import { bufferPool } from './BufferPool.js'

export class RingBuffer {
  constructor(size) {
    this.buffer = bufferPool.acquire(size)
    this.size = size
    this.writeOffset = 0
    this.readOffset = 0
    this.length = 0
  }

  dispose() {
    if (this.buffer) {
      bufferPool.release(this.buffer)
      this.buffer = null
    }
  }

  write(chunk) {
    const bytesToWrite = chunk.length
    const availableAtEnd = this.size - this.writeOffset

    if (bytesToWrite <= availableAtEnd) {
      chunk.copy(this.buffer, this.writeOffset)
    } else {
      chunk.copy(this.buffer, this.writeOffset, 0, availableAtEnd)
      chunk.copy(this.buffer, 0, availableAtEnd)
    }

    const newLength = this.length + bytesToWrite
    if (newLength > this.size) {
      this.readOffset = (this.readOffset + (newLength - this.size)) % this.size
      this.length = this.size
    } else {
      this.length = newLength
    }
    this.writeOffset = (this.writeOffset + bytesToWrite) % this.size
  }

  read(n) {
    if (this.length === 0 || n <= 0) return null
    const bytesToRead = Math.min(n, this.length)
    const out = Buffer.allocUnsafe(bytesToRead)

    const availableAtEnd = this.size - this.readOffset
    if (bytesToRead <= availableAtEnd) {
      this.buffer.copy(out, 0, this.readOffset, this.readOffset + bytesToRead)
    } else {
      this.buffer.copy(out, 0, this.readOffset, this.size)
      this.buffer.copy(out, availableAtEnd, 0, bytesToRead - availableAtEnd)
    }

    this.readOffset = (this.readOffset + bytesToRead) % this.size
    this.length -= bytesToRead
    return out
  }

  skip(n) {
    const bytesToSkip = Math.min(n, this.length)
    this.readOffset = (this.readOffset + bytesToSkip) % this.size
    this.length -= bytesToSkip
    return bytesToSkip
  }

  // Peek allows reading without advancing the read pointer
  peek(n) {
    if (this.length === 0) return null
    const bytesToRead = Math.min(n, this.length)
    const out = Buffer.allocUnsafe(bytesToRead)

    const availableAtEnd = this.size - this.readOffset
    if (bytesToRead <= availableAtEnd) {
      this.buffer.copy(out, 0, this.readOffset, this.readOffset + bytesToRead)
    } else {
      this.buffer.copy(out, 0, this.readOffset, this.size)
      this.buffer.copy(out, availableAtEnd, 0, bytesToRead - availableAtEnd)
    }
    return out
  }

  getContiguous(n) {
    if (this.length === 0 || n <= 0) return null
    const bytesToPeek = Math.min(n, this.length)
    const availableAtEnd = this.size - this.readOffset

    if (bytesToPeek <= availableAtEnd) {
      return this.buffer.subarray(this.readOffset, this.readOffset + bytesToPeek)
    }

    const out = Buffer.allocUnsafe(bytesToPeek)
    this.buffer.copy(out, 0, this.readOffset, this.size)
    this.buffer.copy(out, availableAtEnd, 0, bytesToPeek - availableAtEnd)
    return out
  }

  clear() {
    this.writeOffset = 0
    this.readOffset = 0
    this.length = 0
  }
}
