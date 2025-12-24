
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

  acquire(size) {
    const pool = this.pools.get(size)
    if (pool && pool.length > 0) {
      const buffer = pool.pop()
      return buffer
    }
    return Buffer.allocUnsafe(size)
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

  _cleanup() {
    if (this.totalBytes > MAX_POOL_SIZE_BYTES) {
      this.pools.clear()
      this.totalBytes = 0
      logger('debug', 'BufferPool', 'Pool cleared due to size limit.')
    }
  }
}

export const bufferPool = new BufferPool()
