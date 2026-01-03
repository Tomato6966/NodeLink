import { Transform } from 'node:stream'
import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'

const require = createRequire(import.meta.url)

const OPUS_CTL = {
  BITRATE: 4002,
  FEC: 4012,
  PLP: 4014,
  DTX: 4016
}

const RING_SIZE = 512 * 1024
let ACTIVE_LIB = null

const _getLib = () => {
  if (ACTIVE_LIB) return ACTIVE_LIB
  const libs = [
    { name: '@toddynnn/voice-opus', pick: (m) => m.OpusEncoder },
    { name: 'toddy-mediaplex', pick: (m) => m.OpusEncoder },
    { name: '@discordjs/opus', pick: (m) => m.OpusEncoder },
    { name: 'opusscript', pick: (m) => m }
  ]

  for (const l of libs) {
    try {
      const mod = require(l.name)
      const Encoder = l.pick(mod)
      if (typeof Encoder === 'function') {
        ACTIVE_LIB = { name: l.name, Encoder }
        return ACTIVE_LIB
      }
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e
    }
  }
  throw new Error('No compatible Opus library found.')
}

const _createInstance = (rate, channels, app) => {
  const lib = _getLib()
  const { name, Encoder } = lib

  let type = app
  if (name === 'opusscript' && typeof app === 'string') {
    type = Encoder.Application[app.toUpperCase()] ?? Encoder.Application.VOIP
  }

  return { instance: new Encoder(rate, channels, type), lib }
}

const _applyCtl = (enc, libName, id, val) => {
  if (!enc) throw new Error('Encoder not ready.')

  if (id === OPUS_CTL.BITRATE) {
    return enc.setBitrate(val)
  }

  const fn = enc.applyEncoderCTL || enc.applyEncoderCtl || enc.encoderCTL
  if (typeof fn === 'function') fn.call(enc, id, val)
}

export class Encoder extends Transform {
  constructor({
    rate = 48000,
    channels = 2,
    frameSize = 960,
    application = 'audio'
  } = {}) {
    super({ readableObjectMode: true })

    const { instance, lib } = _createInstance(rate, channels, application)
    this.enc = instance
    this.lib = lib
    this.frameSize = frameSize
    this.frameBytes = frameSize * channels * 2
    this.ring = Buffer.allocUnsafe(RING_SIZE)
    this.swap = Buffer.allocUnsafe(this.frameBytes)
    this.writePos = 0
    this.readPos = 0
  }

  _transform(chunk, _, cb) {
    if (!chunk || !chunk.length) return cb()

    let wp = this.writePos
    let rp = this.readPos
    const total = chunk.length
    let remaining = total

    while (remaining > 0) {
      const space = RING_SIZE - wp
      const canWrite = remaining < space ? remaining : space
      chunk.copy(this.ring, wp, total - remaining, total - remaining + canWrite)
      remaining -= canWrite
      wp += canWrite
      if (wp === RING_SIZE) wp = 0
    }

    while (true) {
      const available = wp >= rp ? wp - rp : RING_SIZE - rp + wp
      if (available < this.frameBytes) break

      let frame
      const end = rp + this.frameBytes

      if (end <= RING_SIZE) {
        frame = this.ring.subarray(rp, end)
      } else {
        const first = RING_SIZE - rp
        this.ring.copy(this.swap, 0, rp, RING_SIZE)
        this.ring.copy(this.swap, first, 0, this.frameBytes - first)
        frame = this.swap
      }

      try {
        if (this.lib.name === 'opusscript') {
          this.push(this.enc.encode(frame, this.frameSize))
        } else {
          this.push(this.enc.encode(frame))
        }
      } catch (e) {
        this.writePos = wp
        this.readPos = rp
        return cb(new Error(`Encode failed: ${e.message}`))
      }

      rp += this.frameBytes
      if (rp >= RING_SIZE) rp -= RING_SIZE
    }

    this.writePos = wp
    this.readPos = rp
    cb()
  }

  _flush(cb) {
    this.writePos = 0
    this.readPos = 0
    cb()
  }

  _destroy(err, cb) {
    if (this.lib.name === 'opusscript' && this.enc && this.enc.delete) {
      this.enc.delete()
    }
    this.enc = null
    this.ring = null
    this.swap = null
    cb(err)
  }

  setBitrate(v) {
    const val = v < 500 ? 500 : v > 512000 ? 512000 : v
    _applyCtl(this.enc, this.lib.name, OPUS_CTL.BITRATE, val)
  }

  setFEC(enabled = true) {
    _applyCtl(this.enc, this.lib.name, OPUS_CTL.FEC, enabled ? 1 : 0)
  }

  setPLP(percent) {
    const p = percent <= 1 ? percent * 100 : percent
    const val = p < 0 ? 0 : p > 100 ? 100 : Math.round(p)
    _applyCtl(this.enc, this.lib.name, OPUS_CTL.PLP, val)
  }
  setDTX(enabled = false) {
    _applyCtl(this.enc, this.lib.name, OPUS_CTL.DTX, enabled ? 1 : 0)
  }
}

export class Decoder extends Transform {
  constructor({ rate = 48000, channels = 2 } = {}) {
    super({ readableObjectMode: false })
    const { instance, lib } = _createInstance(rate, channels, 'voip')
    this.dec = instance
    this.lib = lib
  }

  _transform(chunk, _, cb) {
    try {
      this.push(this.dec.decode(chunk))
      cb()
    } catch (e) {
      cb(new Error(`Decode failed: ${e.message}`))
    }
  }

  _destroy(err, cb) {
    if (this.lib.name === 'opusscript' && this.dec && this.dec.delete) {
      this.dec.delete()
    }
    this.dec = null
    cb(err)
  }
}
