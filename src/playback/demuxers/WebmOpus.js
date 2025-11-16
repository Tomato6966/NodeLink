import { Transform } from 'node:stream'

const TOO_SHORT = Symbol('TOO_SHORT')

const TAGS = Object.freeze({
  '1a45dfa3': true,
  18538067: true,
  '1f43b675': true,
  '1654ae6b': true,
  ae: true,
  d7: false,
  83: false,
  a3: false,
  '63a2': false
})

const OPUS_HEAD = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])

const readVintLength = (buf, i) => {
  if (i < 0 || i >= buf.length) return TOO_SHORT
  let n = 0
  for (; n < 8; n++) if ((1 << (7 - n)) & buf[i]) break
  n++
  return i + n > buf.length ? TOO_SHORT : n
}

const readVint = (buf, start, end) => {
  const len = readVintLength(buf, start)
  if (len === TOO_SHORT || end > buf.length) return TOO_SHORT
  let mask = (1 << (8 - len)) - 1
  let value = buf[start] & mask
  for (let i = start + 1; i < end; i++) value = (value << 8) | buf[i]
  return value
}

class WebmBaseDemuxer extends Transform {
  constructor(options = {}) {
    super({ readableObjectMode: true, ...options })
    this.remainder = null
    this.total = 0
    this.processed = 0
    this.skipUntil = null
    this.currentTrack = null
    this.pendingTrack = {}
    this.ebmlFound = false
  }

  _transform(chunk, _, done) {
    if (!chunk?.length) return done()

    this.total += chunk.length
    if (this.remainder) {
      chunk = Buffer.concat([this.remainder, chunk])
      this.remainder = null
    }

    let offset = 0
    if (this.skipUntil && this.total > this.skipUntil) {
      offset = this.skipUntil - this.processed
      this.skipUntil = null
    } else if (this.skipUntil) {
      this.processed += chunk.length
      done()
      return
    }

    let res
    while (res !== TOO_SHORT) {
      try {
        res = this._readTag(chunk, offset)
      } catch (err) {
        done(err)
        return
      }
      if (res === TOO_SHORT) break
      if (res._skipUntil) {
        this.skipUntil = res._skipUntil
        break
      }
      if (res.offset) offset = res.offset
      else break
    }

    this.processed += offset
    this.remainder = offset < chunk.length ? chunk.subarray(offset) : null

    if (this.total > 1e9 && !this.skipUntil) {
      this.total = this.processed = 0
    }

    done()
  }

  _readEBMLId(chunk, offset) {
    const len = readVintLength(chunk, offset)
    if (len === TOO_SHORT) return TOO_SHORT
    return { id: chunk.subarray(offset, offset + len), offset: offset + len }
  }

  _readTagSize(chunk, offset) {
    const len = readVintLength(chunk, offset)
    if (len === TOO_SHORT) return TOO_SHORT
    const dataLen = readVint(chunk, offset, offset + len)
    return { offset: offset + len, dataLen }
  }

  _readTag(chunk, offset) {
    const idData = this._readEBMLId(chunk, offset)
    if (idData === TOO_SHORT) return TOO_SHORT

    const tag = idData.id.toString('hex')
    if (!this.ebmlFound) {
      if (tag === '1a45dfa3') this.ebmlFound = true
      else throw new Error('Invalid WebM: missing EBML header')
    }

    offset = idData.offset
    const sizeData = this._readTagSize(chunk, offset)
    if (sizeData === TOO_SHORT) return TOO_SHORT

    const { dataLen } = sizeData
    offset = sizeData.offset

    if (!(tag in TAGS)) {
      if (chunk.length > offset + dataLen) return { offset: offset + dataLen }
      return { offset, _skipUntil: this.processed + offset + dataLen }
    }

    const hasChildren = TAGS[tag]
    if (hasChildren) return { offset }

    if (offset + dataLen > chunk.length) return TOO_SHORT
    const data = chunk.subarray(offset, offset + dataLen)

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
      this._checkHead(data)
      this.emit('head', data)
    } else if (tag === 'a3') {
      if (!this.currentTrack) throw new Error('No valid audio track found')
      if ((data[0] & 0xf) === this.currentTrack.number)
        this.push(data.subarray(4))
    }

    return { offset: offset + dataLen }
  }

  _destroy(err, cb) {
    this._cleanup()
    this.removeAllListeners()
    cb?.(err)
  }

  _final(cb) {
    this._cleanup()
    cb()
  }

  _cleanup() {
    this.remainder = null
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
