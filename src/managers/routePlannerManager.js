import { logger } from '../utils.js'

export default class RoutePlannerManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.routePlanner
    this.ipBlocks = []
    this.bannedIps = new Map()
    this.lastUsedIndex = -1

    if (this.config?.ipBlocks?.length > 0) {
      this._loadIpBlocks()
    }
  }

  _ipToInt(ip) {
    return (
      ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>>
      0
    )
  }

  _intToIp(int) {
    return [
      (int >>> 24) & 0xff,
      (int >>> 16) & 0xff,
      (int >>> 8) & 0xff,
      int & 0xff
    ].join('.')
  }

  _generateIpsFromCidr(cidr) {
    const [baseIp, maskLength] = cidr.split('/')
    if (!baseIp || !maskLength) throw new Error(`Invalid CIDR: ${cidr}`)

    const mask = ~(2 ** (32 - parseInt(maskLength)) - 1) >>> 0
    const baseInt = this._ipToInt(baseIp) & mask
    const numberOfIps = 2 ** (32 - parseInt(maskLength))
    const ips = []

    for (let i = 0; i < numberOfIps; i++) {
      ips.push(this._intToIp(baseInt + i))
    }
    return ips
  }

  _loadIpBlocks() {
    for (const block of this.config.ipBlocks) {
      try {
        const ips = this._generateIpsFromCidr(block.cidr)
        this.ipBlocks.push(...ips)
      } catch (e) {
        logger(
          'error',
          'RoutePlanner',
          `Failed to parse IP block ${block.cidr}: ${e.message}`
        )
      }
    }
    logger(
      'info',
      'RoutePlanner',
      `Loaded ${this.ipBlocks.length} IPs from ${this.config.ipBlocks.length} blocks.`
    )
  }

  getIP() {
    if (this.ipBlocks.length === 0) return null

    const strategy = this.config.strategy || 'RoundRobin'

    switch (strategy) {
      case 'RoundRobin':
        return this._getRoundRobinIp()
      case 'RotateOnBan':
        return this._getRotateOnBanIp()
      case 'LoadBalance':
        return this._getRandomIp()
      default:
        return this._getRoundRobinIp()
    }
  }

  _getRoundRobinIp() {
    if (this.ipBlocks.length === 0) return null
    this.lastUsedIndex = (this.lastUsedIndex + 1) % this.ipBlocks.length
    return this.ipBlocks[this.lastUsedIndex]
  }

  _getRotateOnBanIp() {
    if (this.ipBlocks.length === 0) return null

    const now = Date.now()
    for (let i = 0; i < this.ipBlocks.length; i++) {
      this.lastUsedIndex = (this.lastUsedIndex + 1) % this.ipBlocks.length
      const ip = this.ipBlocks[this.lastUsedIndex]
      const bannedUntil = this.bannedIps.get(ip)

      if (!bannedUntil || now > bannedUntil) {
        return ip
      }
    }

    logger('warn', 'RoutePlanner', 'All IPs are currently banned.')
    return null
  }

  _getRandomIp() {
    const now = Date.now()
    const availableIps = this.ipBlocks.filter((ip) => {
      const bannedUntil = this.bannedIps.get(ip)
      return !bannedUntil || now > bannedUntil
    })

    if (availableIps.length === 0) {
      logger('warn', 'RoutePlanner', 'All IPs are currently banned.')
      return null
    }

    const ip = availableIps[Math.floor(Math.random() * availableIps.length)]
    return ip
  }

  banIP(ip) {
    if (!ip) return
    const cooldown = this.config.bannedIpCooldown || 600000
    this.bannedIps.set(ip, Date.now() + cooldown)
    logger('warn', 'RoutePlanner', `Banning IP: ${ip} for ${cooldown}ms`)
  }

  freeIP(ip) {
    if (this.bannedIps.has(ip)) {
      this.bannedIps.delete(ip)
      logger('info', 'RoutePlanner', `Freed IP: ${ip}`)
    }
  }

  freeAll() {
    this.bannedIps.clear()
    logger('info', 'RoutePlanner', 'Freed all banned IPs.')
  }
}
