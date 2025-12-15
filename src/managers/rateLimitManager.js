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

    if (entry.requests.length >= maxRequests) {
      return false
    }

    entry.requests.push(now)
    return true
  }

  check(req, parsedUrl) {
    if (!this.config.enabled) {
      return true
    }

    if (
      this.config.ignorePaths.some((path) =>
        parsedUrl.pathname.startsWith(path)
      )
    ) {
      return true
    }

    const remoteAddress = req.socket.remoteAddress
    const userId = req.headers['user-id']
    const guildId = parsedUrl.pathname.includes('/players/')
      ? parsedUrl.pathname.split('/')[5]
      : null

    if (this.config.ignore) {
      if (this.config.ignore.ips?.includes(remoteAddress)) return true
      if (userId && this.config.ignore.userIds?.includes(userId)) return true
      if (guildId && this.config.ignore.guildIds?.includes(guildId)) return true
    }

    if (
      !this._checkAndIncrement(
        'global',
        'all',
        this.config.global.maxRequests,
        this.config.global.timeWindowMs
      )
    ) {
      logger(
        'warn',
        'RateLimit',
        `Global rate limit exceeded for ${remoteAddress}`
      )
      return false
    }

    if (
      !this._checkAndIncrement(
        'ip',
        remoteAddress,
        this.config.perIp.maxRequests,
        this.config.perIp.timeWindowMs
      )
    ) {
      logger('warn', 'RateLimit', `IP rate limit exceeded for ${remoteAddress}`)
      return false
    }

    if (
      userId &&
      !this._checkAndIncrement(
        'userId',
        userId,
        this.config.perUserId.maxRequests,
        this.config.perUserId.timeWindowMs
      )
    ) {
      logger(
        'warn',
        'RateLimit',
        `User-Id rate limit exceeded for ${userId} (IP: ${remoteAddress})`
      )
      return false
    }

    if (
      guildId &&
      !this._checkAndIncrement(
        'guildId',
        guildId,
        this.config.perGuildId.maxRequests,
        this.config.perGuildId.timeWindowMs
      )
    ) {
      logger(
        'warn',
        'RateLimit',
        `Guild-Id rate limit exceeded for ${guildId} (IP: ${remoteAddress}, User: ${userId})`
      )
      return false
    }

    return true
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

  destroy() {
    clearInterval(this.cleanupInterval)
    this.store.clear()
  }
}
