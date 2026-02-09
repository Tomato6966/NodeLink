import { bufferPool } from './BufferPool.ts'

/**
 * A fast, fixed-size circular buffer for audio chunks.
 * Uses BufferPool for memory management to reduce GC pressure.
 */
export class RingBuffer {
  private buffer: Buffer | null
  private size: number
  private writeOffset: number
  private readOffset: number
  private length: number

  /**
   * Creates a new RingBuffer.
   * @param size The size of the buffer in bytes.
   */
  constructor(size: number) {
    this.buffer = bufferPool.acquire(size)
    this.size = size
    this.writeOffset = 0
    this.readOffset = 0
    this.length = 0
  }

  /**
   * Releases the internal buffer back to the pool.
   */
  public dispose(): void {
    if (this.buffer) {
      bufferPool.release(this.buffer)
      this.buffer = null
    }
  }

  /**
   * Writes a chunk of data to the buffer.
   * If the buffer is full, it overwrites the oldest data.
   * @param chunk The data chunk to write.
   */
  public write(chunk: Buffer): void {
    if (!this.buffer) return

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

  /**
   * Reads up to n bytes from the buffer.
   * @param n The maximum number of bytes to read.
   * @returns A Buffer containing the data, or null if empty or disposed.
   */
  public read(n: number): Buffer | null {
    if (!this.buffer) return null

    const bytesToReadNum = Math.min(Math.max(0, n), this.length)
    if (bytesToReadNum === 0) return null
    const out = Buffer.allocUnsafe(bytesToReadNum)

    const availableAtEnd = this.size - this.readOffset
    if (bytesToReadNum <= availableAtEnd) {
      this.buffer.copy(
        out,
        0,
        this.readOffset,
        this.readOffset + bytesToReadNum
      )
    } else {
      this.buffer.copy(out, 0, this.readOffset, this.size)
      this.buffer.copy(out, availableAtEnd, 0, bytesToReadNum - availableAtEnd)
    }

    this.readOffset = (this.readOffset + bytesToReadNum) % this.size
    this.length -= bytesToReadNum
    return out
  }

  /**
   * Skips n bytes in the buffer.
   * @param n The number of bytes to skip.
   * @returns The number of bytes actually skipped.
   */
  public skip(n: number): number {
    const skipAmount = Math.max(0, n)
    const bytesToSkip = Math.min(skipAmount, this.length)
    this.readOffset = (this.readOffset + bytesToSkip) % this.size
    this.length -= bytesToSkip
    return bytesToSkip
  }

  /**
   * Peeks up to n bytes from the buffer without advancing the read offset.
   * @param n The maximum number of bytes to peek.
   * @returns A new Buffer containing the data, or null if empty or disposed.
   */
  public peek(n: number): Buffer | null {
    if (!this.buffer) return null

    const bytesToPeekNum = Math.min(Math.max(0, n), this.length)
    if (bytesToPeekNum === 0) return null
    const out = Buffer.allocUnsafe(bytesToPeekNum)

    const availableAtEnd = this.size - this.readOffset
    if (bytesToPeekNum <= availableAtEnd) {
      this.buffer.copy(
        out,
        0,
        this.readOffset,
        this.readOffset + bytesToPeekNum
      )
    } else {
      this.buffer.copy(out, 0, this.readOffset, this.size)
      this.buffer.copy(out, availableAtEnd, 0, bytesToPeekNum - availableAtEnd)
    }
    return out
  }

  /**
   * Gets up to n contiguous bytes from the buffer, or a copied Buffer if not contiguous.
   * @param n The maximum number of bytes to get.
   * @returns A Buffer subarray or a new Buffer, or null if empty or disposed.
   */
  public getContiguous(n: number): Buffer | null {
    if (!this.buffer) return null

    const bytesToPeekNum = Math.min(Math.max(0, n), this.length)
    if (bytesToPeekNum === 0) return null
    const availableAtEnd = this.size - this.readOffset

    if (bytesToPeekNum <= availableAtEnd) {
      return this.buffer.subarray(
        this.readOffset,
        this.readOffset + bytesToPeekNum
      )
    }

    const out = Buffer.allocUnsafe(bytesToPeekNum)
    this.buffer.copy(out, 0, this.readOffset, this.size)
    this.buffer.copy(out, availableAtEnd, 0, bytesToPeekNum - availableAtEnd)
    return out
  }

  /**
   * Clears the buffer (resets offsets and length).
   */
  public clear(): void {
    this.writeOffset = 0
    this.readOffset = 0
    this.length = 0
  }

  /**
   * Gets the current amount of data in the buffer.
   * @returns The number of bytes available to read.
   */
  public getLength(): number {
    return this.length
  }

  /**
   * Gets the total size of the buffer.
   * @returns The buffer capacity in bytes.
   */
  public getSize(): number {
    return this.size
  }
}
