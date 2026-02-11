import crypto from 'node:crypto'
import { logger } from '../../utils.ts'

export default class AESDecryptor {
  static decrypt(data, key, iv, method = 'AES-128') {
    if (!key || !iv) return data
    
    try {
      const algorithm = method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'
      const decipher = crypto.createDecipheriv(algorithm, key, iv)
      decipher.setAutoPadding(false)
      
      return Buffer.concat([decipher.update(data), decipher.final()])
    } catch (err) {
      logger('error', 'AESDecryptor', `Decryption failed: ${err.message}`)
      return data
    }
  }

  // RFC 8216 Section 5.2: IV derivation from Media Sequence
  static deriveIV(sequence) {
    const iv = Buffer.alloc(16)
    iv.writeBigUInt64BE(BigInt(sequence), 8)
    return iv
  }
}
