import { logger } from '../utils.js'

const MAX_POOL_SIZE_BYTES = 50 * 1024 * 1024
const CLEANUP_INTERVAL = 60000

class BufferPool {
  constructor() {
    this.pools = new Map()
    this.totalBytes = 0

    this.cleanupInterval = setInterval(() => this._cleanup(), CLEANUP_INTERVAL)
    this.cleanupInterval.unref()
  }

  _getAlignedSize(size) {
    if (size <= 1024) return 1024
    let n = size - 1
    n |= n >> 1
    n |= n >> 2
    n |= n >> 4
    n |= n >> 8
    n |= n >> 16
    return n + 1
  }

  acquire(size) {
    const alignedSize = this._getAlignedSize(size)
    const pool = this.pools.get(alignedSize)
    if (pool && pool.length > 0) {
      const buffer = pool.pop()
      this.totalBytes -= alignedSize
      return buffer
    }
    return Buffer.allocUnsafe(alignedSize)
  }

  release(buffer) {
    if (!Buffer.isBuffer(buffer)) return

    const size = buffer.length

    if (size < 1024 || size > 10 * 1024 * 1024) return

    if (this.totalBytes + size > MAX_POOL_SIZE_BYTES) {
      return
    }

    if (!this.pools.has(size)) {
      this.pools.set(size, [])
    }

    this.pools.get(size).push(buffer)
    this.totalBytes += size
  }

  clear() {
    this.pools.clear()
    this.totalBytes = 0
  }

  _cleanup() {
    if (this.totalBytes > MAX_POOL_SIZE_BYTES) {
      this.pools.clear()
      this.totalBytes = 0
      logger('debug', 'BufferPool', 'Pool cleared due to size limit.')
    }
  }
}

export const bufferPool = new BufferPool()
