import { Buffer } from 'node:buffer'
import { PassThrough, pipeline, Readable, Transform } from 'node:stream'

import LibSampleRate from '@alexanderolsen/libsamplerate-js'
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js'
import { SeekError, seekableStream } from '@ecliptia/seekable-stream'
import { SymphoniaDecoder } from '@toddynnn/symphonia-decoder'
import * as MP4Box from 'mp4box'
import { normalizeFormat, SupportedFormats } from '../../constants.js'
import { logger } from '../../utils.js'
import FlvDemuxer from '../demuxers/Flv.js'
import WebmOpusDemuxer from '../demuxers/WebmOpus.js'
import { FiltersManager } from './filtersManager.js'
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from '../opus/Opus.js'
import { RingBuffer } from '../structs/RingBuffer.js'
import { FadeTransformer } from './FadeTransformer.js'
import { VolumeTransformer } from './VolumeTransformer.js'
import { FlowController } from './FlowController.js'

const AUDIO_CONFIG = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  frameSize: 960,
  highWaterMark: 19200
})

const BUFFER_THRESHOLDS = Object.freeze({
  maxCompressed: 256 * 1024,
  minCompressed: 128 * 1024
})

const AAC_BUFFER_SIZE = 2 * 1024 * 1024 // 2MB

const AUDIO_CONSTANTS = Object.freeze({
  pcmFloatFactor: 32767,
  maxDecodesPerTick: 5,
  decodeIntervalMs: 10
})

const MPEGTS_CONFIG = Object.freeze({
  syncByte: 0x47,
  packetSize: 188,
  aacStreamType: 0x0f,
  mp3StreamType: 0x03,
  mp3StreamType2: 0x04
})

const _DOWNMIX_COEFFICIENTS = Object.freeze({
  center: Math.SQRT1_2,
  surround: Math.SQRT1_2,
  lfe: 0.5
})

const SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

const EMPTY_BUFFER = Buffer.alloc(0)

const _getResamplerConverterType = (quality) => {
  const types = LibSampleRate.ConverterType
  const qualityMap = {
    best: types.SRC_SINC_BEST_QUALITY,
    medium: types.SRC_SINC_MEDIUM_QUALITY,
    fastest: types.SRC_SINC_FASTEST,
    'zero order holder': types.SRC_ZERO_ORDER_HOLD,
    linear: types.SRC_LINEAR
  }
  return qualityMap[quality] || types.SRC_SINC_FASTEST
}

const _clampSample = (value) => {
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

const _floatToInt16Buffer = (floatArray) => {
  const length = floatArray.length
  const output = new Int16Array(length)

  for (let i = 0; i < length; i++) {
    output[i] = _clampSample(floatArray[i]) * AUDIO_CONSTANTS.pcmFloatFactor
  }

  return Buffer.from(output.buffer)
}

const _createAdtsHeader = (
  sampleLength,
  profile,
  samplingIndex,
  channelCount
) => {
  const frameLength = sampleLength + 7
  const profileIndex = profile - 1

  return Buffer.from([
    0xff,
    0xf1,
    ((profileIndex & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2),
    ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11),
    (frameLength & 0x7f8) >> 3,
    ((frameLength & 0x7) << 5) | 0x1f,
    0xfc
  ])
}

const _parseBoxes = (buffer, offset = 0) => {
  const boxes = []
  const bufferLength = buffer.length

  while (offset + 8 <= bufferLength) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)

    if (size === 0 || size > bufferLength - offset) break
    if (type === '\0\0\0\0') break

    boxes.push({
      type,
      size,
      data: buffer.subarray(offset + 8, offset + size),
      offset
    })

    offset += size
  }

  return boxes
}

const _findNestedBox = (boxes, ...path) => {
  let current = boxes

  for (const boxType of path) {
    const box = current.find((b) => b.type === boxType)
    if (!box) return null
    current = _parseBoxes(box.data)
  }

  return current
}

const _createErrorResponse = (message, cause = 'UNKNOWN') => ({
  exception: {
    message,
    severity: 'fault',
    cause
  }
})

const _isFmp4Format = (type) =>
  type.indexOf('fmp4') !== -1 ||
  type.indexOf('hls') !== -1 ||
  type.indexOf('mpegurl') !== -1

const _isMpegtsFormat = (type) =>
  type.indexOf('mpegts') !== -1 || type.indexOf('video/mp2t') !== -1

const _isMp4Format = (type) =>
  type.indexOf('mp4') !== -1 ||
  type.indexOf('m4a') !== -1 ||
  type.indexOf('m4v') !== -1 ||
  type.indexOf('mov') !== -1

const _isWebmFormat = (type) => type.indexOf('webm') !== -1

const _isFlvFormat = (type) => type.indexOf('flv') !== -1

class BaseAudioResource {
  constructor() {
    this.pipes = []
    this.stream = null
    this._destroyed = false
  }

  _end() {
    if (this._destroyed || !this.pipes) return
    this._destroyed = true

    const firstPipe = this.pipes[0]

    if (firstPipe?.stopHls) {
      firstPipe.stopHls()
    }

    if (firstPipe?.responseStream?.destroyed === false) {
      firstPipe.responseStream.destroy()
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i]
      pipe.abort?.()
      pipe.unpipe?.()
      pipe.destroy?.()
      pipe.removeAllListeners?.()
    }

    this.stream = null
    this.pipes = null
  }

  destroy() {
    this._end()
  }

  setVolume(volume) {
    if (!this.pipes) return

    const flowController = this.pipes.find((p) => p instanceof FlowController)
    if (flowController) {
      flowController.setVolume(volume)
      return
    }

    const volumeTransformer = this.pipes.find(
      (p) => p instanceof VolumeTransformer
    )

    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    } else {
      throw new Error('VolumeTransformer not found in the pipeline.')
    }
  }

  setFilters(filters) {
    if (!this.pipes) return

    const flowController = this.pipes.find((p) => p instanceof FlowController)
    if (flowController) {
      flowController.setFilters(filters)
      return
    }

    const filterManager = this.pipes.find((p) => p instanceof FiltersManager)

    if (filterManager) {
      filterManager.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }

  setFadeVolume(volume) {
    if (!this.pipes) return

    const flowController = this.pipes.find((p) => p instanceof FlowController)
    if (flowController) {
      flowController.setFadeVolume(volume)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    )

    if (fadeTransformer) {
      fadeTransformer.setGain(volume)
    } else {
      throw new Error('FadeTransformer not found in the pipeline.')
    }
  }

  fadeTo(volume, durationMs, curve) {
    if (!this.pipes) return

    const flowController = this.pipes.find((p) => p instanceof FlowController)
    if (flowController) {
      flowController.fadeTo(volume, durationMs, curve)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    )

    if (fadeTransformer) {
      fadeTransformer.fadeTo(volume, durationMs, curve)
    } else {
      throw new Error('FadeTransformer not found in the pipeline.')
    }
  }

  emit(event, ...args) {
    this.stream?.emit(event, ...args)
  }
  on(event, listener) {
    this.stream?.on(event, listener)
  }
  off(event, listener) {
    this.stream?.off(event, listener)
  }
  once(event, listener) {
    this.stream?.once(event, listener)
  }
  removeListener(event, listener) {
    this.stream?.removeListener(event, listener)
  }

  removeAllListeners() {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      this.stream.removeAllListeners(eventName)
    }
  }

  read() {
    return this.stream?.read()
  }
  resume() {
    this.stream?.resume()
  }
}

class SymphoniaDecoderStream extends Transform {
  constructor(options = {}) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark,
      objectMode: false
    })

    this.decoder = new SymphoniaDecoder()
    this.resampler = null
    this.resamplingQuality = options.resamplingQuality || 'fastest'
    this.resumeInput = null
    this.isFinished = false
    this._aborted = false
    this._loopScheduled = false
    this._isDecoding = false
    this._timeoutId = null
    this._immediateId = null

    this.on('resume', () => {
      if (!this.isFinished && !this._aborted && this.decoder) {
        this._scheduleDecode()
      }
    })
  }

  abort() {
    this._aborted = true
    this._cancelTimers()
  }

  _cancelTimers() {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }
    if (this._immediateId) {
      clearImmediate(this._immediateId)
      this._immediateId = null
    }
    this._loopScheduled = false
  }

  _isDecoderValid() {
    return this.decoder !== null && !this._aborted && !this.isFinished
  }

  _transform(chunk, _encoding, callback) {
    if (this._aborted || !this.decoder) return callback()

    this.decoder.push(chunk)
    this._scheduleDecode()

    const bufferedBytes = this.decoder?.bufferedBytes ?? 0
    if (bufferedBytes > BUFFER_THRESHOLDS.maxCompressed) {
      this.resumeInput = callback
    } else {
      callback()
    }
  }

  _scheduleDecode() {
    if (
      this._loopScheduled ||
      this._isDecoding ||
      !this._isDecoderValid() ||
      this.readableFlowing === false
    )
      return

    if (this.readableLength >= this.readableHighWaterMark) {
      this._loopScheduled = true
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null
        this._loopScheduled = false
        if (this._isDecoderValid()) this._scheduleDecode()
      }, AUDIO_CONSTANTS.decodeIntervalMs)
      return
    }

    this._loopScheduled = true

    this._timeoutId = setTimeout(() => {
      this._timeoutId = null
      this._loopScheduled = false
      if (this._isDecoderValid()) this._decodeLoop()
    }, AUDIO_CONSTANTS.decodeIntervalMs)
  }

  async _decodeLoop() {
    if (!this._isDecoderValid() || this.readableFlowing === false) return
    this._isDecoding = true

    try {
      let hasMoreData = true

      while (
        hasMoreData &&
        this._isDecoderValid() &&
        this.readableFlowing !== false &&
        this.readableLength < this.readableHighWaterMark
      ) {
        hasMoreData = await this._processAudio()

        if (hasMoreData && this._isDecoderValid()) {
          await new Promise((resolve) => {
            this._immediateId = setImmediate(() => {
              this._immediateId = null
              resolve()
            })
          })
        }
      }
    } catch (err) {
      if (!this._aborted) this.emit('error', err)
    } finally {
      this._isDecoding = false
    }

    const bufferedBytes = this.decoder?.bufferedBytes ?? 0
    if (
      bufferedBytes > 0 &&
      this._isDecoderValid() &&
      this.readableFlowing !== false &&
      this.readableLength < this.readableHighWaterMark
    ) {
      this._scheduleDecode()
    }
  }

  async _processAudio() {
    if (!this._isDecoderValid()) return false
    if (this.readableLength >= this.readableHighWaterMark) return true

    if (!this.decoder.isProbed) {
      try {
        if (!this.decoder.initialize()) return false
      } catch (err) {
        throw new Error(`Symphonia init failed: ${err.message}`)
      }
    }

    let decodeCount = 0
    let hasOutput = false

    while (
      decodeCount < AUDIO_CONSTANTS.maxDecodesPerTick &&
      this._isDecoderValid() &&
      this.readableLength < this.readableHighWaterMark
    ) {
      const result = this.decoder?.decode()
      if (!result) break

      const { samples, sampleRate, channels } = result

      const output =
        sampleRate !== AUDIO_CONFIG.sampleRate
          ? await this._resample(samples, channels, sampleRate)
          : samples

      if (this._aborted) break

      const canPush = this.push(output)
      hasOutput = true
      decodeCount++

      if (this.resumeInput) {
        const afterBytes = this.decoder?.bufferedBytes ?? 0
        if (afterBytes < BUFFER_THRESHOLDS.minCompressed) {
          const cb = this.resumeInput
          this.resumeInput = null
          cb()
        }
      }

      if (!canPush) break
    }

    const remainingBytes = this.decoder?.bufferedBytes ?? 0
    return hasOutput || remainingBytes > 0
  }

  async _resample(pcmInt16Buf, channels, inputRate) {
    if (this._aborted) return EMPTY_BUFFER

    if (!this.resampler) {
      this.resampler = await LibSampleRate.create(
        channels,
        inputRate,
        AUDIO_CONFIG.sampleRate,
        { converterType: _getResamplerConverterType(this.resamplingQuality) }
      )
    }

    const i16 = new Int16Array(
      pcmInt16Buf.buffer,
      pcmInt16Buf.byteOffset,
      pcmInt16Buf.byteLength / 2
    )

    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768

    return _floatToInt16Buffer(this.resampler.full(f32))
  }

  _flush(callback) {
    this.isFinished = true
    this._cancelTimers()

    if (this._aborted || !this.decoder) {
      this._cleanup()
      callback()
      return
    }

    try {
      this.decoder.closeInput()

      let count = 0
      while (count < 1000) {
        const result = this.decoder?.decode()
        if (!result) break
        this.push(result.samples)
        count++
      }
    } catch {}

    this._cleanup()
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true
    this.isFinished = true
    this._cancelTimers()

    if (this.resumeInput) {
      const cb = this.resumeInput
      this.resumeInput = null
      cb()
    }

    this._cleanup()
    super._destroy(err, callback)
  }

  _cleanup() {
    this._cancelTimers()

    if (this.decoder) {
      try {
        this.decoder.flush()
      } catch {}
      try {
        this.decoder.free()
      } catch {}
      this.decoder = null
    }

    if (this.resampler) {
      try {
        this.resampler.destroy()
      } catch {}
      this.resampler = null
    }
  }
}

class MPEGTSDemuxer extends Transform {
  constructor(options) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.ringBuffer = new RingBuffer(BUFFER_THRESHOLDS.maxCompressed)
    this.patPmtId = null
    this.audioPid = null
    this.audioPidFound = false
    this._aborted = false
    this.pesBuffer = Buffer.alloc(0)
    this.pesRemaining = 0
  }

  abort() {
    this._aborted = true
    this.ringBuffer.clear()
    this.pesBuffer = Buffer.alloc(0)
  }

  _transform(chunk, _encoding, callback) {
    if (this._aborted) return callback()

    try {
      this.ringBuffer.write(chunk)

      while (this.ringBuffer.length >= MPEGTS_CONFIG.packetSize && !this._aborted) {
        const head = this.ringBuffer.peek(1)
        if (head[0] !== MPEGTS_CONFIG.syncByte) {
          this.ringBuffer.read(1)
          continue
        }

        const packet = this.ringBuffer.read(MPEGTS_CONFIG.packetSize)
        const pusi = !!(packet[1] & 0x40)
        const pid = ((packet[1] & 0x1f) << 8) | packet[2]
        const afc = (packet[3] & 0x30) >> 4

        let offset = 4
        if (afc > 1) {
          offset = 5 + packet[4]
          if (offset >= MPEGTS_CONFIG.packetSize) continue
        }

        if (pid === 0 && pusi) {
          this._processPAT(packet, offset)
        } else if (this.patPmtId && pid === this.patPmtId && pusi) {
          this._processPMT(packet, offset)
        } else if (this.audioPid && pid === this.audioPid) {
          this._processAudioPacket(packet, pusi, offset)
        }
      }
      callback()
    } catch {
      callback()
    }
  }

  _processPAT(packet, offset) {
    offset += packet[offset] + 1
    if (offset + 11 < MPEGTS_CONFIG.packetSize) {
      this.patPmtId = ((packet[offset + 10] & 0x1f) << 8) | packet[offset + 11]
    }
  }

  _processPMT(packet, offset) {
    offset += packet[offset] + 1
    const sectionLength = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2]
    const tableEnd = offset + 3 + sectionLength - 4
    const programInfoLength = ((packet[offset + 10] & 0x0f) << 8) | packet[offset + 11]
    offset += 12 + programInfoLength

    while (offset < tableEnd && offset < MPEGTS_CONFIG.packetSize) {
      const streamType = packet[offset]
      const elementaryPid = ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2]

      if ((streamType === MPEGTS_CONFIG.aacStreamType || streamType === MPEGTS_CONFIG.mp3StreamType || streamType === MPEGTS_CONFIG.mp3StreamType2) && !this.audioPidFound) {
        this.audioPid = elementaryPid
        this.audioPidFound = true
        return
      }
      const esInfoLen = ((packet[offset + 3] & 0x0f) << 8) | packet[offset + 4]
      offset += 5 + esInfoLen
    }
  }

  _processAudioPacket(packet, pusi, offset) {
    if (pusi) {
      if (this.pesBuffer.length > 0) {
        this._emitPES(this.pesBuffer)
        this.pesBuffer = Buffer.alloc(0)
      }
    }

    const payload = packet.subarray(offset)
    if (payload.length > 0) {
      this.pesBuffer = Buffer.concat([this.pesBuffer, payload])
    }
  }

  _emitPES(buffer) {
    if (buffer.length < 9) return

    // Check for PES start code 00 00 01
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01) {
      const headerLength = buffer[8]
      const payloadOffset = 9 + headerLength

      if (payloadOffset < buffer.length) {
        this.push(buffer.subarray(payloadOffset))
      }
    }
  }

  _flush(callback) {
    if (this.pesBuffer.length > 0) {
      this._emitPES(this.pesBuffer)
    }
    this.pesBuffer = Buffer.alloc(0)
    this.ringBuffer.clear()
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true
    this.ringBuffer.dispose()
    this.pesBuffer = Buffer.alloc(0)
    super._destroy(err, callback)
  }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class AACDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new FAAD2NodeDecoder()
    this.resampler = null
    this.isDecoderReady = false
    this.isConfigured = false
    this.pendingChunks = []
    this.ringBuffer = new RingBuffer(AAC_BUFFER_SIZE)
    this.resamplingQuality = options?.resamplingQuality || 'fastest'
    this.resamplerCreationPromise = null

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this.emit('decoderReady')
        this._processPendingChunks()
      })
      .catch((err) => this.emit('error', err))
  }

  _destroy(err, cb) {
    this.ringBuffer.dispose()
    if (this.decoder) this.decoder.free?.()
    if (this.resampler) this.resampler.destroy?.()
    super._destroy(err, cb)
  }

  _downmixToStereo(interleavedPCM, channels, samplesPerChannel) {
    if (channels === 2) return interleavedPCM

    const stereo = new Float32Array(samplesPerChannel * 2)

    if (channels === 1) {
      for (let i = 0; i < samplesPerChannel; i++) {
        const val = interleavedPCM[i]
        stereo[i * 2] = val
        stereo[i * 2 + 1] = val
      }
      return stereo
    }

    const CENTER_MIX = Math.SQRT1_2
    const SURROUND_MIX = Math.SQRT1_2
    const LFE_MIX = 0.5

    for (let i = 0; i < samplesPerChannel; i++) {
      let left = 0
      let right = 0
      const offset = i * channels

      switch (channels) {
        case 3: {
          const C = interleavedPCM[offset]
          const L = interleavedPCM[offset + 1]
          const R = interleavedPCM[offset + 2]
          left = L + C * CENTER_MIX
          right = R + C * CENTER_MIX
          break
        }
        case 4: {
          const C = interleavedPCM[offset]
          const L = interleavedPCM[offset + 1]
          const R = interleavedPCM[offset + 2]
          const Cs = interleavedPCM[offset + 3]
          left = L + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          right = R + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          break
        }
        case 5: {
          const C = interleavedPCM[offset]
          const L = interleavedPCM[offset + 1]
          const R = interleavedPCM[offset + 2]
          const Ls = interleavedPCM[offset + 3]
          const Rs = interleavedPCM[offset + 4]
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX
          break
        }
        case 6: {
          const C = interleavedPCM[offset]
          const L = interleavedPCM[offset + 1]
          const R = interleavedPCM[offset + 2]
          const Ls = interleavedPCM[offset + 3]
          const Rs = interleavedPCM[offset + 4]
          const LFE = interleavedPCM[offset + 5]
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX + LFE * LFE_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX + LFE * LFE_MIX
          break
        }
        default:
          left = interleavedPCM[offset]
          right = interleavedPCM[offset + 1] || left
          break
      }

      if (left > 1.0) left = 1.0
      else if (left < -1.0) left = -1.0
      if (right > 1.0) right = 1.0
      else if (right < -1.0) right = -1.0

      stereo[i * 2] = left
      stereo[i * 2 + 1] = right
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

  _findADTSFrame() {
    const buffer = this.ringBuffer.peek(this.ringBuffer.length)
    if (!buffer) return null

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
            frame: buffer.subarray(i, i + frameLength)
          }
        }
        break
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

  async _decodeChunk(chunk, _encoding, callback) {
    try {
      this.ringBuffer.write(chunk)

      if (!this.isConfigured) {
        const frameInfo = this._findADTSFrame()
        if (frameInfo) {
          try {
            await this.decoder.configure(frameInfo.frame, true)
            this.isConfigured = true
          } catch (err) {
            this.ringBuffer.read(frameInfo.end)
            return callback(err)
          }
        } else {
          return callback()
        }
      }

      while (this.ringBuffer.length > 0) {
        const frameInfo = this._findADTSFrame()

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
              if (!this.resampler && !this.resamplerCreationPromise) {
                this.resamplerCreationPromise = LibSampleRate.create(
                  2,
                  sampleRate,
                  48000,
                  {
                    converterType: _getResamplerConverterType(
                      this.resamplingQuality
                    )
                  }
                ).then((resampler) => {
                  this.resampler = resampler
                  this.resamplerCreationPromise = null
                  return resampler
                })
              }

              if (!this.resampler) {
                await this.resamplerCreationPromise
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
        } catch (_decodeErr) {
          // Skip bad frame
        }

        this.ringBuffer.read(frameInfo.end)
      }

      callback()
    } catch (err) {
      callback(err)
    }
  }

  _flush(callback) {
    if (this.ringBuffer.length > 0 && this.isConfigured) {
      try {
        const frameInfo = this._findADTSFrame()
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
      } catch (_err) {}
    }

    if (this.resampler) this.resampler.destroy?.()
    if (this.decoder) this.decoder.destroy?.()
    callback()
  }
}
class MP4ToAACStream extends Transform {
  constructor(options) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.mp4boxFile = MP4Box.createFile()
    this.audioConfig = null
    this.offset = 0
    this.isReady = false
    this._aborted = false

    this._setupMP4BoxHandlers()
  }

  abort() {
    this._aborted = true
    this._cleanupMp4Box()
  }

  _setupMP4BoxHandlers() {
    this.mp4boxFile.onReady = (info) => {
      if (this._aborted) return

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

    this.mp4boxFile.onSamples = (_id, _user, samples) => {
      if (this._aborted) return

      try {
        if (!samples || !Array.isArray(samples)) return

        for (const sample of samples) {
          if (sample?.data && !this._aborted) {
            this._emitSampleWithADTS(sample)
          }
        }
      } catch (err) {
        if (!this._aborted) {
          this.emit(
            'error',
            new Error(`MP4Box sample processing error: ${err.message}`)
          )
        }
      }
    }

    this.mp4boxFile.onError = (e) => {
      if (!this._aborted) {
        this.emit('error', new Error(`MP4Box error: ${e}`))
      }
    }
  }

  _emitSampleWithADTS(sample) {
    const { profile, samplingIndex, channelCount } = this.audioConfig

    const sampleData =
      sample.data instanceof ArrayBuffer
        ? Buffer.from(sample.data)
        : Buffer.from(sample.data.buffer || sample.data)

    this.push(
      _createAdtsHeader(
        sampleData.byteLength,
        profile,
        samplingIndex,
        channelCount
      )
    )
    this.push(sampleData)
  }

  _getAudioConfig(track) {
    let samplingIndex = SAMPLE_RATES.indexOf(track.audio.sample_rate)

    if (samplingIndex === -1) {
      throw new Error('Unsupported sample rate for ADTS')
    }

    let profile = 2

    if (track.codec) {
      const codecParts = track.codec.split('.')

      if (codecParts.length >= 3) {
        const objectType = Number.parseInt(codecParts[2], 10)

        if (objectType === 5) {
          const coreSamplingIndex = SAMPLE_RATES.indexOf(
            track.audio.sample_rate / 2
          )
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

  _transform(chunk, _encoding, callback) {
    if (this._aborted || !this.mp4boxFile) {
      callback()
      return
    }

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
    } catch {
      callback()
    }
  }

  _flush(callback) {
    if (!this._aborted && this.mp4boxFile) {
      try {
        this.mp4boxFile.flush()
      } catch {}
    }
    this._cleanupMp4Box()
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true
    this._cleanupMp4Box()
    super._destroy(err, callback)
  }

  _cleanupMp4Box() {
    if (this.mp4boxFile) {
      try {
        this.mp4boxFile.stop()
      } catch {}
      this.mp4boxFile.onReady = null
      this.mp4boxFile.onSamples = null
      this.mp4boxFile.onError = null
      this.mp4boxFile = null
    }
  }
}
/**********************************************************************
 * ATENÇÃO: Não altere este trecho; ajustes aqui quebram a cadeia de decodificação.
 * WARNING: Do not edit this section; changes here will break the decoding pipeline.
 **********************************************************************/
class FMP4ToAACStream extends Transform {
  constructor(options = {}) {
    super(options)
    this.audioConfig = null
    this.initSegmentProcessed = false
    // Quando for true, buffers dados e processa boxes completos (SoundCloud por exemplo)
    // Quando for false (padrão), espera segmentos completos por chunk (NicoVideo por exemplo)
    this.bufferMode = options.bufferMode || false
    this.buffer = Buffer.alloc(0)
    this._pendingMoof = null
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

  // Aqui processa os dados bufferizados, que vai ser retornando quando o bufferMode for true
  _processBuffer() {
    while (this.buffer.length > 0) {
      if (!this._streamState) {
        this._streamState = {
          mode: 'READ_HEADER',
          offset: 0,
          boxSize: 0,
          boxType: '',
          headerSize: 8,
          moofBuffer: Buffer.alloc(0),
          samples: []
        }
      }

      if (this._streamState.mode === 'READ_HEADER') {
        if (this.buffer.length < 8) break

        const size32 = this.buffer.readUInt32BE(0)
        const type = this.buffer.toString('ascii', 4, 8)

        let size = size32
        let headerSize = 8

        if (size === 1) {
             if (this.buffer.length < 16) break
             size = Number(this.buffer.readBigUInt64BE(8))
             headerSize = 16
        }

        if (size === 0 || (size < headerSize && size !== 0)) {
             this.buffer = this.buffer.subarray(1)
             continue
        }

        this._streamState.boxSize = size
        this._streamState.boxType = type
        this._streamState.headerSize = headerSize

        this.buffer = this.buffer.subarray(headerSize)
        this._streamState.boxSize -= headerSize

        if (type === 'mdat') {
          this._streamState.mode = 'STREAM_MDAT'
        } else {
          this._streamState.mode = 'READ_BODY'
        }

      } else if (this._streamState.mode === 'READ_BODY') {
        if (this.buffer.length < this._streamState.boxSize) break

        const body = this.buffer.subarray(0, this._streamState.boxSize)
        this.buffer = this.buffer.subarray(this._streamState.boxSize)

        const type = this._streamState.boxType

        if (type === 'moov') {
           if (!this.initSegmentProcessed) {
             const header = Buffer.alloc(8)
             header.writeUInt32BE(body.length + 8, 0)
             header.write('moov', 4)
             const fullBox = Buffer.concat([header, body])

             const config = this._extractAudioConfigFromInit(fullBox)
             if (config) {
               this.audioConfig = config
               this.initSegmentProcessed = true
             } else {
               logger('warn', 'FMP4', 'Failed to extract audio config from moov')
             }
           }
        } else if (type === 'ftyp') {
           // O ftyp geralmente não contém configuração de áudio, mas às vezes o segmento de inicialização é passado como um único bloco
           // Neste parser de streaming, lidamos box por box.
           // Podemos ignorar o ftyp aqui, aqui vai aguardar o moov.
        } else if (type === 'moof') {
           const sizes = this._parseMoof(body)
           if (sizes && sizes.length > 0) {
             this._streamState.samples = sizes
           } else {
            // logger('debug', 'FMP4', 'moof parsed but 0 samples found')
           }
        }

        this._streamState.mode = 'READ_HEADER'

      } else if (this._streamState.mode === 'STREAM_MDAT') {
         const samples = this._streamState.samples

         if (samples.length === 0) {
           const toSkip = Math.min(this.buffer.length, this._streamState.boxSize)
           this.buffer = this.buffer.subarray(toSkip)
           this._streamState.boxSize -= toSkip
         } else {
           while (samples.length > 0 && this.buffer.length >= samples[0]) {
              const sampleSize = samples[0]
              const sampleData = this.buffer.subarray(0, sampleSize)
              this.buffer = this.buffer.subarray(sampleSize)

              if (this.audioConfig) {
                 const adts = this._createAdtsHeader(sampleSize, this.audioConfig)
                 this.push(Buffer.concat([adts, sampleData]))
              }

              this._streamState.boxSize -= sampleSize
              samples.shift()
           }
         }

         if (this._streamState.boxSize <= 0) {
             this._streamState.mode = 'READ_HEADER'
             this._streamState.samples = []
         } else if (samples.length > 0 && this.buffer.length < samples[0]) {
             break
         }
      }
    }
  }

  _parseMoof(moofData) {
    const boxes = this._parseBoxes(moofData)
    const trafs = boxes.filter((b) => b.type === 'traf')
    const sizes = []

    for (const traf of trafs) {
      const trafBoxes = this._parseBoxes(traf.data)
      const tfhd = trafBoxes.find((b) => b.type === 'tfhd')
      if (!tfhd || tfhd.data.length < 8) continue

      const trackId = tfhd.data.readUInt32BE(4)

      if (trafs.length > 1 && this.audioConfig && trackId !== this.audioConfig.trackId) {
        continue
      }
      if (!this.audioConfig) continue

      const tfhdFlags = (tfhd.data[1] << 16) | (tfhd.data[2] << 8) | tfhd.data[3]
      let currentDefaultSize = this.audioConfig.defaultSampleSize || 0

      let offset = 8
      if (tfhdFlags & 0x01) offset += 8
      if (tfhdFlags & 0x02) offset += 4
      if (tfhdFlags & 0x08) offset += 4
      if ((tfhdFlags & 0x10) && offset + 4 <= tfhd.data.length) {
        currentDefaultSize = tfhd.data.readUInt32BE(offset)
        offset += 4
      }

      const truns = trafBoxes.filter((b) => b.type === 'trun')
      for (const trun of truns) {
        const data = trun.data
        if (data.length < 8) continue
        const flags = (data[1] << 16) | (data[2] << 8) | data[3]
        const count = data.readUInt32BE(4)

        let trunOffset = 8
        if (flags & 0x01) trunOffset += 4
        if (flags & 0x04) trunOffset += 4

        const hasDuration = flags & 0x100
        const hasSize = flags & 0x200
        const hasFlags = flags & 0x400
        const hasCtOffset = flags & 0x800

        for (let i = 0; i < count; i++) {
          let sSize = currentDefaultSize
          if (hasDuration) trunOffset += 4
          if (hasSize && trunOffset + 4 <= data.length) {
            sSize = data.readUInt32BE(trunOffset)
            trunOffset += 4
          }
          if (hasFlags) trunOffset += 4
          if (hasCtOffset) trunOffset += 4

          if (sSize > 0) sizes.push(sSize)
        }
      }
    }
    return sizes
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (this.bufferMode) {
        // quando bufferMode for true, vai ser modo streaming, ou seja, vai processar o chunk imediatamente
        this.buffer = Buffer.concat([this.buffer, chunk])
        this._processBuffer()
      } else {
        // quando bufferMode for false, vai ser modo simples, ou seja, vai processar o chunk quando tiver todos os dados
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
          if (aacData) this.push(aacData)
        }
      }

      callback()
    } catch (_err) {
      callback()
    }
  }

  _flush(callback) {
    if (this.bufferMode) {
      try {
        this._processBuffer()
      } catch (_err) {}
    }
    callback()
  }
}

class FLVToAACStream extends Transform {
  constructor(options) {
    super(options)
    this.demuxer = new FlvDemuxer()
    this.audioConfig = null
    this._aborted = false

    this.demuxer.on('data', (audioTag) => {
      if (this._aborted) return
      this._processAudioTag(audioTag)
    })

    this.demuxer.on('error', (err) => {
      if (!this._aborted) this.emit('error', err)
    })
  }

  abort() {
    this._aborted = true
    this.demuxer.destroy()
  }

  _processAudioTag(tag) {
    const header = tag[0]
    const format = (header & 0xf0) >> 4

    if (format === 10) {
      const aacPacketType = tag[1]
      if (aacPacketType === 0) {
        this.audioConfig = this._parseAudioSpecificConfig(tag.subarray(2))
      } else if (aacPacketType === 1 && this.audioConfig) {
        const adtsHeader = _createAdtsHeader(
          tag.length - 2,
          this.audioConfig.profile,
          this.audioConfig.samplingIndex,
          this.audioConfig.channelCount
        )
        this.push(Buffer.concat([adtsHeader, tag.subarray(2)]))
      }
    } else if (format === 2) {
      this.push(tag.subarray(1))
    }
  }

  _parseAudioSpecificConfig(data) {
    const objectType = (data[0] & 0xf8) >> 3
    const samplingIndex = ((data[0] & 0x07) << 1) | ((data[1] & 0x80) >> 7)
    const channelConfig = (data[1] & 0x78) >> 3

    return {
      profile: objectType,
      samplingIndex,
      channelCount: channelConfig
    }
  }

  _transform(chunk, encoding, callback) {
    this.demuxer.write(chunk, encoding, callback)
  }

  _flush(callback) {
    this.demuxer.end(callback)
  }
}

class StreamAudioResource extends BaseAudioResource {
  constructor(
    stream,
    type,
    nodelink,
    initialFilters = {},
    volume = 1.0,
    audioMixer = null,
    returnPCM = false
  ) {
    super()

    this._validateInputStream(stream)

    const resamplingQuality =
      nodelink.options.audio.resamplingQuality || 'fastest'
    const normalizedType = normalizeFormat(type)

    this.pipes = [stream]

    const pcmStream = this._createDecoderPipeline(
      stream,
      type,
      normalizedType,
      resamplingQuality
    )

    if (returnPCM) {
      this._createPCMOutputPipeline(pcmStream, volume)
    } else {
      this._createOutputPipeline(
        pcmStream,
        nodelink,
        initialFilters,
        volume,
        audioMixer
      )
    }

    this._setupEventHandlers(stream)
  }

  _validateInputStream(stream) {
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }
  }

  _createDecoderPipeline(stream, type, normalizedType, resamplingQuality) {
    switch (normalizedType) {
      case SupportedFormats.AAC:
        return this._createAACPipeline(stream, type, resamplingQuality)

      case SupportedFormats.FLV:
        return this._createFLVPipeline(stream, type, resamplingQuality)

      case SupportedFormats.MPEG:
      case SupportedFormats.FLAC:
      case SupportedFormats.OGG_VORBIS:
      case SupportedFormats.WAV:
        return this._createSymphoniaPipeline(stream, resamplingQuality)

      case SupportedFormats.OPUS:
        return this._createOpusPipeline(stream, type)

      default:
        throw this._createUnsupportedFormatError(type)
    }
  }

  _createFLVPipeline(stream, _type, resamplingQuality) {
    const demuxer = new FLVToAACStream()
    const decoder = new AACDecoderStream({ resamplingQuality })

    this.pipes.push(demuxer, decoder)

    pipeline(stream, demuxer, decoder, (err) => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createAACPipeline(stream, type, resamplingQuality) {
    const lowerType = type.toLowerCase()
    const _aacStream = stream
    const streams = [stream]

    if (_isFmp4Format(lowerType)) {
      // como eu coloquei options = {} no fmp4, ele aceita isso como o bufferMode, se incluir, vai passar true, se nao, vai passar false
      const bufferMode = lowerType.includes('fmp4-buffered')
      const demuxer = new FMP4ToAACStream({ bufferMode })
      streams.push(demuxer)
    } else if (_isMpegtsFormat(lowerType)) {
      const demuxer = new MPEGTSDemuxer()
      streams.push(demuxer)

      if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
        const decoder = new SymphoniaDecoderStream({ resamplingQuality })
        streams.push(decoder)

        this.pipes.push(...streams.slice(1))

        pipeline(streams, (err) => {
          if (err && !this._destroyed) {
            this.stream?.emit('error', err)
          }
        })

        return decoder
      }
    } else if (_isMp4Format(lowerType)) {
      const demuxer = new MP4ToAACStream()
      streams.push(demuxer)
    }

    const decoder = new AACDecoderStream({ resamplingQuality })
    streams.push(decoder)

    this.pipes.push(...streams.slice(1))

    pipeline(streams, (err) => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createSymphoniaPipeline(stream, resamplingQuality) {
    const decoder = new SymphoniaDecoderStream({ resamplingQuality })
    this.pipes.push(decoder)

    pipeline(stream, decoder, (err) => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOpusPipeline(stream, type) {
    const decoder = new OpusDecoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      frameSize: AUDIO_CONFIG.frameSize
    })

    const streams = [stream]

    if (_isWebmFormat(type.toLowerCase())) {
      const demuxer = new WebmOpusDemuxer()
      streams.push(demuxer)
      this.pipes.push(demuxer)
    }

    streams.push(decoder)
    this.pipes.push(decoder)

    pipeline(streams, (err) => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOutputPipeline(
    pcmStream,
    nodelink,
    initialFilters,
    volume,
    audioMixer = null
  ) {
    const filters = new FiltersManager(nodelink, initialFilters)
    const volumeTransformer = new VolumeTransformer({ type: 's16le', volume })
    const fadeTransformer = new FadeTransformer({
      type: 's16le',
      volume: 1.0,
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })
    
    const flowController = new FlowController(filters, volumeTransformer, fadeTransformer, audioMixer)
    
    const opusEncoder = new OpusEncoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      frameSize: AUDIO_CONFIG.frameSize
    })

    opusEncoder.setDTX(false)

    const streams = [pcmStream, flowController]
    this.pipes.push(flowController)

    // Inject Audio Interceptors (Low-level stream manipulation)
    if (nodelink.extensions?.audioInterceptors) {
      for (const interceptorFactory of nodelink.extensions.audioInterceptors) {
        try {
          const interceptorStream = interceptorFactory()
          if (
            interceptorStream &&
            typeof interceptorStream.pipe === 'function'
          ) {
            streams.push(interceptorStream)
            this.pipes.push(interceptorStream)
          }
        } catch (e) {
          // Log error but don't break pipeline
          console.error(`Audio interceptor error: ${e.message}`)
        }
      }
    }

    streams.push(opusEncoder)
    this.pipes.push(opusEncoder)

    pipeline(streams, (err) => {
      if (err && !this._destroyed) {
        opusEncoder.emit('error', err)
      }
    })

    this.stream = opusEncoder
  }

  _createPCMOutputPipeline(pcmStream, volume) {
    if (volume !== 1.0) {
      const volumeTransformer = new VolumeTransformer({ type: 's16le', volume })
      this.pipes.push(volumeTransformer)

      pipeline(pcmStream, volumeTransformer, (err) => {
        if (err && !this._destroyed) {
          this.stream?.emit('error', err)
        }
      })

      this.stream = volumeTransformer
    } else {
      this.stream = pcmStream
    }
  }

  _setupEventHandlers(inputStream) {
    inputStream.on('finishBuffering', () => {
      this.stream?.emit('finishBuffering')
    })

    inputStream.on('error', (err) => {
      this.stream?.emit('error', err)
    })

    for (const pipe of this.pipes) {
      if (pipe !== this.stream) {
        pipe.on?.('error', (err) => {
          this.stream?.emit('error', err)
        })
      }
    }

    this.stream.on('error', () => {
      this._end()
    })
  }

  _createUnsupportedFormatError(type) {
    const supportedFormats = [
      'MP3 (audio/mpeg)',
      'AAC (audio/aac, audio/aacp, mp4, m4a, m4v, mov, hls, mpegurl, fmp4, mpegts)',
      'FLAC (audio/flac)',
      'OGG Vorbis (audio/ogg, audio/vorbis)',
      'WAV (audio/wav)',
      'Opus (webm/opus, ogg/opus)',
      'FLV (video/x-flv, flv)'
    ]

    return new Error(
      `Unsupported audio format: '${type}'.\n` +
        'Supported formats:\n' +
        supportedFormats.map((f) => `  • ${f}`).join('\n')
    )
  }
}

export const createAudioResource = (
  stream,
  type,
  nodelink,
  initialFilters = {},
  volume = 1.0,
  audioMixer = null,
  returnPCM = false
) =>
  new StreamAudioResource(
    stream,
    type,
    nodelink,
    initialFilters,
    volume,
    audioMixer,
    returnPCM
  )

export const createSeekeableAudioResource = async (
  url,
  seekTime,
  endTime,
  nodelink,
  initialFilters,
  player,
  volume = 1.0,
  audioMixer = null
) => {
  try {
    const { stream, meta } = await seekableStream(url, seekTime, endTime, {})

    const passthroughStream = new PassThrough({
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    passthroughStream.once('finish', () => {
      passthroughStream.emit('finishBuffering')
    })

    pipeline(stream, passthroughStream, (err) => {
      if (err) passthroughStream.emit('error', err)
    })

    const format = meta.codec?.container || player.streamInfo.format

    return new StreamAudioResource(
      passthroughStream,
      format,
      nodelink,
      initialFilters,
      volume,
      audioMixer
    )
  } catch (err) {
    const cause = err instanceof SeekError ? err.code : 'UNKNOWN'
    return _createErrorResponse(err.message, cause)
  }
}

export const createPCMStream = (
  stream,
  type,
  nodelink,
  volume = 1.0,
  filters = {}
) => {
  const resamplingQuality =
    nodelink.options.audio.resamplingQuality || 'fastest'
  const normalizedType = normalizeFormat(type)

  const streams = [stream]

  switch (normalizedType) {
    case SupportedFormats.AAC: {
      const lowerType = type.toLowerCase()

      if (_isFmp4Format(lowerType)) {
        // como eu coloquei options = {} no fmp4, ele aceita isso como o bufferMode, se incluir, vai passar true, se nao, vai passar false
        const bufferMode = lowerType.includes('fmp4-buffered')
        streams.push(new FMP4ToAACStream({ bufferMode }))
      }
      else if (_isMpegtsFormat(lowerType)) {
        streams.push(new MPEGTSDemuxer())

        if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
          streams.push(new SymphoniaDecoderStream({ resamplingQuality }))
          break
        }
      }
      else if (_isMp4Format(lowerType)) streams.push(new MP4ToAACStream())

      streams.push(new AACDecoderStream({ resamplingQuality }))
      break
    }

    case SupportedFormats.FLV: {
      streams.push(new FLVToAACStream())
      streams.push(new AACDecoderStream({ resamplingQuality }))
      break
    }

    case SupportedFormats.MPEG:
    case SupportedFormats.FLAC:
    case SupportedFormats.OGG_VORBIS:
    case SupportedFormats.WAV: {
      streams.push(new SymphoniaDecoderStream({ resamplingQuality }))
      break
    }

    case SupportedFormats.OPUS: {
      if (_isWebmFormat(type.toLowerCase())) {
        streams.push(new WebmOpusDemuxer())
      }
      streams.push(
        new OpusDecoder({
          rate: AUDIO_CONFIG.sampleRate,
          channels: AUDIO_CONFIG.channels,
          frameSize: AUDIO_CONFIG.frameSize
        })
      )
      break
    }

    default:
      throw new Error(`Unsupported audio format: '${type}'`)
  }

  streams.push(new VolumeTransformer({ type: 's16le', volume }))
  streams.push(new FiltersManager(nodelink, filters))

  for (const s of streams) {
    if (s !== stream) {
      s.on('error', (err) =>
        logger(
          'error',
          'PCMStream',
          `Component error (${s.constructor.name}): ${err.message} (${err.code})`
        )
      )
    }
  }

  pipeline(streams, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger(
        'error',
        'PCMStream',
        `Internal processing pipeline failed: ${err.message}`
      )
    }
  })

  return streams[streams.length - 1]
}
