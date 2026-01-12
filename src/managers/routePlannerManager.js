import { logger } from '../utils.js'

export default class RoutePlannerManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.routePlanner
    this.blocks = []
    this.bannedIps = new Map()
    this.bannedBlocks = new Map()
    this.lastUsedBlockIndex = -1

    if (this.config?.ipBlocks?.length > 0) {
      this._loadIpBlocks()
    }
  }

  _ipToBigInt(ip) {
    if (ip.includes(':')) { 
      const parts = ip.split(':')
      let fullParts = []
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') {
          const missing = 8 - (parts.length - 1)
          fullParts.push(...Array(missing).fill('0000'))
        } else {
          fullParts.push(parts[i].padStart(4, '0'))
        }
      }
      return BigInt('0x' + fullParts.join(''))
    } else { 
      return BigInt(ip.split('.').reduce((acc, oct) => (acc << 8n) + BigInt(oct), 0n))
    }
  }

  _bigIntToIp(bigint, isIpv6) {
    if (isIpv6) {
      let hex = bigint.toString(16).padStart(32, '0')
      let parts = []
      for (let i = 0; i < 8; i++) {
        parts.push(hex.substring(i * 4, i * 4 + 4))
      }
      return parts.join(':').replace(/\b0{1,3}/g, '')
    } else {
      let parts = []
      for (let i = 0; i < 4; i++) {
        parts.unshift(Number(bigint & 255n))
        bigint >>= 8n
      }
      return parts.join('.')
    }
  }

  _loadIpBlocks() {
    for (const blockConfig of this.config.ipBlocks) {
      try {
        const [baseIp, maskLengthStr] = blockConfig.cidr.split('/')
        const maskLength = parseInt(maskLengthStr, 10)
        const isIpv6 = baseIp.includes(':')
        const totalBits = isIpv6 ? 128n : 32n
        
        const baseInt = this._ipToBigInt(baseIp)
        const mask = ((1n << BigInt(maskLength)) - 1n) << (totalBits - BigInt(maskLength))
        const networkInt = baseInt & mask
        const size = 1n << (totalBits - BigInt(maskLength))

        this.blocks.push({
          cidr: blockConfig.cidr,
          networkInt,
          size,
          lastUsedOffset: -1n,
          isIpv6
        })
      } catch (e) {
        logger('error', 'RoutePlanner', `Failed to parse block ${blockConfig.cidr}: ${e.message}`)
      }
    }
    logger('info', 'RoutePlanner', `Initialized with ${this.blocks.length} IP blocks.`)
  }

  getIP() {
    if (this.blocks.length === 0) return null

    const strategy = this.config.strategy || 'RotateOnBan'
    switch (strategy) {
      case 'RoundRobin':
      case 'RotateOnBan':
        return this._getNextIp()
      case 'LoadBalance':
        return this._getRandomIp()
      default:
        return this._getNextIp()
    }
  }

  _getNextIp() {
    const now = Date.now()
    const startBlockIdx = this.lastUsedBlockIndex

    for (let i = 0; i < this.blocks.length; i++) {
      this.lastUsedBlockIndex = (this.lastUsedBlockIndex + 1) % this.blocks.length
      const block = this.blocks[this.lastUsedBlockIndex]

      if (this.bannedBlocks.has(block.cidr) && now < this.bannedBlocks.get(block.cidr)) continue

      for (let attempt = 0; attempt < 10; attempt++) {
        block.lastUsedOffset = (block.lastUsedOffset + 1n) % block.size
        const ipInt = block.networkInt + block.lastUsedOffset
        const ip = this._bigIntToIp(ipInt, block.isIpv6)

        if (!this.bannedIps.has(ip) || now > this.bannedIps.get(ip)) {
          return ip
        }
      }
    }

    return null
  }

  _getRandomIp() {
    const now = Date.now()
    const availableBlocks = this.blocks.filter(b => !this.bannedBlocks.has(b.cidr) || now > this.bannedBlocks.get(b.cidr))
    
    if (availableBlocks.length === 0) return null

    const block = availableBlocks[Math.floor(Math.random() * availableBlocks.length)]
    
    const randomOffset = BigInt(Math.floor(Math.random() * Number(block.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : block.size)))
    const ipInt = block.networkInt + randomOffset
    return this._bigIntToIp(ipInt, block.isIpv6)
  }

  banIP(ip) {
    if (!ip) return
    const cooldown = this.config.bannedIpCooldown || 600000
    const now = Date.now()
    this.bannedIps.set(ip, now + cooldown)
    
    // Check if we should ban the whole block (if many IPs are failing)
    const block = this.blocks.find(b => {
      const ipInt = this._ipToBigInt(ip)
      return ipInt >= b.networkInt && ipInt < b.networkInt + b.size
    })

    if (block) {
      let failedInBlock = 0
      for (const bannedIp of this.bannedIps.keys()) {
        const bIpInt = this._ipToBigInt(bannedIp)
        if (bIpInt >= block.networkInt && bIpInt < block.networkInt + block.size) {
          failedInBlock++
        }
      }

      if (failedInBlock >= 5) {
        this.bannedBlocks.set(block.cidr, now + cooldown * 2)
        logger('warn', 'RoutePlanner', `Banning Block: ${block.cidr} due to multiple failures.`)
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
    this.bannedBlocks.clear()
    logger('info', 'RoutePlanner', 'Freed all banned IPs and blocks.')
  }
}