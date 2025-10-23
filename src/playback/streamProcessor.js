import { FiltersManager } from './filtersManager.js'
import { PassThrough, Readable, Transform } from 'node:stream'
import prism from 'prism-media'
import { createRequire } from 'node:module'
import * as MP4Box from 'mp4box'
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js'
import { FLACDecoder } from '@wasm-audio-decoders/flac'
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis'
import { SeekeableNode } from '@ecliptia/seekeable-node'
import { SupportedFormats, normalizeFormat } from '../constants.js'

const require = createRequire(import.meta.url)
const { MPEGDecoder } = require('mpg123-decoder')
const LibSampleRate = require('@alexanderolsen/libsamplerate-js')

class BaseAudioResource {
  constructor() {
    this.pipes = []
    this.stream = null
  }

  _end() {
    if (!this.pipes) return

    for (const pipe of this.pipes) {
      pipe.unpipe?.()
      pipe.destroy?.()
      pipe.removeAllListeners?.()
    }

    this.stream = null
    this.pipes = null
  }

  destroy() {
    this._end()
    if (this.seekeable) {
      this.seekeable.destroy()
    }
  }

  setVolume(volume) {
    if (!this.pipes) return

    const volumeTransformer = this.pipes.find(
      (pipe) => pipe instanceof prism.VolumeTransformer
    )
    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    } else {
      throw new Error('VolumeTransformer not found in the pipeline.')
    }
  }

  setFilters(filters) {
    if (!this.pipes) return

    const filterTransformer = this.pipes.find(
      (pipe) => pipe instanceof FiltersManager
    )

    if (filterTransformer) {
      filterTransformer.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }

  emit(event, ...args) {
    this.stream.emit(event, ...args)
  }
  on(event, listener) {
    this.stream.on(event, listener)
  }
  off(event, listener) {
    this.stream.off(event, listener)
  }
  once(event, listener) {
    this.stream.once(event, listener)
  }
  removeListener(event, listener) {
    this.stream.removeListener(event, listener)
  }
  removeAllListeners() {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      for (const listener of this.stream.listeners(eventName)) {
        this.stream.removeListener(eventName, listener)
      }
    }
  }
  read() {
    return this.stream?.read()
  }
  resume() {
    this.stream?.resume()
  }
}

class MpegDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new MPEGDecoder()
    this.resampler = null
    this.isDecoderReady = false

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this.emit('decoderReady')
      })
      .catch((err) => this.emit('error', err))
  }

  _transform(chunk, encoding, callback) {
    if (!this.isDecoderReady) {
      this.once('decoderReady', () =>
        this._transform(chunk, encoding, callback)
      )
      return
    }

    try {
      const { channelData, samplesDecoded, sampleRate, channels } =
        this.decoder.decode(chunk)

      if (samplesDecoded > 0) {
        if (sampleRate === 48000) {
          this._process(channelData, channels, callback)
        } else if (this.resampler) {
          this._resample(channelData, channels, callback)
        } else {
          LibSampleRate.create(2, sampleRate, 48000, {
            converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY
          })
            .then((src) => {
              this.resampler = src
              this._resample(channelData, channels, callback)
            })
            .catch((err) => {
              callback()
            })
        }
      } else {
        callback()
      }
    } catch (e) {
      callback(e)
    }
  }

  _process(channelData, channels, callback) {
    const sampleCount = channelData[0].length
    const pcm = new Int16Array(sampleCount * 2)
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL

    for (let i = 0; i < sampleCount; i++) {
      pcm[i * 2] = Math.max(-1, Math.min(1, floatL[i])) * 32767
      pcm[i * 2 + 1] = Math.max(-1, Math.min(1, floatR[i])) * 32767
    }

    this.push(Buffer.from(pcm.buffer))
    callback()
  }

  _resample(channelData, channels, callback) {
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL
    const interleaved = new Float32Array(floatL.length * 2)

    for (let i = 0; i < floatL.length; i++) {
      interleaved[i * 2] = floatL[i]
      interleaved[i * 2 + 1] = floatR[i]
    }

    const resampled = this.resampler.full(interleaved)
    const pcmInt16 = new Int16Array(resampled.length)

    for (let i = 0; i < resampled.length; i++) {
      pcmInt16[i] = Math.max(-1, Math.min(1, resampled[i])) * 32767
    }

    this.push(Buffer.from(pcmInt16.buffer))
    callback()
  }

  _flush(callback) {
    if (this.resampler) {
      this.resampler.destroy()
    }
    if (this.decoder) {
      this.decoder.free()
    }
    callback()
  }
}

class FLACDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new FLACDecoder()
    this.resampler = null
    this.isDecoderReady = false

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this.emit('decoderReady')
      })
      .catch((err) => this.emit('error', err))
  }

  async _transform(chunk, encoding, callback) {
    if (!this.isDecoderReady) {
      this.once('decoderReady', () =>
        this._transform(chunk, encoding, callback)
      )
      return
    }

    try {
      const result = await this.decoder.decode(chunk)

      if (result && result.samplesDecoded > 0) {
        const { channelData, samplesDecoded, sampleRate } = result
        const channels = channelData.length

        if (sampleRate === 48000) {
          this._process(channelData, channels, samplesDecoded, callback)
        } else if (this.resampler) {
          this._resample(
            channelData,
            channels,
            samplesDecoded,
            sampleRate,
            callback
          )
        } else {
          try {
            this.resampler = await LibSampleRate.create(2, sampleRate, 48000, {
              converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY
            })
            this._resample(
              channelData,
              channels,
              samplesDecoded,
              sampleRate,
              callback
            )
          } catch (err) {
            callback()
          }
        }
      } else {
        callback()
      }
    } catch (e) {
      callback()
    }
  }

  _process(channelData, channels, samplesDecoded, callback) {
    const pcm = new Int16Array(samplesDecoded * 2)
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL

    for (let i = 0; i < samplesDecoded; i++) {
      pcm[i * 2] = Math.max(-1, Math.min(1, floatL[i])) * 32767
      pcm[i * 2 + 1] = Math.max(-1, Math.min(1, floatR[i])) * 32767
    }

    this.push(Buffer.from(pcm.buffer))
    callback()
  }

  _resample(channelData, channels, samplesDecoded, sampleRate, callback) {
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL
    const interleaved = new Float32Array(samplesDecoded * 2)

    for (let i = 0; i < samplesDecoded; i++) {
      interleaved[i * 2] = floatL[i]
      interleaved[i * 2 + 1] = floatR[i]
    }

    const resampled = this.resampler.full(interleaved)
    const pcmInt16 = new Int16Array(resampled.length)

    for (let i = 0; i < resampled.length; i++) {
      pcmInt16[i] = Math.max(-1, Math.min(1, resampled[i])) * 32767
    }

    this.push(Buffer.from(pcmInt16.buffer))
    callback()
  }

  async _flush(callback) {
    try {
      const result = await this.decoder.flush()
      if (result && result.samplesDecoded > 0) {
        const { channelData, samplesDecoded, sampleRate } = result
        const channels = channelData.length

        if (sampleRate === 48000) {
          this._process(channelData, channels, samplesDecoded, () => {})
        } else if (this.resampler) {
          this._resample(
            channelData,
            channels,
            samplesDecoded,
            sampleRate,
            () => {}
          )
        }
      }
    } catch (err) {}

    if (this.resampler) this.resampler.destroy?.()
    if (this.decoder) this.decoder.free?.()
    callback()
  }
}

class OggVorbisDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new OggVorbisDecoder()
    this.resampler = null
    this.isDecoderReady = false

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this.emit('decoderReady')
      })
      .catch((err) => this.emit('error', err))
  }

  async _transform(chunk, encoding, callback) {
    if (!this.isDecoderReady) {
      this.once('decoderReady', () =>
        this._transform(chunk, encoding, callback)
      )
      return
    }

    try {
      const result = await this.decoder.decode(chunk)

      if (result && result.samplesDecoded > 0) {
        const { channelData, samplesDecoded, sampleRate } = result
        const channels = channelData.length

        if (sampleRate === 48000) {
          this._process(channelData, channels, samplesDecoded, callback)
        } else if (this.resampler) {
          this._resample(
            channelData,
            channels,
            samplesDecoded,
            sampleRate,
            callback
          )
        } else {
          try {
            this.resampler = await LibSampleRate.create(2, sampleRate, 48000, {
              converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY
            })
            this._resample(
              channelData,
              channels,
              samplesDecoded,
              sampleRate,
              callback
            )
          } catch (err) {
            callback()
          }
        }
      } else {
        callback()
      }
    } catch (e) {
      callback()
    }
  }

  _process(channelData, channels, samplesDecoded, callback) {
    const pcm = new Int16Array(samplesDecoded * 2)
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL

    for (let i = 0; i < samplesDecoded; i++) {
      pcm[i * 2] = Math.max(-1, Math.min(1, floatL[i])) * 32767
      pcm[i * 2 + 1] = Math.max(-1, Math.min(1, floatR[i])) * 32767
    }

    this.push(Buffer.from(pcm.buffer))
    callback()
  }

  _resample(channelData, channels, samplesDecoded, sampleRate, callback) {
    const floatL = channelData[0]
    const floatR = channels > 1 ? channelData[1] : floatL
    const interleaved = new Float32Array(samplesDecoded * 2)

    for (let i = 0; i < samplesDecoded; i++) {
      interleaved[i * 2] = floatL[i]
      interleaved[i * 2 + 1] = floatR[i]
    }

    const resampled = this.resampler.full(interleaved)
    const pcmInt16 = new Int16Array(resampled.length)

    for (let i = 0; i < resampled.length; i++) {
      pcmInt16[i] = Math.max(-1, Math.min(1, resampled[i])) * 32767
    }

    this.push(Buffer.from(pcmInt16.buffer))
    callback()
  }

  async _flush(callback) {
    try {
      const result = await this.decoder.flush()
      if (result && result.samplesDecoded > 0) {
        const { channelData, samplesDecoded, sampleRate } = result
        const channels = channelData.length

        if (sampleRate === 48000) {
          this._process(channelData, channels, samplesDecoded, () => {})
        } else if (this.resampler) {
          this._resample(
            channelData,
            channels,
            samplesDecoded,
            sampleRate,
            () => {}
          )
        }
      }
    } catch (err) {}

    if (this.resampler) this.resampler.destroy?.()
    if (this.decoder) this.decoder.free?.()
    callback()
  }
}

class MPEGTSToAACStream extends Transform {
  constructor(options) {
    super(options)
    this.buffer = Buffer.alloc(0)
    this.patPmtId = null
    this.aacPid = null
    this.aacData = Buffer.alloc(0)
    this.packetsProcessed = 0
    this.aacPidFound = false
  }

  _transform(chunk, encoding, callback) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])
      const len = this.buffer.length
      let pos = 0

      while (pos <= len - 188) {
        if (this.buffer[pos] !== 0x47) {
          const syncIndex = this.buffer.indexOf(0x47, pos + 1)
          if (syncIndex === -1) {
            this.buffer = Buffer.alloc(0)
            break
          }
          pos = syncIndex
          continue
        }

        const packet = this.buffer.slice(pos, pos + 188)
        this.packetsProcessed++

        const pusi = !!(packet[1] & 0x40)
        const pid = ((packet[1] & 0x1f) << 8) + packet[2]
        const atf = (packet[3] & 0x30) >> 4

        let offset = 4
        if (atf > 1) {
          const atflen = packet[4]
          offset = 5 + atflen
          if (offset >= 188) {
            pos += 188
            continue
          }
        }

        if (pid === 0 && pusi) {
          offset += packet[offset] + 1
          this.patPmtId =
            ((packet[offset + 10] & 0x1f) << 8) | packet[offset + 11]
        } else if (this.patPmtId && pid === this.patPmtId && pusi) {
          offset += packet[offset] + 1
          const foundPid = this._parsePMT(packet, offset)
          if (foundPid && !this.aacPidFound) {
            this.aacPid = foundPid
            this.aacPidFound = true
          }
        } else if (this.aacPid && pid === this.aacPid) {
          if (pusi) {
            if (this.aacData.length > 0) {
              this.push(this.aacData)
              this.aacData = Buffer.alloc(0)
            }
            const pesHeaderLength = packet[offset + 8]
            offset += 9 + pesHeaderLength
            if (offset >= 188) {
              pos += 188
              continue
            }
          }
          const payload = packet.slice(offset)
          this.aacData = Buffer.concat([this.aacData, payload])
        }

        pos += 188
      }

      this.buffer = this.buffer.slice(pos)
      callback()
    } catch (err) {
      callback()
    }
  }

  _parsePMT(packet, offset) {
    const sectionLength =
      ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2]
    const tableEnd = offset + 3 + sectionLength - 4
    const programInfoLength =
      ((packet[offset + 10] & 0x0f) << 8) | packet[offset + 11]
    offset += 12 + programInfoLength

    while (offset < tableEnd && offset < 188) {
      const streamType = packet[offset]
      const elementaryPid =
        ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2]
      const esInfoLength =
        ((packet[offset + 3] & 0x0f) << 8) | packet[offset + 4]

      if (streamType === 0x0f) {
        return elementaryPid
      }
      offset += 5 + esInfoLength
    }
    return null
  }

  _flush(callback) {
    if (this.aacData.length > 0) {
      this.push(this.aacData)
    }
    callback()
  }
}

class AACDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new FAAD2NodeDecoder()
    this.resampler = null
    this.isDecoderReady = false
    this.isConfigured = false
    this.pendingChunks = []
    this.buffer = Buffer.alloc(0)

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this.emit('decoderReady')
        this._processPendingChunks()
      })
      .catch((err) => this.emit('error', err))
  }

  _downmixToStereo(interleavedPCM, channels, samplesPerChannel) {
    if (channels === 2) return interleavedPCM

    if (channels === 1) {
      const stereo = new Float32Array(samplesPerChannel * 2)
      for (let i = 0; i < samplesPerChannel; i++) {
        stereo[i * 2] = interleavedPCM[i]
        stereo[i * 2 + 1] = interleavedPCM[i]
      }
      return stereo
    }

    const stereo = new Float32Array(samplesPerChannel * 2)
    const CENTER_MIX = Math.SQRT1_2
    const SURROUND_MIX = Math.SQRT1_2
    const LFE_MIX = 0.5

    for (let i = 0; i < samplesPerChannel; i++) {
      let left = 0
      let right = 0

      switch (channels) {
        case 3: {
          const C = interleavedPCM[i * 3]
          const L = interleavedPCM[i * 3 + 1]
          const R = interleavedPCM[i * 3 + 2]
          left = L + C * CENTER_MIX
          right = R + C * CENTER_MIX
          break
        }
        case 4: {
          const C = interleavedPCM[i * 4]
          const L = interleavedPCM[i * 4 + 1]
          const R = interleavedPCM[i * 4 + 2]
          const Cs = interleavedPCM[i * 4 + 3]
          left = L + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          right = R + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          break
        }
        case 5: {
          const C = interleavedPCM[i * 5]
          const L = interleavedPCM[i * 5 + 1]
          const R = interleavedPCM[i * 5 + 2]
          const Ls = interleavedPCM[i * 5 + 3]
          const Rs = interleavedPCM[i * 5 + 4]
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX
          break
        }
        case 6: {
          const C = interleavedPCM[i * 6]
          const L = interleavedPCM[i * 6 + 1]
          const R = interleavedPCM[i * 6 + 2]
          const Ls = interleavedPCM[i * 6 + 3]
          const Rs = interleavedPCM[i * 6 + 4]
          const LFE = interleavedPCM[i * 6 + 5]
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX + LFE * LFE_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX + LFE * LFE_MIX
          break
        }
        case 8: {
          const C = interleavedPCM[i * 8]
          const L = interleavedPCM[i * 8 + 1]
          const R = interleavedPCM[i * 8 + 2]
          const Ls = interleavedPCM[i * 8 + 3]
          const Rs = interleavedPCM[i * 8 + 4]
          const Lc = interleavedPCM[i * 8 + 5]
          const Rc = interleavedPCM[i * 8 + 6]
          const LFE = interleavedPCM[i * 8 + 7]
          left =
            L +
            C * CENTER_MIX +
            Ls * SURROUND_MIX +
            Lc * SURROUND_MIX * 0.5 +
            LFE * LFE_MIX
          right =
            R +
            C * CENTER_MIX +
            Rs * SURROUND_MIX +
            Rc * SURROUND_MIX * 0.5 +
            LFE * LFE_MIX
          break
        }
        default:
          left = interleavedPCM[i * channels]
          right =
            interleavedPCM[i * channels + 1] || interleavedPCM[i * channels]
          break
      }

      const normalize = (sample) => {
        if (sample > 1.0) return 1.0 - Math.exp(-(sample - 1.0))
        if (sample < -1.0) return -1.0 + Math.exp(-(Math.abs(sample) - 1.0))
        return sample
      }

      stereo[i * 2] = normalize(left)
      stereo[i * 2 + 1] = normalize(right)
    }

    return stereo
  }

  async _processPendingChunks() {
    if (!this.isDecoderReady || this.pendingChunks.length === 0) return

    for (const { chunk, encoding, callback } of this.pendingChunks) {
      await this._decodeChunk(chunk, encoding, callback)
    }
    this.pendingChunks = []
  }

  _findADTSFrame(buffer) {
    for (let i = 0; i < buffer.length - 7; i++) {
      const syncword = (buffer[i] << 4) | (buffer[i + 1] >> 4)
      if (syncword === 0xfff) {
        const frameLength =
          ((buffer[i + 3] & 0x03) << 11) |
          (buffer[i + 4] << 3) |
          ((buffer[i + 5] >> 5) & 0x07)

        if (i + frameLength <= buffer.length) {
          return {
            start: i,
            end: i + frameLength,
            frame: buffer.slice(i, i + frameLength)
          }
        }
      }
    }
    return null
  }

  _transform(chunk, encoding, callback) {
    if (!this.isDecoderReady) {
      this.pendingChunks.push({ chunk, encoding, callback })
      return
    }

    this._decodeChunk(chunk, encoding, callback)
  }

  async _decodeChunk(chunk, encoding, callback) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk])

      if (!this.isConfigured) {
        try {
          await this.decoder.configure(this.buffer, true)
          this.isConfigured = true
        } catch (err) {
          return callback()
        }
      }

      while (this.buffer.length > 0) {
        const frameInfo = this._findADTSFrame(this.buffer)

        if (!frameInfo) break

        try {
          const result = this.decoder.decode(frameInfo.frame)

          if (result?.pcm && result.pcm.length > 0) {
            let { pcm, sampleRate, channels, samplesPerChannel } = result

            if (channels > 2 || channels === 1) {
              pcm = this._downmixToStereo(pcm, channels, samplesPerChannel)
              channels = 2
            }

            if (sampleRate !== 48000) {
              if (!this.resampler) {
                this.resampler = await LibSampleRate.create(
                  2,
                  sampleRate,
                  48000,
                  {
                    converterType:
                      LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY
                  }
                )
              }

              const resampled = this.resampler.full(pcm)
              const pcmInt16 = new Int16Array(resampled.length)
              for (let i = 0; i < resampled.length; i++) {
                pcmInt16[i] = Math.max(-1, Math.min(1, resampled[i])) * 32767
              }
              this.push(Buffer.from(pcmInt16.buffer))
            } else {
              const pcmInt16 = new Int16Array(pcm.length)
              for (let i = 0; i < pcm.length; i++) {
                pcmInt16[i] = Math.max(-1, Math.min(1, pcm[i])) * 32767
              }
              this.push(Buffer.from(pcmInt16.buffer))
            }
          }
        } catch (decodeErr) {}

        this.buffer = this.buffer.slice(frameInfo.end)
      }

      callback()
    } catch (err) {
      callback()
    }
  }

  _flush(callback) {
    if (this.buffer.length > 0 && this.isConfigured) {
      try {
        const frameInfo = this._findADTSFrame(this.buffer)
        if (frameInfo) {
          const result = this.decoder.decode(frameInfo.frame)
          if (result?.pcm) {
            const pcmInt16 = new Int16Array(result.pcm.length)
            for (let i = 0; i < result.pcm.length; i++) {
              pcmInt16[i] = Math.max(-1, Math.min(1, result.pcm[i])) * 32767
            }
            this.push(Buffer.from(pcmInt16.buffer))
          }
        }
      } catch (err) {}
    }

    if (this.resampler) this.resampler.destroy?.()
    if (this.decoder) this.decoder.destroy?.()
    callback()
  }
}

class MP4ToAACStream extends Transform {
  constructor(options) {
    super(options)
    this.mp4boxFile = MP4Box.createFile()
    this.audioConfig = null
    this.offset = 0
    this.isReady = false

    this.mp4boxFile.onReady = (info) => {
      try {
        const audioTrack = info.tracks.find((t) => t.codec?.startsWith('mp4a'))
        if (!audioTrack) {
          this.emit('error', new Error('No AAC track found in MP4'))
          return
        }

        this.audioConfig = this._getAudioConfig(audioTrack)
        this.mp4boxFile.setExtractionOptions(audioTrack.id, null, {
          nbSamples: 1
        })
        this.mp4boxFile.start()
        this.isReady = true
      } catch (err) {
        this.emit(
          'error',
          new Error(`MP4 initialization error: ${err.message}`)
        )
      }
    }

    this.mp4boxFile.onSamples = (id, user, samples) => {
      try {
        if (!samples || !Array.isArray(samples)) return

        for (const sample of samples) {
          if (sample?.data) {
            const adts = this._createAdtsHeader(
              sample.data.byteLength,
              this.audioConfig
            )
            const sampleData =
              sample.data instanceof ArrayBuffer
                ? Buffer.from(sample.data)
                : Buffer.from(sample.data.buffer || sample.data)

            this.push(adts)
            this.push(sampleData)
          }
        }
      } catch (err) {}
    }

    this.mp4boxFile.onError = (e) => {
      this.emit('error', new Error(`MP4Box error: ${e}`))
    }
  }

  _getAudioConfig(track) {
    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350
    ]
    let samplingIndex = sampleRates.indexOf(track.audio.sample_rate)
    if (samplingIndex === -1)
      throw new Error('Unsupported sample rate for ADTS')

    let profile = 2

    if (track.codec) {
      const codecParts = track.codec.split('.')
      if (codecParts.length >= 3) {
        const objectType = Number.parseInt(codecParts[2], 10)

        if (objectType === 5) {
          profile = 2
          const coreSampleRate = track.audio.sample_rate / 2
          const coreSamplingIndex = sampleRates.indexOf(coreSampleRate)
          if (coreSamplingIndex !== -1) {
            samplingIndex = coreSamplingIndex
          }
        } else {
          profile = objectType
        }
      }
    }

    return {
      profile,
      samplingIndex,
      channelCount: track.audio.channel_count
    }
  }

  _createAdtsHeader(sampleLength, audioConfig) {
    const adts = Buffer.alloc(7)
    const frameLength = sampleLength + 7

    const profile = audioConfig.profile - 1
    const samplingIndex = audioConfig.samplingIndex
    const channelCount = audioConfig.channelCount

    adts[0] = 0xff
    adts[1] = 0xf1
    adts[2] =
      ((profile & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2)
    adts[3] = ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11)
    adts[4] = (frameLength & 0x7f8) >> 3
    adts[5] = ((frameLength & 0x7) << 5) | 0x1f
    adts[6] = 0xfc

    return adts
  }

  _transform(chunk, encoding, callback) {
    try {
      const arrayBuffer =
        chunk instanceof ArrayBuffer
          ? chunk
          : chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength
            )

      arrayBuffer.fileStart = this.offset
      this.offset += arrayBuffer.byteLength

      this.mp4boxFile.appendBuffer(arrayBuffer)
      callback()
    } catch (err) {
      callback()
    }
  }

  _flush(callback) {
    try {
      if (this.mp4boxFile) {
        this.mp4boxFile.flush()
      }
      callback()
    } catch (err) {
      callback()
    }
  }

  _destroy(err, callback) {
    if (this.mp4boxFile) {
      this.mp4boxFile.stop()
      this.mp4boxFile.onReady = null
      this.mp4boxFile.onSamples = null
      this.mp4boxFile.onError = null
      this.mp4boxFile = null
    }
    super._destroy(err, callback)
  }
}

class FMP4ToAACStream extends Transform {
  constructor(options) {
    super(options)
    this.audioConfig = null
    this.initSegmentProcessed = false
  }

  _parseBoxes(buffer, offset = 0) {
    const boxes = []
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break

      const size = buffer.readUInt32BE(offset)
      const type = buffer.toString('ascii', offset + 4, offset + 8)

      if (size === 0 || size > buffer.length - offset) break
      if (type === '\0\0\0\0') break

      const boxData = buffer.subarray(offset + 8, offset + size)
      boxes.push({ type, size, data: boxData, offset })
      offset += size
    }
    return boxes
  }

  _extractAudioConfigFromInit(initSegment) {
    const boxes = this._parseBoxes(initSegment)
    const moovBox = boxes.find((b) => b.type === 'moov')
    if (!moovBox) return null

    const moovBoxes = this._parseBoxes(moovBox.data)
    const trakBox = moovBoxes.find((b) => b.type === 'trak')
    if (!trakBox) return null

    const trakBoxes = this._parseBoxes(trakBox.data)
    const mdiaBox = trakBoxes.find((b) => b.type === 'mdia')
    if (!mdiaBox) return null

    const mdiaBoxes = this._parseBoxes(mdiaBox.data)
    const minfBox = mdiaBoxes.find((b) => b.type === 'minf')
    if (!minfBox) return null

    const minfBoxes = this._parseBoxes(minfBox.data)
    const stblBox = minfBoxes.find((b) => b.type === 'stbl')
    if (!stblBox) return null

    const stblBoxes = this._parseBoxes(stblBox.data)
    const stsdBox = stblBoxes.find((b) => b.type === 'stsd')
    if (!stsdBox) return null

    const stsd = stsdBox.data
    if (stsd.length < 16) return null

    const stsdBoxes = this._parseBoxes(stsd, 8)
    const mp4aBox = stsdBoxes.find((b) => b.type === 'mp4a')
    if (!mp4aBox) return null

    const mp4a = mp4aBox.data
    if (mp4a.length < 28) return null

    const channelCount = mp4a.readUInt16BE(16)
    const sampleRate = mp4a.readUInt32BE(24) >> 16

    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350
    ]
    const samplingIndex = sampleRates.indexOf(sampleRate)

    return {
      profile: 2,
      samplingIndex: samplingIndex !== -1 ? samplingIndex : 4,
      channelCount,
      sampleRate
    }
  }

  _createAdtsHeader(sampleLength, audioConfig) {
    const adts = Buffer.alloc(7)
    const frameLength = sampleLength + 7

    const profile = (audioConfig.profile || 2) - 1
    const samplingIndex = audioConfig.samplingIndex || 4
    const channelCount = audioConfig.channelCount || 2

    adts[0] = 0xff
    adts[1] = 0xf1
    adts[2] =
      ((profile & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2)
    adts[3] = ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11)
    adts[4] = (frameLength & 0x7f8) >> 3
    adts[5] = ((frameLength & 0x7) << 5) | 0x1f
    adts[6] = 0xfc

    return adts
  }

  _extractAACFromSegment(buffer) {
    if (!this.audioConfig) return null

    const boxes = this._parseBoxes(buffer)
    const mdatBox = boxes.find((b) => b.type === 'mdat')
    if (!mdatBox) return null

    const aacData = mdatBox.data
    const moofBox = boxes.find((b) => b.type === 'moof')
    if (!moofBox) return aacData

    const moofBoxes = this._parseBoxes(moofBox.data)
    const trafBox = moofBoxes.find((b) => b.type === 'traf')
    if (!trafBox) return aacData

    const trafBoxes = this._parseBoxes(trafBox.data)
    const trunBox = trafBoxes.find((b) => b.type === 'trun')
    if (!trunBox) return aacData

    const trun = trunBox.data
    if (trun.length < 8) return aacData

    const flags = (trun[1] << 16) | (trun[2] << 8) | trun[3]
    const sampleCount = trun.readUInt32BE(4)

    let offset = 8
    if (flags & 0x1) offset += 4
    if (flags & 0x4) offset += 4

    const sampleSizes = []
    const hasSampleSize = flags & 0x200

    for (let i = 0; i < sampleCount && offset < trun.length; i++) {
      if (flags & 0x100) offset += 4
      if (hasSampleSize && offset + 4 <= trun.length) {
        sampleSizes.push(trun.readUInt32BE(offset))
        offset += 4
      }
      if (flags & 0x400) offset += 4
      if (flags & 0x800) offset += 4
    }

    if (sampleSizes.length > 0) {
      const frames = []
      let dataOffset = 0
      for (const sampleSize of sampleSizes) {
        if (dataOffset + sampleSize <= aacData.length) {
          const adtsHeader = this._createAdtsHeader(
            sampleSize,
            this.audioConfig
          )
          const aacSample = aacData.subarray(
            dataOffset,
            dataOffset + sampleSize
          )
          frames.push(Buffer.concat([adtsHeader, aacSample]))
          dataOffset += sampleSize
        }
      }
      return frames.length > 0 ? Buffer.concat(frames) : null
    }

    return null
  }

  _transform(chunk, encoding, callback) {
    try {
      if (!this.initSegmentProcessed && chunk.length > 8) {
        const boxType = chunk.toString('ascii', 4, 8)
        if (boxType === 'ftyp') {
          this.audioConfig = this._extractAudioConfigFromInit(chunk)
          this.initSegmentProcessed = true
          callback()
          return
        }
      }

      if (this.audioConfig) {
        const aacData = this._extractAACFromSegment(chunk)
        if (aacData) {
          this.push(aacData)
        }
      }

      callback()
    } catch (err) {
      callback()
    }
  }

  _flush(callback) {
    callback()
  }
}

class WAVDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.headerParsed = false
    this.headerBuffer = Buffer.alloc(0)
  }

  _transform(chunk, encoding, callback) {
    try {
      if (!this.headerParsed) {
        this.headerBuffer = Buffer.concat([this.headerBuffer, chunk])

        if (this.headerBuffer.length >= 44) {
          const riff = this.headerBuffer.toString('ascii', 0, 4)
          const wave = this.headerBuffer.toString('ascii', 8, 12)

          if (riff === 'RIFF' && wave === 'WAVE') {
            let dataPos = 12
            while (dataPos < this.headerBuffer.length - 8) {
              const chunkId = this.headerBuffer.toString(
                'ascii',
                dataPos,
                dataPos + 4
              )
              const chunkSize = this.headerBuffer.readUInt32LE(dataPos + 4)

              if (chunkId === 'data') {
                const audioData = this.headerBuffer.slice(dataPos + 8)
                if (audioData.length > 0) {
                  this.push(audioData)
                }
                this.headerParsed = true
                break
              }

              dataPos += 8 + chunkSize
            }
          }
        }

        if (!this.headerParsed) {
          return callback()
        }
      } else {
        this.push(chunk)
      }

      callback()
    } catch (err) {
      callback()
    }
  }
}

class StreamAudioResource extends BaseAudioResource {
  constructor(stream, type, nodelink, initialFilters = {}, seekeable = null) {
    super()
    this.seekeable = seekeable

    try {
      if (!stream || !(stream instanceof Readable)) {
        throw new Error('Invalid stream provided')
      }

      const normalizedType = normalizeFormat(type)
      let pcmStream

      this.pipes = [stream]

      switch (normalizedType) {
        case SupportedFormats.AAC: {
          const lowerType = type.toLowerCase()
          let aacStream = stream

          if (
            lowerType.includes('fmp4') ||
            lowerType.includes('hls') ||
            lowerType.includes('mpegurl')
          ) {
            const fmp4ToAAC = new FMP4ToAACStream()
            aacStream = stream.pipe(fmp4ToAAC)
            this.pipes.push(fmp4ToAAC)
          } else if (
            lowerType.includes('mpegts') ||
            lowerType.includes('video/mp2t')
          ) {
            const mpegtsToAAC = new MPEGTSToAACStream()
            aacStream = stream.pipe(mpegtsToAAC)
            this.pipes.push(mpegtsToAAC)
          } else if (
            lowerType.includes('mp4') ||
            lowerType.includes('m4a') ||
            lowerType.includes('m4v') ||
            lowerType.includes('mov')
          ) {
            const mp4ToAAC = new MP4ToAACStream()
            aacStream = stream.pipe(mp4ToAAC)
            this.pipes.push(mp4ToAAC)
          }

          const aacDecoder = new AACDecoderStream()
          pcmStream = aacStream.pipe(aacDecoder)
          this.pipes.push(aacDecoder)
          break
        }
        case SupportedFormats.MPEG: {
          const mpegDecoder = new MpegDecoderStream()
          pcmStream = stream.pipe(mpegDecoder)
          this.pipes.push(mpegDecoder)
          break
        }
        case SupportedFormats.FLAC: {
          const flacDecoder = new FLACDecoderStream()
          pcmStream = stream.pipe(flacDecoder)
          this.pipes.push(flacDecoder)
          break
        }
        case SupportedFormats.OGG_VORBIS: {
          const vorbisDecoder = new OggVorbisDecoderStream()
          pcmStream = stream.pipe(vorbisDecoder)
          this.pipes.push(vorbisDecoder)
          break
        }
        case SupportedFormats.WAV: {
          pcmStream = stream
          break
        }
        case SupportedFormats.OPUS: {
          const lowerType = type.toLowerCase()
          const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960
          })

          if (lowerType.includes('webm')) {
            const demuxer = new prism.opus.WebmDemuxer()
            pcmStream = stream.pipe(demuxer).pipe(decoder)
            this.pipes.push(demuxer, decoder)
          } else {
            pcmStream = stream.pipe(decoder)
            this.pipes.push(decoder)
          }
          break
        }
        default: {
          const supportedFormatsList = [
            'MP3 (audio/mpeg)',
            'AAC (audio/aac, audio/aacp, mp4, m4a, m4v, mov, hls, mpegurl, fmp4, mpegts)',
            'FLAC (audio/flac)',
            'OGG Vorbis (audio/ogg, audio/vorbis)',
            'WAV (audio/wav)',
            'Opus (webm/opus, ogg/opus)'
          ]

          throw new Error(
            `Unsupported audio format: "${type}".\n` +
              `Supported formats:\n${supportedFormatsList.map((f) => `  • ${f}`).join('\n')}`
          )
        }
      }

      const volume = new prism.VolumeTransformer({ type: 's16le' })
      const filters = new FiltersManager(nodelink, initialFilters)
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      pcmStream.pipe(volume).pipe(filters).pipe(opus)

      this.pipes.push(volume, filters, opus)
      this.stream = opus

      stream.on('finishBuffering', () => this.stream.emit('finishBuffering'))

      stream.on('error', (err) => {
        console.error(`Error in input stream:`, err)
        this.stream.emit('error', err)
      })

      for (const pipe of this.pipes) {
        if (pipe === this.stream) continue;
        pipe.on?.('error', (err) => {
          console.error(`Error in stream pipe ${pipe.constructor.name}:`, err)
          this.stream.emit('error', err)
        })
      }

      this.stream.on('error', (err) => {
        console.error(`Error in opus encoder:`, err)
        this._end()
      })
    } catch (err) {
      throw new Error(`Failed to create audio resource: ${err.message}`)
    }
  }
}

export const createAudioResource = (
  stream,
  type,
  nodelink,
  initialFilters = {}
) => new StreamAudioResource(stream, type, nodelink, initialFilters)

export const createSeekeableAudioResource = async (
  url,
  seekTime,
  endTime,
  nodelink,
  initialFilters = {}
) => {
  const seekeable = new SeekeableNode()
  await seekeable.load(url, 4096)
  const { stream: demuxerStream, type } = seekeable.createAVStream(
    seekTime / 1000,
    endTime / 1000
  )

  const packetStream = new PassThrough()
  demuxerStream.on('data', (packet) => {
    if (packet?.data && packet.data.length > 0) {
      packetStream.write(Buffer.from(packet.data))
    }
  })
  demuxerStream.on('end', () => {
    packetStream.emit('finishBuffering')
    seekeable.destroy()
  })
  demuxerStream.on('error', (err) => {
    packetStream.emit('error', err)
    seekeable.destroy()
  })

  return new StreamAudioResource(
    packetStream,
    type,
    nodelink,
    initialFilters,
    seekeable
  )
}
