import { logger } from '../utils.js';

export default class RoutePlannerManager {
  constructor(nodelink) {
    this.nodelink = nodelink;
    this.config = nodelink.options.routePlanner;
    this.ipBlocks = [];
    this.bannedIps = new Map();

    if (this.config?.ipBlocks?.length > 0) {
      this._loadIpBlocks();
    }
  }

  _loadIpBlocks() {
    for (const block of this.config.ipBlocks) {
      try {
        const subnet = ip.cidrSubnet(block.cidr);
        const ips = subnet.map((addr) => addr.address);
        this.ipBlocks.push(...ips);
      } catch (e) {
        logger('error', 'RoutePlanner', `Failed to parse IP block ${block.cidr}: ${e.message}`);
      }
    }
    logger('info', 'RoutePlanner', `Loaded ${this.ipBlocks.length} IPs from ${this.config.ipBlocks.length} blocks.`);
  }

  getIP() {
    if (this.ipBlocks.length === 0) return null;

    const now = Date.now();
    const availableIps = this.ipBlocks.filter((ip) => {
      const bannedUntil = this.bannedIps.get(ip);
      return !bannedUntil || now > bannedUntil;
    });

    if (availableIps.length === 0) {
      logger('warn', 'RoutePlanner', 'All IPs are currently banned.');
      return null;
    }

    const ip = availableIps[Math.floor(Math.random() * availableIps.length)];
    return ip;
  }

  banIP(ip) {
    if (!ip) return;
    const cooldown = this.config.bannedIpCooldown || 600000;
    this.bannedIps.set(ip, Date.now() + cooldown);
    logger('warn', 'RoutePlanner', `Banning IP: ${ip} for ${cooldown}ms`);
  }

  freeIP(ip) {
    if (this.bannedIps.has(ip)) {
      this.bannedIps.delete(ip);
      logger('info', 'RoutePlanner', `Freed IP: ${ip}`);
    }
  }

  freeAll() {
    this.bannedIps.clear();
    logger('info', 'RoutePlanner', 'Freed all banned IPs.');
  }
}