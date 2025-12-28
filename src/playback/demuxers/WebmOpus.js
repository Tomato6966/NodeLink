import { Transform } from 'node:stream'
import { logger } from '../../utils.js'
import { RingBuffer } from '../RingBuffer.js'

const TOO_SHORT = Symbol('TOO_SHORT')
const INVALID_VINT = Symbol('INVALID_VINT')
const BUFFER_SIZE = 2 * 1024 * 1024

const TAGS = Object.freeze({
  '1a45dfa3': true,
  18538067: true,
  '1f43b675': true,
  '1654ae6b': true,
  '1c53bb6b': false,
  '1254c367': false,
  ae: true,
  d7: false,
  83: false,
  a3: false,
  '63a2': false,
  e7: false,
  a0: true,
  a1: false
})

const OPUS_HEAD = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])
const MAX_TAG_SIZE = 10 * 1024 * 1024

const readVintLength = (buf, i) => {
  if (i < 0 || i >= buf.length) return TOO_SHORT
  if (buf[i] === 0) return INVALID_VINT
  let n = 0
  for (; n < 8; n++) if ((1 << (7 - n)) & buf[i]) break
  n++
  return i + n > buf.length ? TOO_SHORT : n
}

const readVint = (buf, start, end) => {
  const len = readVintLength(buf, start)
  if (len === TOO_SHORT || len === INVALID_VINT || end > buf.length)
    return TOO_SHORT
  const mask = (1 << (8 - len)) - 1
  let value = BigInt(buf[start] & mask)
  for (let i = start + 1; i < end; i++) value = (value << 8n) | BigInt(buf[i])
  return value
}

class WebmBaseDemuxer extends Transform {
  constructor(options = {}) {
    super({ readableObjectMode: true, ...options })
    this.on('error', (err) => logger('error', 'WebmDemuxer', `Stream error: ${err.message} (${err.code})`))
    this.ringBuffer = new RingBuffer(BUFFER_SIZE)
    this.total = 0n
    this.processed = 0n
    this.skipUntil = null
    this.currentTrack = null
    this.pendingTrack = {}
    this.ebmlFound = false
  }

  _transform(chunk, _, done) {
    if (!chunk?.length) return done()

    this.ringBuffer.write(chunk)
    this.total += BigInt(chunk.length)

    if (this.skipUntil !== null) {
      const remainingToSkip = this.skipUntil - this.processed
      const bufferLen = BigInt(this.ringBuffer.length)
      const toSkip = remainingToSkip < bufferLen ? remainingToSkip : bufferLen

      if (toSkip > 0n) {
        const skipNum =
          toSkip > BigInt(Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : Number(toSkip)
        this.ringBuffer.skip(skipNum)
        this.processed += BigInt(skipNum)
      }
      if (this.processed < this.skipUntil) return done()
      this.skipUntil = null
    }

    while (true) {
      const currentData = this.ringBuffer.getContiguous(this.ringBuffer.length)
      if (!currentData) break

      let res
      try {
        res = this._readTag(currentData, 0)
      } catch (err) {
        logger('error', 'WebmDemuxer', `Error in _readTag: ${err.message}`)
        done(err)
        return
      }

      if (res === TOO_SHORT) break

      if (res._skipUntil) {
        this.skipUntil = res._skipUntil
        this.ringBuffer.skip(this.ringBuffer.length)
        this.processed += BigInt(this.ringBuffer.length)
        break
      }

      if (res.offset) {
        const offset = BigInt(res.offset)
        const skipNum =
          offset > BigInt(Number.MAX_SAFE_INTEGER)
            ? Number.MAX_SAFE_INTEGER
            : Number(offset)
        this.ringBuffer.skip(skipNum)
        this.processed += BigInt(skipNum)
      } else {
        break
      }
    }

    if (this.total > 1000000000n && !this.skipUntil) {
      this.total = this.processed = 0n
    }

    done()
  }

  _readEBMLId(chunk, offset) {
    const len = readVintLength(chunk, offset)
    if (len === TOO_SHORT) return TOO_SHORT
    if (len === INVALID_VINT) return INVALID_VINT
    return { id: chunk.subarray(offset, offset + len), offset: offset + len }
  }

  _readTagSize(chunk, offset) {
    const len = readVintLength(chunk, offset)
    if (len === TOO_SHORT) return TOO_SHORT
    if (len === INVALID_VINT) return INVALID_VINT
    const dataLen = readVint(chunk, offset, offset + len)
    return { offset: offset + len, dataLen, vintLen: len }
  }

  _readTag(chunk, offset) {
    const idData = this._readEBMLId(chunk, offset)
    if (idData === TOO_SHORT) return TOO_SHORT
    if (idData === INVALID_VINT) {
      return { offset: 1 }
    }

    const tag = idData.id.toString('hex')
    if (!this.ebmlFound) {
      if (tag === '1a45dfa3' || tag === '1f43b675') {
        logger('debug', 'WebmDemuxer', `Header found: ${tag}`)
        this.ebmlFound = true
      } else {
        return { offset: 1 }
      }
    }

    let currentOffset = idData.offset
    const sizeData = this._readTagSize(chunk, currentOffset)
    if (sizeData === TOO_SHORT) return TOO_SHORT
    if (sizeData === INVALID_VINT) {
      return { offset: 1 }
    }

    const { dataLen, vintLen } = sizeData

    if (tag !== '18538067' && dataLen > BigInt(MAX_TAG_SIZE)) {
      const isUnknownSize = dataLen === 2n ** BigInt(7 * vintLen) - 1n
      if (!isUnknownSize) {
        return { offset: 1 }
      }
    }

    currentOffset = sizeData.offset

    if (!(tag in TAGS)) {
      const isUnknownSize = dataLen === 2n ** BigInt(7 * vintLen) - 1n
      const numDataLen = Number(dataLen)

      if (isUnknownSize) {
        return { offset: 1 }
      }

      if (chunk.length > currentOffset + numDataLen)
        return { offset: currentOffset + numDataLen }
      return {
        offset: currentOffset,
        _skipUntil: this.processed + BigInt(currentOffset + numDataLen)
      }
    }

    const hasChildren = TAGS[tag]
    if (hasChildren) return { offset: currentOffset }

    const numDataLen = Number(dataLen)
    if (currentOffset + numDataLen > chunk.length) return TOO_SHORT
    const data = chunk.subarray(currentOffset, currentOffset + numDataLen)

    if (!this.currentTrack) {
      if (tag === 'ae') this.pendingTrack = {}
      if (tag === 'd7') this.pendingTrack.number = data[0]
      if (tag === '83') this.pendingTrack.type = data[0]
      if (
        this.pendingTrack.type === 2 &&
        this.pendingTrack.number !== undefined
      )
        this.currentTrack = this.pendingTrack
    }

    if (tag === '63a2') {
      try {
        this._checkHead(data)
        this.emit('head', data)
      } catch (e) {}
    } else if (tag === 'a3') {
      if (this.currentTrack && (data[0] & 0xf) === this.currentTrack.number) {
        this.push(data.subarray(4))
      }
    }

    return { offset: currentOffset + numDataLen }
  }

  _destroy(err, cb) {
    this._cleanup()
    cb?.(err)
  }

  _final(cb) {
    this._cleanup()
    cb()
  }

  _cleanup() {
    this.ringBuffer.dispose()
    this.pendingTrack = {}
    this.currentTrack = null
    this.ebmlFound = false
    this.skipUntil = null
  }
}

export class WebmOpusDemuxer extends WebmBaseDemuxer {
  _checkHead(data) {
    if (!data.subarray(0, 8).equals(OPUS_HEAD)) {
      throw new Error('Expected Opus audio stream')
    }
  }
}

export default WebmOpusDemuxer
