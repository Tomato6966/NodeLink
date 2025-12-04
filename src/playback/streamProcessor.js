import { Buffer } from 'node:buffer'
import { PassThrough, Readable, Transform } from 'node:stream'

import LibSampleRate from '@alexanderolsen/libsamplerate-js'
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js'
import { SeekError, seekableStream } from '@ecliptia/seekable-stream'
import * as MP4Box from 'mp4box'

import { normalizeFormat, SupportedFormats } from '../constants.js'
import WebmOpusDemuxer from './demuxers/WebmOpus.js'
import { FiltersManager } from './filtersManager.js'
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from './opus/Opus.js'
import { VolumeTransformer } from './VolumeTransformer.js'
import { SymphoniaDecoder } from '@toddynnn/symphonia-decoder'

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

const AUDIO_CONSTANTS = Object.freeze({
  pcmFloatFactor: 32767,
  maxDecodesPerTick: 5,
  decodeIntervalMs: 10
})

const MPEGTS_CONFIG = Object.freeze({
  syncByte: 0x47,
  packetSize: 188,
  aacStreamType: 0x0f
})

const DOWNMIX_COEFFICIENTS = Object.freeze({
  center: 0.7071,
  surround: 0.7071,
  lfe: 0.5
})

const SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350
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

const _createAdtsHeader = (sampleLength, profile, samplingIndex, channelCount) => {
  const frameLength = sampleLength + 7
  const profileIndex = profile - 1

  return Buffer.from([
    0xff,
    0xf1,
    ((profileIndex & 0x03) << 6) | ((samplingIndex & 0x0f) << 2) | ((channelCount & 0x04) >> 2),
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
  type.indexOf('mpegts') !== -1 ||
  type.indexOf('video/mp2t') !== -1

const _isMp4Format = (type) =>
  type.indexOf('mp4') !== -1 ||
  type.indexOf('m4a') !== -1 ||
  type.indexOf('m4v') !== -1 ||
  type.indexOf('mov') !== -1

const _isWebmFormat = (type) =>
  type.indexOf('webm') !== -1

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

    const volumeTransformer = this.pipes.find((p) => p instanceof VolumeTransformer)

    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    } else {
      throw new Error('VolumeTransformer not found in the pipeline.')
    }
  }

  setFilters(filters) {
    if (!this.pipes) return

    const filterManager = this.pipes.find((p) => p instanceof FiltersManager)

    if (filterManager) {
      filterManager.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }

  emit(event, ...args) { this.stream?.emit(event, ...args) }
  on(event, listener) { this.stream?.on(event, listener) }
  off(event, listener) { this.stream?.off(event, listener) }
  once(event, listener) { this.stream?.once(event, listener) }
  removeListener(event, listener) { this.stream?.removeListener(event, listener) }

  removeAllListeners() {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      this.stream.removeAllListeners(eventName)
    }
  }

  read() { return this.stream?.read() }
  resume() { this.stream?.resume() }
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

  _transform(chunk, encoding, callback) {
    if (this._aborted || !this.decoder) {
      callback()
      return
    }

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
    if (this._loopScheduled || this._isDecoding || !this._isDecoderValid()) return

    this._loopScheduled = true

    this._timeoutId = setTimeout(() => {
      this._timeoutId = null
      this._loopScheduled = false
      if (this._isDecoderValid()) {
        this._decodeLoop()
      }
    }, AUDIO_CONSTANTS.decodeIntervalMs)
  }

  async _decodeLoop() {
    if (!this._isDecoderValid() || this.readableFlowing === false) return

    this._isDecoding = true

    try {
      let hasMoreData = true

      while (hasMoreData && this._isDecoderValid() && this.readableFlowing !== false) {
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
    if (bufferedBytes > 0 && this._isDecoderValid()) {
      this._scheduleDecode()
    }
  }

  async _processAudio() {
    if (!this._isDecoderValid()) return false

    if (!this.decoder.isProbed) {
      try {
        if (!this.decoder.initialize()) return false
      } catch (err) {
        throw new Error(`Symphonia init failed: ${err.message}`)
      }
    }

    let decodeCount = 0
    let hasOutput = false

    while (decodeCount < AUDIO_CONSTANTS.maxDecodesPerTick && this._isDecoderValid()) {
      const bufferedBytes = this.decoder?.bufferedBytes ?? 0
      const result = this.decoder?.decode()

      if (!result) break

      const { samples, sampleRate, channels } = result

      const output = sampleRate !== AUDIO_CONFIG.sampleRate
        ? await this._resample(samples, channels, sampleRate)
        : samples

      if (this._aborted) break

      const canPush = this.push(output)
      hasOutput = true
      decodeCount++

      if (this.resumeInput && bufferedBytes < BUFFER_THRESHOLDS.minCompressed) {
        const callback = this.resumeInput
        this.resumeInput = null
        callback()
      }

      if (!canPush) break
    }

    const remainingBytes = this.decoder?.bufferedBytes ?? 0
    return hasOutput || remainingBytes > 0
  }

  async _resample(pcmInt16, channels, inputRate) {
    if (this._aborted) return EMPTY_BUFFER

    if (!this.resampler) {
      this.resampler = await LibSampleRate.create(
        channels,
        inputRate,
        AUDIO_CONFIG.sampleRate,
        { converterType: _getResamplerConverterType(this.resamplingQuality) }
      )
    }

    const float32 = new Float32Array(
      pcmInt16.buffer,
      pcmInt16.byteOffset,
      pcmInt16.length / 2
    )

    return _floatToInt16Buffer(this.resampler.full(float32))
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

      let result
      let count = 0
      while ((result = this.decoder?.decode()) !== null && result && count < 10) {
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

class MPEGTSToAACStream extends Transform {
  constructor(options) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.buffer = EMPTY_BUFFER
    this.patPmtId = null
    this.aacPid = null
    this.aacData = EMPTY_BUFFER
    this.aacPidFound = false
    this._aborted = false
  }

  abort() {
    this._aborted = true
    this.buffer = EMPTY_BUFFER
    this.aacData = EMPTY_BUFFER
  }

  _transform(chunk, encoding, callback) {
    if (this._aborted) {
      callback()
      return
    }

    try {
      const data = this.buffer.length > 0
        ? Buffer.concat([this.buffer, chunk])
        : chunk

      this.buffer = EMPTY_BUFFER

      const dataLength = data.length
      let position = 0

      while (position <= dataLength - MPEGTS_CONFIG.packetSize && !this._aborted) {
        if (data[position] !== MPEGTS_CONFIG.syncByte) {
          const syncIndex = data.indexOf(MPEGTS_CONFIG.syncByte, position + 1)
          if (syncIndex === -1) {
            position = dataLength
            break
          }
          position = syncIndex
          continue
        }

        const packet = data.subarray(position, position + MPEGTS_CONFIG.packetSize)

        const payloadUnitStartIndicator = !!(packet[1] & 0x40)
        const pid = ((packet[1] & 0x1f) << 8) + packet[2]
        const adaptationFieldControl = (packet[3] & 0x30) >> 4

        let offset = 4
        if (adaptationFieldControl > 1) {
          offset = 5 + packet[4]
          if (offset >= MPEGTS_CONFIG.packetSize) {
            position += MPEGTS_CONFIG.packetSize
            continue
          }
        }

        this._processPacket(packet, pid, payloadUnitStartIndicator, offset)

        position += MPEGTS_CONFIG.packetSize
      }

      if (position < dataLength && !this._aborted) {
        this.buffer = data.subarray(position)
      }

      callback()
    } catch {
      callback()
    }
  }

  _processPacket(packet, pid, pusi, offset) {
    if (pid === 0 && pusi) {
      this._processPAT(packet, offset)
    } else if (this.patPmtId && pid === this.patPmtId && pusi) {
      this._processPMT(packet, offset)
    } else if (this.aacPid && pid === this.aacPid) {
      this._processAACPacket(packet, pusi, offset)
    }
  }

  _processPAT(packet, offset) {
    offset += packet[offset] + 1
    this.patPmtId = ((packet[offset + 10] & 0x1f) << 8) | packet[offset + 11]
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
      const esInfoLength = ((packet[offset + 3] & 0x0f) << 8) | packet[offset + 4]

      if (streamType === MPEGTS_CONFIG.aacStreamType && !this.aacPidFound) {
        this.aacPid = elementaryPid
        this.aacPidFound = true
        return
      }

      offset += 5 + esInfoLength
    }
  }

  _processAACPacket(packet, pusi, offset) {
    if (pusi) {
      if (this.aacData.length > 0 && !this._aborted) {
        this.push(this.aacData)
        this.aacData = EMPTY_BUFFER
      }

      const pesHeaderLength = packet[offset + 8]
      offset += 9 + pesHeaderLength

      if (offset >= MPEGTS_CONFIG.packetSize) return
    }

    if (!this._aborted) {
      this.aacData = Buffer.concat([this.aacData, packet.subarray(offset)])
    }
  }

  _flush(callback) {
    if (this.aacData.length > 0 && !this._aborted) {
      this.push(this.aacData)
    }
    this.aacData = EMPTY_BUFFER
    this.buffer = EMPTY_BUFFER
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true
    this.buffer = EMPTY_BUFFER
    this.aacData = EMPTY_BUFFER
    super._destroy(err, callback)
  }
}

class AACDecoderStream extends Transform {
  constructor(options) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.decoder = new FAAD2NodeDecoder()
    this.resampler = null
    this.resamplerCreationPromise = null
    this.resamplingQuality = options?.resamplingQuality || 'fastest'

    this.isDecoderReady = false
    this.isConfigured = false
    this.pendingChunks = []
    this.buffer = EMPTY_BUFFER
    this._aborted = false

    this.decoder.ready
      .then(() => {
        if (this._aborted) return
        this.isDecoderReady = true
        this.emit('decoderReady')
        this._processPendingChunks()
      })
      .catch((err) => {
        if (!this._aborted) this.emit('error', err)
      })
  }

  abort() {
    this._aborted = true
    this.buffer = EMPTY_BUFFER
    this.pendingChunks = []
  }

  _downmixToStereo(interleavedPCM, channels, samplesPerChannel) {
    if (channels === AUDIO_CONFIG.channels) return interleavedPCM

    const stereo = new Float32Array(samplesPerChannel * 2)
    const { center, surround, lfe } = DOWNMIX_COEFFICIENTS

    if (channels === 1) {
      for (let i = 0; i < samplesPerChannel; i++) {
        const value = interleavedPCM[i]
        stereo[i * 2] = value
        stereo[i * 2 + 1] = value
      }
      return stereo
    }

    for (let i = 0; i < samplesPerChannel; i++) {
      const offset = i * channels
      let left = 0
      let right = 0

      switch (channels) {
        case 3:
          left = interleavedPCM[offset + 1] + interleavedPCM[offset] * center
          right = interleavedPCM[offset + 2] + interleavedPCM[offset] * center
          break

        case 4:
          left = interleavedPCM[offset + 1] + interleavedPCM[offset] * center +
                 interleavedPCM[offset + 3] * surround * 0.5
          right = interleavedPCM[offset + 2] + interleavedPCM[offset] * center +
                  interleavedPCM[offset + 3] * surround * 0.5
          break

        case 5:
          left = interleavedPCM[offset + 1] + interleavedPCM[offset] * center +
                 interleavedPCM[offset + 3] * surround
          right = interleavedPCM[offset + 2] + interleavedPCM[offset] * center +
                  interleavedPCM[offset + 4] * surround
          break

        case 6:
          left = interleavedPCM[offset + 1] + interleavedPCM[offset] * center +
                 interleavedPCM[offset + 3] * surround + interleavedPCM[offset + 5] * lfe
          right = interleavedPCM[offset + 2] + interleavedPCM[offset] * center +
                  interleavedPCM[offset + 4] * surround + interleavedPCM[offset + 5] * lfe
          break

        default:
          left = interleavedPCM[offset]
          right = interleavedPCM[offset + 1] || left
      }

      stereo[i * 2] = _clampSample(left)
      stereo[i * 2 + 1] = _clampSample(right)
    }

    return stereo
  }

  async _processPendingChunks() {
    if (!this.isDecoderReady || this.pendingChunks.length === 0 || this._aborted) return

    const chunks = this.pendingChunks
    this.pendingChunks = []

    for (const { chunk, encoding, callback } of chunks) {
      if (this._aborted) {
        callback()
        continue
      }
      await this._decodeChunk(chunk, encoding, callback)
    }
  }

  _findADTSFrame(buffer) {
    const minLength = 7

    for (let i = 0; i < buffer.length - minLength; i++) {
      const syncword = (buffer[i] << 4) | (buffer[i + 1] >> 4)

      if (syncword === 0xfff) {
        const frameLength = ((buffer[i + 3] & 0x03) << 11) |
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
    if (this._aborted) {
      callback()
      return
    }

    if (!this.isDecoderReady) {
      this.pendingChunks.push({ chunk, encoding, callback })
      return
    }
    this._decodeChunk(chunk, encoding, callback)
  }

  async _decodeChunk(chunk, encoding, callback) {
    if (this._aborted || !this.decoder) {
      callback()
      return
    }

    try {
      this.buffer = Buffer.concat([this.buffer, chunk])

      if (!this.isConfigured) {
        const frameInfo = this._findADTSFrame(this.buffer)
        if (frameInfo) {
          try {
            await this.decoder.configure(frameInfo.frame, true)
            this.isConfigured = true
          } catch (err) {
            this.buffer = this.buffer.subarray(frameInfo.end)
            return callback(err)
          }
        } else {
          return callback()
        }
      }

      await this._decodeFrames()

      callback()
    } catch (err) {
      callback(err)
    }
  }

  async _decodeFrames() {
    let framesDecoded = 0
    const maxFramesPerCall = 5

    while (this.buffer.length > 0 && framesDecoded < maxFramesPerCall && !this._aborted && this.decoder) {
      const frameInfo = this._findADTSFrame(this.buffer)
      if (!frameInfo) break

      try {
        const result = this.decoder?.decode(frameInfo.frame)

        if (result?.pcm?.length > 0 && !this._aborted) {
          await this._processDecodedFrame(result)
          framesDecoded++
        }
      } catch {}

      this.buffer = this.buffer.subarray(frameInfo.end)
    }
  }

  async _processDecodedFrame(result) {
    if (this._aborted) return

    let { pcm, sampleRate, channels, samplesPerChannel } = result

    if (channels !== AUDIO_CONFIG.channels) {
      pcm = this._downmixToStereo(pcm, channels, samplesPerChannel)
    }

    if (sampleRate !== AUDIO_CONFIG.sampleRate) {
      await this._ensureResampler(sampleRate)
      if (!this._aborted && this.resampler) {
        this.push(_floatToInt16Buffer(this.resampler.full(pcm)))
      }
    } else if (!this._aborted) {
      this.push(_floatToInt16Buffer(pcm))
    }
  }

  async _ensureResampler(sampleRate) {
    if (this._aborted) return

    if (!this.resampler && !this.resamplerCreationPromise) {
      this.resamplerCreationPromise = LibSampleRate.create(
        AUDIO_CONFIG.channels,
        sampleRate,
        AUDIO_CONFIG.sampleRate,
        { converterType: _getResamplerConverterType(this.resamplingQuality) }
      ).then((resampler) => {
        this.resampler = resampler
        this.resamplerCreationPromise = null
        return resampler
      })
    }

    if (!this.resampler) {
      await this.resamplerCreationPromise
    }
  }

  _flush(callback) {
    if (this._aborted || !this.decoder) {
      this._cleanup()
      callback()
      return
    }

    if (this.buffer.length > 0 && this.isConfigured) {
      try {
        const frameInfo = this._findADTSFrame(this.buffer)
        if (frameInfo) {
          const result = this.decoder?.decode(frameInfo.frame)
          if (result?.pcm) {
            this.push(_floatToInt16Buffer(result.pcm))
          }
        }
      } catch {}
    }

    this._cleanup()
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true

    for (const { callback: cb } of this.pendingChunks) {
      cb()
    }
    this.pendingChunks = []
    this.buffer = EMPTY_BUFFER

    this._cleanup()
    super._destroy(err, callback)
  }

  _cleanup() {
    if (this.resampler) {
      try {
        this.resampler.destroy()
      } catch {}
      this.resampler = null
    }

    if (this.decoder) {
      try {
        this.decoder.destroy()
      } catch {}
      this.decoder = null
    }
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
        this.mp4boxFile.setExtractionOptions(audioTrack.id, null, { nbSamples: 1 })
        this.mp4boxFile.start()
        this.isReady = true
      } catch (err) {
        this.emit('error', new Error(`MP4 initialization error: ${err.message}`))
      }
    }

    this.mp4boxFile.onSamples = (id, user, samples) => {
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
          this.emit('error', new Error(`MP4Box sample processing error: ${err.message}`))
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

    const sampleData = sample.data instanceof ArrayBuffer
      ? Buffer.from(sample.data)
      : Buffer.from(sample.data.buffer || sample.data)

    this.push(_createAdtsHeader(sampleData.byteLength, profile, samplingIndex, channelCount))
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
          const coreSamplingIndex = SAMPLE_RATES.indexOf(track.audio.sample_rate / 2)
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

  _transform(chunk, encoding, callback) {
    if (this._aborted || !this.mp4boxFile) {
      callback()
      return
    }

    try {
      const arrayBuffer = chunk instanceof ArrayBuffer
        ? chunk
        : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)

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

class FMP4ToAACStream extends Transform {
  constructor(options) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })
    this.audioConfig = null
    this.initSegmentProcessed = false
    this._aborted = false
  }

  abort() {
    this._aborted = true
  }

  _extractAudioConfigFromInit(initSegment) {
    const boxes = _parseBoxes(initSegment)

    const stblBoxes = _findNestedBox(boxes, 'moov', 'trak', 'mdia', 'minf', 'stbl')
    if (!stblBoxes) return null

    const stsdBox = stblBoxes.find((b) => b.type === 'stsd')
    if (!stsdBox || stsdBox.data.length < 16) return null

    const mp4aBox = _parseBoxes(stsdBox.data, 8).find((b) => b.type === 'mp4a')
    if (!mp4aBox || mp4aBox.data.length < 28) return null

    const mp4a = mp4aBox.data
    const channelCount = mp4a.readUInt16BE(16)
    const sampleRate = mp4a.readUInt32BE(24) >> 16
    const samplingIndex = SAMPLE_RATES.indexOf(sampleRate)

    return {
      profile: 2,
      samplingIndex: samplingIndex !== -1 ? samplingIndex : 4,
      channelCount,
      sampleRate
    }
  }

  _extractAACFromSegment(buffer) {
    if (!this.audioConfig) return null

    const boxes = _parseBoxes(buffer)

    const mdatBox = boxes.find((b) => b.type === 'mdat')
    if (!mdatBox) return null

    const aacData = mdatBox.data

    const sampleSizes = this._extractSampleSizes(boxes)

    if (sampleSizes && sampleSizes.length > 0) {
      return this._wrapSamplesWithADTS(aacData, sampleSizes)
    }

    return null
  }

  _extractSampleSizes(boxes) {
    const moofBox = boxes.find((b) => b.type === 'moof')
    if (!moofBox) return null

    const moofBoxes = _parseBoxes(moofBox.data)
    const trafBox = moofBoxes.find((b) => b.type === 'traf')
    if (!trafBox) return null

    const trafBoxes = _parseBoxes(trafBox.data)
    const trunBox = trafBoxes.find((b) => b.type === 'trun')
    if (!trunBox || trunBox.data.length < 8) return null

    const trun = trunBox.data
    const flags = (trun[1] << 16) | (trun[2] << 8) | trun[3]
    const sampleCount = trun.readUInt32BE(4)

    let offset = 8

    if (flags & 0x1) offset += 4
    if (flags & 0x4) offset += 4

    const sampleSizes = []
    const hasSampleSize = !!(flags & 0x200)

    for (let i = 0; i < sampleCount && offset < trun.length; i++) {
      if (flags & 0x100) offset += 4
      if (hasSampleSize && offset + 4 <= trun.length) {
        sampleSizes.push(trun.readUInt32BE(offset))
        offset += 4
      }
      if (flags & 0x400) offset += 4
      if (flags & 0x800) offset += 4
    }

    return sampleSizes
  }

  _wrapSamplesWithADTS(aacData, sampleSizes) {
    const { profile, samplingIndex, channelCount } = this.audioConfig
    const frames = []
    let dataOffset = 0

    for (const sampleSize of sampleSizes) {
      if (dataOffset + sampleSize <= aacData.length) {
        frames.push(_createAdtsHeader(sampleSize, profile, samplingIndex, channelCount))
        frames.push(aacData.subarray(dataOffset, dataOffset + sampleSize))
        dataOffset += sampleSize
      }
    }

    return frames.length > 0 ? Buffer.concat(frames) : null
  }

  _transform(chunk, encoding, callback) {
    if (this._aborted) {
      callback()
      return
    }

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

      if (this.audioConfig && !this._aborted) {
        const aacData = this._extractAACFromSegment(chunk)
        if (aacData) {
          this.push(aacData)
        }
      }

      callback()
    } catch {
      callback()
    }
  }

  _flush(callback) {
    callback()
  }

  _destroy(err, callback) {
    this._aborted = true
    super._destroy(err, callback)
  }
}

class StreamAudioResource extends BaseAudioResource {
  constructor(stream, type, nodelink, initialFilters = {}, volume = 1.0) {
    super()

    this._validateInputStream(stream)

    const resamplingQuality = nodelink.options.audio.resamplingQuality || 'fastest'
    const normalizedType = normalizeFormat(type)

    this.pipes = [stream]

    const pcmStream = this._createDecoderPipeline(
      stream,
      type,
      normalizedType,
      resamplingQuality
    )

    this._createOutputPipeline(pcmStream, nodelink, initialFilters, volume)
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

  _createAACPipeline(stream, type, resamplingQuality) {
    const lowerType = type.toLowerCase()
    let aacStream = stream

    if (_isFmp4Format(lowerType)) {
      const demuxer = new FMP4ToAACStream()
      aacStream = stream.pipe(demuxer)
      this.pipes.push(demuxer)
    } else if (_isMpegtsFormat(lowerType)) {
      const demuxer = new MPEGTSToAACStream()
      aacStream = stream.pipe(demuxer)
      this.pipes.push(demuxer)
    } else if (_isMp4Format(lowerType)) {
      const demuxer = new MP4ToAACStream()
      aacStream = stream.pipe(demuxer)
      this.pipes.push(demuxer)
    }

    const decoder = new AACDecoderStream({ resamplingQuality })
    this.pipes.push(decoder)

    return aacStream.pipe(decoder)
  }

  _createSymphoniaPipeline(stream, resamplingQuality) {
    const decoder = new SymphoniaDecoderStream({ resamplingQuality })
    this.pipes.push(decoder)
    return stream.pipe(decoder)
  }

  _createOpusPipeline(stream, type) {
    const decoder = new OpusDecoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      frameSize: AUDIO_CONFIG.frameSize
    })

    if (_isWebmFormat(type.toLowerCase())) {
      const demuxer = new WebmOpusDemuxer()
      this.pipes.push(demuxer, decoder)
      return stream.pipe(demuxer).pipe(decoder)
    }

    this.pipes.push(decoder)
    return stream.pipe(decoder)
  }

  _createOutputPipeline(pcmStream, nodelink, initialFilters, volume) {
    const volumeTransformer = new VolumeTransformer({ type: 's16le', volume })
    const filters = new FiltersManager(nodelink, initialFilters)
    const opusEncoder = new OpusEncoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels,
      frameSize: AUDIO_CONFIG.frameSize
    })

    pcmStream.pipe(volumeTransformer).pipe(filters).pipe(opusEncoder)

    this.pipes.push(volumeTransformer, filters, opusEncoder)
    this.stream = opusEncoder
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
      'Opus (webm/opus, ogg/opus)'
    ]

    return new Error(
      `Unsupported audio format: '${type}'.\n` +
      'Supported formats:\n' +
      supportedFormats.map((f) => `  • ${f}`).join('\n')
    )
  }
}

export const createAudioResource = (stream, type, nodelink, initialFilters = {}, volume = 1.0) =>
  new StreamAudioResource(stream, type, nodelink, initialFilters, volume)

export const createSeekeableAudioResource = async (
  url,
  seekTime,
  endTime,
  nodelink,
  initialFilters,
  player,
  volume = 1.0
) => {
  try {
    const { stream, meta } = await seekableStream(url, seekTime, endTime, {})

    const passthroughStream = new PassThrough({ highWaterMark: AUDIO_CONFIG.highWaterMark })

    stream.on('data', (chunk) => passthroughStream.write(chunk))
    stream.on('end', () => {
      passthroughStream.end()
      passthroughStream.emit('finishBuffering')
    })
    stream.on('error', (err) => passthroughStream.emit('error', err))

    const format = meta.codec?.container || player.streamInfo.format

    return new StreamAudioResource(
      passthroughStream,
      format,
      nodelink,
      initialFilters,
      volume
    )
  } catch (err) {
    const cause = err instanceof SeekError ? err.code : 'UNKNOWN'
    return _createErrorResponse(err.message, cause)
  }
}
