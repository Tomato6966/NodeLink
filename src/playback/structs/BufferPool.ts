import { logger } from '../../utils.ts'

const MAX_POOL_SIZE_BYTES = 50 * 1024 * 1024
const CLEANUP_INTERVAL = 60000

/**
 * A pool for reusing Buffers to reduce allocations and GC pressure.
 * Aligns buffer sizes to powers of two for better reuse.
 */
class BufferPool {
  private pools: Map<number, Buffer[]>
  private totalBytes: number
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    this.pools = new Map()
    this.totalBytes = 0

    this.cleanupInterval = setInterval(() => this._cleanup(), CLEANUP_INTERVAL)
    this.cleanupInterval.unref()
  }

  /**
   * Aligns the requested size to the next power of two (minimum 1024).
   * @param size The requested size.
   * @returns The aligned size.
   * @private
   */
  private _getAlignedSize(size: number): number {
    if (size <= 1024) return 1024
    let n = size - 1
    n |= n >> 1
    n |= n >> 2
    n |= n >> 4
    n |= n >> 8
    n |= n >> 16
    return n + 1
  }

  /**
   * Acquires a Buffer of at least the requested size from the pool.
   * If no buffer is available, a new one is allocated.
   * @param size The minimum size required.
   * @returns A Buffer with length equal to the aligned size.
   */
  public acquire(size: number): Buffer {
    const alignedSize = this._getAlignedSize(size)
    const pool = this.pools.get(alignedSize)
    if (pool?.length) {
      const buffer = pool.pop()
      if (buffer) {
        this.totalBytes -= alignedSize
        return buffer
      }
    }
    return Buffer.allocUnsafe(alignedSize)
  }

  /**
   * Releases a Buffer back into the pool for future reuse.
   * Only buffers within a certain size range are pooled to avoid fragmentation.
   * @param buffer The Buffer to release.
   */
  public release(buffer: Buffer): void {
    if (!Buffer.isBuffer(buffer)) return

    const size = buffer.length

    // Only pool buffers between 1KB and 10MB
    if (size < 1024 || size > 10 * 1024 * 1024) return

    if (this.totalBytes + size > MAX_POOL_SIZE_BYTES) {
      return
    }

    let pool = this.pools.get(size)
    if (!pool) {
      pool = []
      this.pools.set(size, pool)
    }

    pool.push(buffer)
    this.totalBytes += size
  }

  /**
   * Clears all pooled buffers.
   */
  public clear(): void {
    this.pools.clear()
    this.totalBytes = 0
  }

  /**
   * Periodic cleanup to ensure the pool doesn't exceed its total byte limit.
   * @private
   */
  private _cleanup(): void {
    if (this.totalBytes > MAX_POOL_SIZE_BYTES) {
      this.pools.clear()
      this.totalBytes = 0
      logger('debug', 'BufferPool', 'Pool cleared due to size limit.')
    }
  }
}

/**
 * Singleton instance of the BufferPool.
 */
export const bufferPool = new BufferPool()
