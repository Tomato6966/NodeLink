import { bufferPool } from './BufferPool.ts'

export class RingBuffer {
    private buffer: Buffer | null
    private size: number
    private writeOffset: number
    private readOffset: number
    private length: number

    constructor(size: number) {
        this.buffer = bufferPool.acquire(size)
        this.size = size
        this.writeOffset = 0
        this.readOffset = 0
        this.length = 0
    }

    public dispose(): void {
        if (this.buffer) {
            bufferPool.release(this.buffer)
            this.buffer = null
        }
    }

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

    public skip(n: number): number {
        const skipAmount = Math.max(0, n)
        const bytesToSkip = Math.min(skipAmount, this.length)
        this.readOffset = (this.readOffset + bytesToSkip) % this.size
        this.length -= bytesToSkip
        return bytesToSkip
    }

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

    public clear(): void {
        this.writeOffset = 0
        this.readOffset = 0
        this.length = 0
    }

    public getLength(): number {
        return this.length
    }

    public getSize(): number {
        return this.size
    }
}
