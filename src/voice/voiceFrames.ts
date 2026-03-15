import { Buffer } from 'node:buffer'
import type {
  ParsedVoiceFrameHeader,
  ResolvedVoiceFormat
} from '../typings/voice/voice.types.ts'

/**
 * Voice frame operation codes.
 */
export const VOICE_FRAME_OPS = {
  start: 1,
  stop: 2,
  data: 3
} as const

/**
 * Supported voice formats.
 */
export const VOICE_FORMATS = {
  opus: 0,
  ogg: 1,
  pcm_s16le: 2
} as const

const EMPTY_BUFFER = Buffer.alloc(0)
const SUPPORTED_FORMATS = new Set(['opus', 'pcm_s16le'])

/**
 * Resolves the voice format based on the provided input.
 *
 * @param format - The voice format string to resolve.
 * @param logger - Optional logger function to log warnings.
 * @returns The resolved voice format with its name and code.
 */
export function resolveVoiceFormat(
  format: string | null | undefined,
  logger?: (level: string, module: string, message: string) => void
): ResolvedVoiceFormat {
  const normalized = String(format || 'opus').toLowerCase()
  if (SUPPORTED_FORMATS.has(normalized)) {
    return {
      name: normalized,
      code: VOICE_FORMATS[normalized as keyof typeof VOICE_FORMATS]
    }
  }

  if (logger) {
    logger(
      'warn',
      'Voice',
      `Unsupported voiceReceive.format "${format}", using "opus".`
    )
  }

  return { name: 'opus', code: VOICE_FORMATS.opus }
}

/**
 * Builds a voice frame buffer.
 *
 * @param op - The operation code of the frame.
 * @param formatCode - The format code of the payload.
 * @param guildId - The ID of the guild.
 * @param userId - The ID of the user.
 * @param ssrc - The SSRC identifier.
 * @param timestamp - The timestamp of the frame.
 * @param payload - The payload buffer (default is empty).
 * @returns The constructed voice frame as a Buffer.
 * @throws {Error} If guildId or userId length exceeds 255 bytes.
 */
export function buildVoiceFrame(
  op: number,
  formatCode: number,
  guildId: string,
  userId: string,
  ssrc: number,
  timestamp: number,
  payload: Buffer = EMPTY_BUFFER
): Buffer {
  const guildBuf = Buffer.from(String(guildId || ''), 'utf8')
  const userBuf = Buffer.from(String(userId || ''), 'utf8')

  if (guildBuf.length > 255 || userBuf.length > 255) {
    throw new Error('Voice frame id too long.')
  }

  const payloadBuf = payload?.length ? payload : EMPTY_BUFFER
  const totalLength =
    1 + 1 + 1 + guildBuf.length + 1 + userBuf.length + 4 + 4 + payloadBuf.length

  const buf = Buffer.allocUnsafe(totalLength)
  let offset = 0

  buf.writeUInt8(op, offset++)
  buf.writeUInt8(formatCode, offset++)
  buf.writeUInt8(guildBuf.length, offset++)
  guildBuf.copy(buf, offset)
  offset += guildBuf.length
  buf.writeUInt8(userBuf.length, offset++)
  userBuf.copy(buf, offset)
  offset += userBuf.length
  buf.writeUInt32BE(ssrc >>> 0, offset)
  offset += 4
  buf.writeUInt32BE(timestamp >>> 0, offset)
  offset += 4

  if (payloadBuf.length > 0) {
    payloadBuf.copy(buf, offset)
  }

  return buf
}

/**
 * Parses the header of a voice frame.
 *
 * @param buf - The buffer containing the voice frame.
 * @returns The parsed voice frame header or null if invalid.
 */
export function parseVoiceFrameHeader(
  buf: Buffer
): ParsedVoiceFrameHeader | null {
  if (!buf || buf.length < 8) return null
  let offset = 0

  const op = buf.readUInt8(offset++)
  const format = buf.readUInt8(offset++)

  if (offset >= buf.length) return null
  const guildLen = buf.readUInt8(offset++)
  if (offset + guildLen > buf.length) return null
  const guildId = buf.toString('utf8', offset, offset + guildLen)
  offset += guildLen

  if (offset >= buf.length) return null
  const userLen = buf.readUInt8(offset++)
  if (offset + userLen > buf.length) return null
  const userId = buf.toString('utf8', offset, offset + userLen)
  offset += userLen

  if (offset + 8 > buf.length) return null
  const ssrc = buf.readUInt32BE(offset)
  offset += 4
  const timestamp = buf.readUInt32BE(offset)
  offset += 4

  return {
    op,
    format,
    guildId,
    userId,
    ssrc,
    timestamp,
    payloadOffset: offset
  }
}
