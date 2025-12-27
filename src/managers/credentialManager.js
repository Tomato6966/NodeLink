import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { logger } from '../utils.js'

export default class CredentialManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.key = crypto.scryptSync(nodelink.options.server.password, 'nodelink-salt', 32)
    this.filePath = './.cache/credentials.bin'
    this.credentials = new Map()
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
      
      const decrypted = decipher.update(encrypted, 'binary', 'utf8') + decipher.final('utf8')
      const obj = JSON.parse(decrypted)
      
      this.credentials = new Map(Object.entries(obj))
      logger('debug', 'Credentials', 'Loaded encrypted credentials from disk.')
    } catch (e) {
      if (e.code !== 'ENOENT') {
        logger('error', 'Credentials', `Failed to decrypt credentials: ${e.message}`)
      }
      this.credentials = new Map()
    }
  }

  async save() {
    if (this._saveTimeout) return
    
    this._saveTimeout = setTimeout(async () => {
      this._saveTimeout = null
      try {
        const plainText = JSON.stringify(Object.fromEntries(this.credentials))
        const iv = crypto.randomBytes(16)
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
        
        const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
        const tag = cipher.getAuthTag()
        
        await fs.mkdir('./.cache', { recursive: true })
        await fs.writeFile(this.filePath, Buffer.concat([iv, tag, encrypted]))
      } catch (e) {
        logger('error', 'Credentials', `Failed to save credentials: ${e.message}`)
      }
    }, 1000)
  }

  async forceSave() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout)
      this._saveTimeout = null
    }

    try {
      const plainText = JSON.stringify(Object.fromEntries(this.credentials))
      const iv = crypto.randomBytes(16)
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
      
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      
      await fs.mkdir('./.cache', { recursive: true })
      await fs.writeFile(this.filePath, Buffer.concat([iv, tag, encrypted]))
      logger('debug', 'Credentials', 'Force saved credentials to disk.')
    } catch (e) {
      logger('error', 'Credentials', `Failed to force save credentials: ${e.message}`)
    }
  }

  get(key) {
    const entry = this.credentials.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.credentials.delete(key)
      return null
    }
    return entry.value
  }

  set(key, value, ttlMs = 0) {
    this.credentials.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null
    })
    this.save()
  }
}
