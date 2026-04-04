import crypto from 'node:crypto'
import { logger } from '../../utils.ts'

/**
 * Decrypts AES-encrypted HLS segment data.
 * Supports AES-128-CBC and AES-256-CBC.
 */
export function decryptAES(
  data: Buffer,
  key: Buffer | null,
  iv: Buffer | null,
  method: 'AES-128' | 'AES-256' = 'AES-128'
): Buffer {
  if (!key || !iv) return data

  try {
    const algorithm = method === 'AES-128' ? 'aes-128-cbc' : 'aes-256-cbc'

    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    decipher.setAutoPadding(false)

    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch (err) {
    const error = err as Error
    logger('error', 'AESDecryptor', `Decryption failed: ${error.message}`)
    return data
  }
}

/**
 * Derives IV from HLS media sequence number.
 * RFC 8216 §5.2 compliant.
 */
export function deriveIV(sequence: number): Buffer {
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(sequence), 8)
  return iv
}
