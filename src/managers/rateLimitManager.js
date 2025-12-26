import { logger } from '../utils.js'

export default class RateLimitManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options?.rateLimit
    this.store = new Map()
    this.cleanupInterval = setInterval(
      () => this._cleanup(),
      Math.max(1, this.config?.global?.timeWindowMs || 1)
    )
  }

  _getKey(type, id) {
    return `${type}:${id}`
  }

  _checkAndIncrement(type, id, maxRequests, timeWindowMs) {
    const key = this._getKey(type, id)
    const now = Date.now()

    if (!this.store.has(key)) {
      this.store.set(key, { requests: [] })
    }

    const entry = this.store.get(key)

    entry.requests = entry.requests.filter(
      (reqTime) => now - reqTime < timeWindowMs
    )

    const remaining = Math.max(0, maxRequests - entry.requests.length)
    const reset =
      entry.requests.length > 0
        ? entry.requests[0] + timeWindowMs
        : now + timeWindowMs

    if (entry.requests.length >= maxRequests) {
      return { allowed: false, limit: maxRequests, remaining: 0, reset }
    }

    entry.requests.push(now)
    return {
      allowed: true,
      limit: maxRequests,
      remaining: remaining - 1,
      reset
    }
  }

  check(req, parsedUrl) {
    if (!this.config.enabled) {
      return { allowed: true }
    }

    if (
      this.config.ignorePaths.some((path) =>
        parsedUrl.pathname.startsWith(path)
      )
    ) {
      return { allowed: true }
    }

    const remoteAddress = req.socket.remoteAddress
    const userId = req.headers['user-id']
    const guildId = parsedUrl.pathname.includes('/players/')
      ? parsedUrl.pathname.split('/')[5]
      : null

    if (this.config.ignore) {
      if (this.config.ignore.ips?.includes(remoteAddress))
        return { allowed: true }
      if (userId && this.config.ignore.userIds?.includes(userId))
        return { allowed: true }
      if (guildId && this.config.ignore.guildIds?.includes(guildId))
        return { allowed: true }
    }

    const globalCheck = this._checkAndIncrement(
      'global',
      'all',
      this.config.global.maxRequests,
      this.config.global.timeWindowMs
    )
    if (!globalCheck.allowed) {
      logger(
        'warn',
        'RateLimit',
        `Global rate limit exceeded for ${remoteAddress}`
      )
      return globalCheck
    }

    const ipCheck = this._checkAndIncrement(
      'ip',
      remoteAddress,
      this.config.perIp.maxRequests,
      this.config.perIp.timeWindowMs
    )
    if (!ipCheck.allowed) {
      logger('warn', 'RateLimit', `IP rate limit exceeded for ${remoteAddress}`)
      return ipCheck
    }

    if (userId) {
      const userCheck = this._checkAndIncrement(
        'userId',
        userId,
        this.config.perUserId.maxRequests,
        this.config.perUserId.timeWindowMs
      )
      if (!userCheck.allowed) {
        logger(
          'warn',
          'RateLimit',
          `User-Id rate limit exceeded for ${userId} (IP: ${remoteAddress})`
        )
        return userCheck
      }
    }

    if (guildId) {
      const guildCheck = this._checkAndIncrement(
        'guildId',
        guildId,
        this.config.perGuildId.maxRequests,
        this.config.perGuildId.timeWindowMs
      )
      if (!guildCheck.allowed) {
        logger(
          'warn',
          'RateLimit',
          `Guild-Id rate limit exceeded for ${guildId} (IP: ${remoteAddress}, User: ${userId})`
        )
        return guildCheck
      }
    }

    return { allowed: true }
  }

  _cleanup() {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      entry.requests = entry.requests.filter(
        (reqTime) => now - reqTime < this.config.global.timeWindowMs
      )

      if (entry.requests.length === 0) {
        this.store.delete(key)
      }
    }
  }

  clear() {
    this.store.clear()
  }

  destroy() {
    clearInterval(this.cleanupInterval)
    this.store.clear()
  }
}
