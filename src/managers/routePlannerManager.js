import { logger } from '../utils.js'

export default class RoutePlannerManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.routePlanner
    this.ipBlocks = []
    this.bannedIps = new Map()
    this.bannedBlocks = new Map()
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
      ips.push({ ip: this._intToIp(baseInt + i), block: cidr })
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
    return this.ipBlocks[this.lastUsedIndex].ip
  }

  _getRotateOnBanIp() {
    if (this.ipBlocks.length === 0) return null

    const now = Date.now()
    for (let i = 0; i < this.ipBlocks.length; i++) {
      this.lastUsedIndex = (this.lastUsedIndex + 1) % this.ipBlocks.length
      const entry = this.ipBlocks[this.lastUsedIndex]
      
      const blockBanned = this.bannedBlocks.get(entry.block)
      if (blockBanned && now < blockBanned) continue

      const bannedUntil = this.bannedIps.get(entry.ip)
      if (!bannedUntil || now > bannedUntil) {
        return entry.ip
      }
    }

    logger('warn', 'RoutePlanner', 'All IPs are currently banned.')
    return null
  }

  _getRandomIp() {
    const now = Date.now()
    const availableIps = this.ipBlocks.filter((entry) => {
      const blockBanned = this.bannedBlocks.get(entry.block)
      if (blockBanned && now < blockBanned) return false

      const bannedUntil = this.bannedIps.get(entry.ip)
      return !bannedUntil || now > bannedUntil
    })

    if (availableIps.length === 0) {
      logger('warn', 'RoutePlanner', 'All IPs are currently banned.')
      return null
    }

    const entry = availableIps[Math.floor(Math.random() * availableIps.length)]
    return entry.ip
  }

  banIP(ip) {
    if (!ip) return
    const cooldown = this.config.bannedIpCooldown || 600000
    const now = Date.now()
    this.bannedIps.set(ip, now + cooldown)
    
    const entry = this.ipBlocks.find(e => e.ip === ip)
    if (entry) {
      const block = entry.block
      let failedCount = 0
      for (const e of this.ipBlocks) {
        if (e.block === block && this.bannedIps.has(e.ip) && this.bannedIps.get(e.ip) > now) {
          failedCount++
        }
      }
      
      const blockSize = this.ipBlocks.filter(e => e.block === block).length
      if (failedCount >= blockSize * 0.5) {
        this.bannedBlocks.set(block, now + cooldown * 2)
        logger('warn', 'RoutePlanner', `Banning Block: ${block} for ${cooldown * 2}ms`)
      }
    }

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
