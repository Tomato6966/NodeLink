import { Transform } from 'node:stream'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const OPUS_CTL = {
  BITRATE: 4002,
  FEC: 4012,
  PLP: 4014
}

const LIBS = [
  { name: '@discordjs/opus', pick: (m) => m.OpusEncoder },
  { name: 'node-opus', pick: (m) => m.OpusEncoder },
  { name: 'opusscript', pick: (m) => m }
]

const loadLib = () => {
  for (const l of LIBS) {
    try {
      const mod = require(l.name)
      return { name: l.name, Encoder: l.pick(mod) }
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e
    }
  }
  throw new Error('No compatible Opus library found.')
}

const createInstance = (rate, channels, app, cached = null) => {
  const lib = cached ?? loadLib()
  const { name, Encoder } = lib
  const a =
    name === 'opusscript' && typeof app === 'string'
      ? Encoder.Application[app]
      : app
  return { instance: new Encoder(rate, channels, a), lib }
}

const ctl = (enc, id, val, lib) => {
  if (!enc) throw new Error('Encoder not ready.')
  const fn = enc.applyEncoderCTL || enc.encoderCTL
  if (typeof fn !== 'function') return
  fn.call(enc, id, val)
}

export class Encoder extends Transform {
  constructor({
    rate = 48000,
    channels = 2,
    frameSize = 960,
    application = 'audio'
  } = {}) {
    super({ readableObjectMode: true })
    const { instance, lib } = createInstance(rate, channels, application)
    this.enc = instance
    this.lib = lib
    this.frame = frameSize
    this.ch = channels
    this.size = frameSize * channels * 2
    this.buf = Buffer.alloc(0)
  }

  _transform(chunk, _, cb) {
    try {
      this.buf = Buffer.concat([this.buf, chunk])
      while (this.buf.length >= this.size) {
        const pcm = this.buf.subarray(0, this.size)
        this.buf = this.buf.subarray(this.size)
        const data = this.enc.encode(pcm, this.frame)
        this.push(data)
      }
      cb()
    } catch (e) {
      cb(new Error(`Encode failed: ${e.message}`))
    }
  }

  _destroy(err, cb) {
    if (this.lib.name === 'opusscript' && this.enc?.delete) this.enc.delete()
    this.enc = null
    cb(err)
  }

  setBitrate(v) {
    ctl(
      this.enc,
      OPUS_CTL.BITRATE,
      Math.min(128000, Math.max(16000, v)),
      this.lib.name
    )
  }

  setFEC(v) {
    ctl(this.enc, OPUS_CTL.FEC, v ? 1 : 0, this.lib.name)
  }

  setPLP(v) {
    ctl(
      this.enc,
      OPUS_CTL.PLP,
      Math.min(100, Math.max(0, v * 100)),
      this.lib.name
    )
  }
}

export class Decoder extends Transform {
  constructor({ rate = 48000, channels = 2, frameSize = 960 } = {}) {
    super({ readableObjectMode: true })
    const { instance, lib } = createInstance(rate, channels, 'voip')
    this.dec = instance
    this.lib = lib
    this.frame = frameSize
  }

  _transform(chunk, _, cb) {
    try {
      const f = this.lib.name === 'opusscript' ? null : this.frame
      const pcm = this.dec.decode(chunk, f)
      this.push(pcm)
      cb()
    } catch (e) {
      cb(new Error(`Decode failed: ${e.message}`))
    }
  }

  _destroy(err, cb) {
    if (this.lib.name === 'opusscript' && this.dec?.delete) this.dec.delete()
    this.dec = null
    cb(err)
  }
}
