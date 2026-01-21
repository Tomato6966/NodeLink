import crypto from 'node:crypto'
import { http1makeRequest, logger } from '../../utils.js'

export default class SegmentFetcher {
  constructor(options = {}) {
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.keyMap = new Map()
  }

  async _fetchResource(uri, byteRange = null) {
    const headers = { ...this.headers }
    if (byteRange) {
      const end = byteRange.offset + byteRange.length - 1
      headers.Range = `bytes=${byteRange.offset}-${end}`
    }

    const { body, error, statusCode } = await http1makeRequest(uri, {
      headers,
      responseType: 'buffer',
      localAddress: this.localAddress,
      timeout: 15000
    })

    if (error || (statusCode !== 200 && statusCode !== 206)) {
      throw new Error(`Failed to fetch resource from ${uri}: ${statusCode} ${error?.message || ''}`)
    }

    return body
  }

  async fetchKey(keyInfo) {
    if (!keyInfo || keyInfo.method === 'NONE') return null
    let keyData = this.keyMap.get(keyInfo.uri)
    if (keyData) return keyData

    const body = await this._fetchResource(keyInfo.uri)
    this.keyMap.set(keyInfo.uri, body)
    return body
  }

  async fetchMap(mapInfo) {
    if (!mapInfo) return null
    return await this._fetchResource(mapInfo.uri, mapInfo.byteRange)
  }

  async fetchSegment(segment) {
    const body = await this._fetchResource(segment.url, segment.byteRange)

    let data = body
    if (segment.key && segment.key.method === 'AES-128') {
      const keyData = await this.fetchKey(segment.key)
      if (keyData) {
        const iv = segment.key.iv || this._getIv(segment.sequence)
        const decipher = crypto.createDecipheriv('aes-128-cbc', keyData, iv)
        decipher.setAutoPadding(false)
        data = Buffer.concat([decipher.update(body), decipher.final()])
      }
    }

    return data
  }

  _getIv(sequence) {
    const iv = Buffer.alloc(16)
    iv.writeBigUInt64BE(BigInt(sequence), 8)
    return iv
  }
}
