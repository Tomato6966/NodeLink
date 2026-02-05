import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { logger } from '../utils.js'

export default class TrackCacheManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.key = crypto.scryptSync(
      nodelink.options.server.password,
      'nodelink-track-salt',
      32
    )
    this.filePath = './.cache/tracks.bin'
    this.cache = new Map()
    this._saveTimeout = null
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath)
      if (data.length < 32) return

      const iv = data.subarray(0, 16)
      const tag = data.subarray(16, 32)
      const encrypted = data.subarray(32)

      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
      decipher.setAuthTag(tag)

      const decrypted =
        decipher.update(encrypted, 'binary', 'utf8') + decipher.final('utf8')
      const obj = JSON.parse(decrypted)

      this.cache = new Map(Object.entries(obj))
      
      const now = Date.now()
      let expiredCount = 0
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expiresAt && now > entry.expiresAt) {
          this.cache.delete(key)
          expiredCount++
        }
      }
      if (expiredCount > 0) this.save()

      logger('debug', 'TrackCache', `Loaded ${this.cache.size} cached tracks from disk.`)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger('error', 'TrackCache', `Failed to load track cache: ${e.message}`)
      }
      this.cache = new Map()
    }
  }

  async save() {
    if (this._saveTimeout) return

    this._saveTimeout = setTimeout(async () => {
      this._saveTimeout = null
      await this.forceSave()
    }, 5000)
  }

  async forceSave() {
    try {
      const plainText = JSON.stringify(Object.fromEntries(this.cache))
      const iv = crypto.randomBytes(16)
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)

      const encrypted = Buffer.concat([
        cipher.update(plainText, 'utf8'),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()

      await fs.mkdir('./.cache', { recursive: true })
      await fs.writeFile(this.filePath, Buffer.concat([iv, tag, encrypted]))
    } catch (e) {
      logger('error', 'TrackCache', `Failed to save track cache: ${e.message}`)
    }
  }

  get(source, identifier) {
    const key = `${source}:${identifier}`
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.save()
      return null
    }
    return entry.value
  }

  set(source, identifier, value, ttlMs = 1000 * 60 * 60 * 6) {
    const key = `${source}:${identifier}`
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    })
    this.save()
  }
}
