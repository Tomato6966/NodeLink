import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { http1makeRequest, logger } from '../../utils.js'

class DecryptTransform extends Transform {
  constructor(algorithm, key, iv) {
    super()
    this.decipher = crypto.createDecipheriv(algorithm, key, iv)
    this.decipher.setAutoPadding(false)
  }
  _transform(chunk, encoding, callback) {
    try { this.push(this.decipher.update(chunk)); callback() }
    catch (err) { callback(err) }
  }
  _flush(callback) {
    try { this.push(this.decipher.final()); callback() }
    catch (err) { callback(err) }
  }
}

export default class SegmentFetcher {
  constructor(options = {}) {
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.keyMap = new Map()
  }

  async fetchKey(keyInfo) {
    if (!keyInfo || keyInfo.method === 'NONE') return null
    if (this.keyMap.has(keyInfo.uri)) return this.keyMap.get(keyInfo.uri)
        const { body, error, statusCode } = await http1makeRequest(keyInfo.uri, {
          headers: this.headers, responseType: 'buffer', localAddress: this.localAddress
        })
    
        if (error || statusCode !== 200 || !body || body.length === 0) {
          logger('error', 'SegmentFetcher', `Key fetch failed for ${keyInfo.uri}: Status ${statusCode}, Error: ${error?.message || 'Empty Body'}`)
          throw new Error(`Key fetch failed: ${statusCode}`)
        }
        this.keyMap.set(keyInfo.uri, body)
    return body
  }

  async fetchMap(mapInfo, keyInfo = null) {
    if (!mapInfo) return null
    const { body, error, statusCode } = await http1makeRequest(mapInfo.uri, {
      headers: this.headers, responseType: 'buffer', localAddress: this.localAddress
    })
    if (error || statusCode !== 200) throw new Error(`Map fetch failed: ${statusCode}`)
    if (keyInfo && keyInfo.iv && body.length % 16 === 0) {
      const keyData = await this.fetchKey(keyInfo)
      const algorithm = keyInfo.method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'
      const decipher = crypto.createDecipheriv(algorithm, keyData, keyInfo.iv)
      decipher.setAutoPadding(false)
      return Buffer.concat([decipher.update(body), decipher.final()])
    }
    return body
  }

  async fetchSegment(segment, options = { stream: true }) {
    const headers = { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...this.headers 
    }
    if (segment.byteRange) {
      const end = segment.byteRange.offset + segment.byteRange.length - 1
      headers.Range = `bytes=${segment.byteRange.offset}-${end}`
    }

    const { body, stream, error, statusCode } = await http1makeRequest(segment.url, {
      headers,
      responseType: options.stream ? undefined : 'buffer',
      streamOnly: options.stream,
      localAddress: this.localAddress,
      timeout: 15000
    })

    if (error || (statusCode !== 200 && statusCode !== 206)) throw new Error(`Segment failed: ${statusCode}`)

    if (segment.key && segment.key.method !== 'NONE') {
      const keyData = await this.fetchKey(segment.key)
      const iv = segment.key.iv || this._getIv(segment.sequence)
      const algorithm = segment.key.method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'
      
      logger('debug', 'SegmentFetcher', `Decrypting segment ${segment.sequence} (Key: ${keyData ? 'OK' : 'FAIL'}, IV: ${iv.toString('hex')})`)

      if (options.stream) {
        return stream.pipe(new DecryptTransform(algorithm, keyData, iv))
      } else {
        const decipher = crypto.createDecipheriv(algorithm, keyData, iv)
        decipher.setAutoPadding(false)
        return Buffer.concat([decipher.update(body), decipher.final()])
      }
    }
    return options.stream ? stream : body
  }

  _getIv(sequence) {
    const iv = Buffer.alloc(16)
    iv.writeBigUInt64BE(BigInt(sequence), 8)
    return iv
  }
}