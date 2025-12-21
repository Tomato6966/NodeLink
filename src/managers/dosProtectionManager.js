import { logger } from '../utils.js'

export default class DosProtectionManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options?.dosProtection
    this.ipRequestCounts = new Map()
    this.cleanupInterval = setInterval(
      () => this._cleanup(),
      Math.max(1, this.config?.thresholds?.timeWindowMs || 1)
    )
  }

  _cleanup() {
    const now = Date.now()
    for (const [ip, data] of this.ipRequestCounts.entries()) {
      if (
        now > data.blockedUntil &&
        now - data.lastReset > this.config.thresholds.timeWindowMs
      ) {
        this.ipRequestCounts.delete(ip)
      } else if (now - data.lastReset > this.config.thresholds.timeWindowMs) {
        data.count = 0
        data.lastReset = now
      }
    }
  }

  check(req) {
    if (!this.config.enabled) {
      return { allowed: true }
    }

    const remoteAddress = req.socket.remoteAddress
    const now = Date.now()

    if (this.config.ignore) {
      if (this.config.ignore.ips?.includes(remoteAddress)) return { allowed: true }

      const userId = req.headers['user-id']
      if (userId && this.config.ignore.userIds?.includes(userId)) return { allowed: true }

      const guildIdMatch = req.url?.match(/\/players\/(\d+)/)
      const guildId = guildIdMatch ? guildIdMatch[1] : null
      if (guildId && this.config.ignore.guildIds?.includes(guildId)) return { allowed: true }
    }

    if (!this.ipRequestCounts.has(remoteAddress)) {
      this.ipRequestCounts.set(remoteAddress, {
        count: 0,
        lastReset: now,
        blockedUntil: 0
      })
    }

    const ipData = this.ipRequestCounts.get(remoteAddress)

    if (now < ipData.blockedUntil) {
      logger(
        'warn',
        'DosProtection',
        `IP ${remoteAddress} is temporarily blocked.`
      )
      return { allowed: false, status: 403, message: 'Forbidden' }
    }

    if (now - ipData.lastReset > this.config.thresholds.timeWindowMs) {
      ipData.count = 0
      ipData.lastReset = now
    }

    ipData.count++

    if (ipData.count > this.config.thresholds.burstRequests) {
      ipData.blockedUntil = now + this.config.mitigation.blockDurationMs
      logger(
        'warn',
        'DosProtection',
        `IP ${remoteAddress} exceeded burst limit. Blocking for ${this.config.mitigation.blockDurationMs}ms.`
      )
      return { allowed: false, status: 403, message: 'Forbidden' }
    }

    if (ipData.count > this.config.thresholds.burstRequests / 2) {
      logger(
        'debug',
        'DosProtection',
        `IP ${remoteAddress} is nearing burst limit. Introducing delay.`
      )
      return { allowed: true, delay: this.config.mitigation.delayMs }
    }

    return { allowed: true }
  }

  destroy() {
    clearInterval(this.cleanupInterval)
    this.ipRequestCounts.clear()
  }
}
