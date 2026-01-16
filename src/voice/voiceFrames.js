const VOICE_FRAME_OPS = {
  start: 1,
  stop: 2,
  data: 3
}

const VOICE_FORMATS = {
  opus: 0,
  ogg: 1,
  pcm_s16le: 2
}

const EMPTY_BUFFER = Buffer.alloc(0)
const SUPPORTED_FORMATS = new Set(['opus', 'pcm_s16le'])

function resolveVoiceFormat(format, logger) {
  const normalized = String(format || 'opus').toLowerCase()
  if (SUPPORTED_FORMATS.has(normalized)) {
    return { name: normalized, code: VOICE_FORMATS[normalized] }
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

function buildVoiceFrame(
  op,
  formatCode,
  guildId,
  userId,
  ssrc,
  timestamp,
  payload = EMPTY_BUFFER
) {
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

function parseVoiceFrameHeader(buf) {
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

export {
  VOICE_FRAME_OPS,
  VOICE_FORMATS,
  resolveVoiceFormat,
  buildVoiceFrame,
  parseVoiceFrameHeader
}
