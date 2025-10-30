import { logger } from '../utils.js'

export default class DosProtectionManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options?.dosProtection
    this.ipRequestCounts = new Map()
    this.cleanupInterval = setInterval(
      () => this._cleanup(),
      this.config?.thresholds?.timeWindowMs
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
