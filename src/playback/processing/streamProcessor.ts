/** biome-ignore-all assist/source/organizeImports: <no-op> */
import {
  PassThrough,
  Readable,
  Transform,
  pipeline,
  type TransformCallback,
  type TransformOptions
} from 'node:stream'
import LibSampleRate from '@alexanderolsen/libsamplerate-js'
import FAAD2NodeDecoder from '@ecliptia/faad2-wasm/faad2_node_decoder.js'
import { SeekError, seekableStream } from '@ecliptia/seekable-stream'
import type { VoiceAudioStream } from '@performanc/voice'
import { SymphoniaDecoder } from '@toddynnn/symphonia-decoder'
import * as MP4Box from 'mp4box'
import { normalizeFormat, SupportedFormats } from '../../constants.ts'
import type {
  AudioMixer,
  FiltersState,
  NodeLink,
  StreamInfo
} from '../../typings/playback/player.types.ts'
import type {
  AACConfig,
  AACDecoderStreamOptions,
  ADTSFrameInfo,
  AudioConfig,
  AudioConstants,
  BufferThresholds,
  ConverterType,
  ErrorResponse,
  FAAD2DecoderLike,
  FlvDemuxerLike,
  FMP4StreamOptions,
  FMP4StreamState,
  MP4BoxFile,
  MP4BoxInfo,
  MP4BoxSample,
  MP4BoxTrack,
  MP4Box as MP4BoxType,
  MpegtsConfig,
  PendingChunk,
  ResamplerLike,
  ResamplingQuality,
  RingBufferLike,
  SeekableStreamMeta,
  SymphoniaDecoderLike
} from '../../typings/playback/streamProcessor.types.ts'
import { logger } from '../../utils.js'
import FlvDemuxer from '../demuxers/Flv.ts'
import WebmOpusDemuxer from '../demuxers/WebmOpus.ts'
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from '../opus/Opus.ts'
import { RingBuffer } from '../structs/RingBuffer.js'
import { FadeTransformer } from './FadeTransformer.js'
import { FlowController } from './FlowController.js'
import { FiltersManager } from './filtersManager.ts'
import { VolumeTransformer } from './VolumeTransformer.js'

const AUDIO_CONFIG: AudioConfig = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  frameSize: 960,
  highWaterMark: 19200
})

const BUFFER_THRESHOLDS: BufferThresholds = Object.freeze({
  maxCompressed: 256 * 1024,
  minCompressed: 128 * 1024
})

const AAC_BUFFER_SIZE: number = 2 * 1024 * 1024

const AUDIO_CONSTANTS: AudioConstants = Object.freeze({
  pcmFloatFactor: 32767,
  maxDecodesPerTick: 5,
  decodeIntervalMs: 10
})

const MPEGTS_CONFIG: MpegtsConfig = Object.freeze({
  syncByte: 0x47,
  packetSize: 188,
  aacStreamType: 0x0f,
  mp3StreamType: 0x03,
  mp3StreamType2: 0x04
})

const _DOWNMIX_COEFFICIENTS: Readonly<{
  center: number
  surround: number
  lfe: number
}> = Object.freeze({
  center: Math.SQRT1_2,
  surround: Math.SQRT1_2,
  lfe: 0.5
})

const SAMPLE_RATES: readonly number[] = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

const EMPTY_BUFFER: Buffer = Buffer.alloc(0)

const _getResamplerConverterType = (
  quality: ResamplingQuality
): ConverterType => {
  const types = LibSampleRate.ConverterType
  const qualityMap: Record<string, ConverterType> = {
    best: types.SRC_SINC_BEST_QUALITY,
    medium: types.SRC_SINC_MEDIUM_QUALITY,
    fastest: types.SRC_SINC_FASTEST,
    'zero order holder': types.SRC_ZERO_ORDER_HOLD,
    linear: types.SRC_LINEAR
  }
  return qualityMap[quality] || types.SRC_SINC_FASTEST
}

const _clampSample = (value: number): number => {
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

const _floatToInt16Buffer = (floatArray: Float32Array): Buffer => {
  const length = floatArray.length
  const output = new Int16Array(length)

  for (let i = 0; i < length; i++) {
    output[i] =
      _clampSample(floatArray[i] || 0) * AUDIO_CONSTANTS.pcmFloatFactor
  }

  return Buffer.from(output.buffer)
}

const _createAdtsHeader = (
  sampleLength: number,
  profile: number,
  samplingIndex: number,
  channelCount: number
): Buffer => {
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

const _parseBoxes = (buffer: Buffer, offset: number = 0): MP4BoxType[] => {
  const boxes: MP4BoxType[] = []
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

const _findNestedBox = (
  boxes: MP4BoxType[],
  ...path: string[]
): MP4BoxType[] | null => {
  let current = boxes

  for (const boxType of path) {
    const box = current.find((b) => b.type === boxType)
    if (!box) return null
    current = _parseBoxes(box.data)
  }

  return current
}

const _createErrorResponse = (
  message: string,
  cause: string = 'UNKNOWN'
): ErrorResponse => ({
  exception: {
    message,
    severity: 'fault',
    cause
  }
})

const _isFmp4Format = (type: string): boolean =>
  type.indexOf('fmp4') !== -1 ||
  type.indexOf('hls') !== -1 ||
  type.indexOf('mpegurl') !== -1

const _isMpegtsFormat = (type: string): boolean =>
  type.indexOf('mpegts') !== -1 || type.indexOf('video/mp2t') !== -1

const _isMp4Format = (type: string): boolean =>
  type.indexOf('mp4') !== -1 ||
  type.indexOf('m4a') !== -1 ||
  type.indexOf('m4v') !== -1 ||
  type.indexOf('mov') !== -1

const _isWebmFormat = (type: string): boolean => type.indexOf('webm') !== -1

const _isFlvFormat = (type: string): boolean => type.indexOf('flv') !== -1

class BaseAudioResource {
  pipes: (Readable | Transform)[] | null
  stream: (VoiceAudioStream & Transform) | null
  protected _destroyed: boolean

  constructor() {
    this.pipes = []
    this.stream = null
    this._destroyed = false
  }

  protected _assignStream(stream: Transform): void {
    const voiceStream = stream as unknown as VoiceAudioStream & Transform
    voiceStream.setVolume = (volume: number) => this.setVolume(volume)
    voiceStream.setFilters = (filters: FiltersState) => this.setFilters(filters)
    this.stream = voiceStream
  }

  _end(): void {
    if (this._destroyed || !this.pipes) return
    this._destroyed = true

    const firstPipe = this.pipes[0] as Readable & {
      stopHls?: () => void
      responseStream?: { destroyed: boolean; destroy: () => void }
    }

    if (firstPipe?.stopHls) {
      firstPipe.stopHls()
    }

    if (firstPipe?.responseStream?.destroyed === false) {
      firstPipe.responseStream.destroy()
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      const pipe = this.pipes[i] as Transform & {
        abort?: () => void
        unpipe?: () => void
        destroy?: () => void
        removeAllListeners?: () => void
      }
      pipe.abort?.()
      pipe.unpipe?.()
      pipe.destroy?.()
      pipe.removeAllListeners?.()
    }

    this.stream = null
    this.pipes = null
  }

  destroy(): void {
    this._end()
  }

  setVolume(volume: number): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setVolume(volume)
      return
    }

    const volumeTransformer = this.pipes.find(
      (p) => p instanceof VolumeTransformer
    ) as VolumeTransformer | undefined

    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    } else {
      throw new Error('VolumeTransformer not found in the pipeline.')
    }
  }

  setFilters(filters: FiltersState): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setFilters(filters)
      return
    }

    const filterManager = this.pipes.find((p) => p instanceof FiltersManager) as
      | FiltersManager
      | undefined

    if (filterManager) {
      filterManager.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }

  setFadeVolume(volume: number): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.setFadeVolume(volume)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    ) as FadeTransformer | undefined

    if (fadeTransformer) {
      fadeTransformer.setGain(volume)
    } else {
      throw new Error('FadeTransformer not found in the pipeline.')
    }
  }

  fadeTo(volume: number, durationMs: number, curve?: string): void {
    if (!this.pipes) return

    const flowController = this.pipes.find(
      (p) => p instanceof FlowController
    ) as FlowController | undefined
    if (flowController) {
      flowController.fadeTo(volume, durationMs, curve)
      return
    }

    const fadeTransformer = this.pipes.find(
      (p) => p instanceof FadeTransformer
    ) as FadeTransformer | undefined

    if (fadeTransformer) {
      fadeTransformer.fadeTo(volume, durationMs, curve)
    } else {
      throw new Error('FadeTransformer not found in the pipeline.')
    }
  }

  emit(event: string, ...args: unknown[]): void {
    this.stream?.emit(event, ...args)
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.on(event, listener)
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.off(event, listener)
  }
  once(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.once(event, listener)
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.stream?.removeListener(event, listener)
  }

  removeAllListeners(): void {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      this.stream.removeAllListeners(eventName)
    }
  }

  read(): Buffer | null {
    return (this.stream?.read() as Buffer | null) ?? null
  }
  resume(): void {
    this.stream?.resume()
  }
}

class SymphoniaDecoderStream extends Transform {
  private decoder: SymphoniaDecoderLike | null
  private resampler: ResamplerLike | null
  private resamplingQuality: string
  private resumeInput: ((error?: Error | null) => void) | null
  private isFinished: boolean
  private _aborted: boolean
  private _loopScheduled: boolean
  private _isDecoding: boolean
  private _timeoutId: ReturnType<typeof setTimeout> | null
  private _immediateId: ReturnType<typeof setImmediate> | null

  constructor(
    options: {
      resamplingQuality?: string
      highWaterMark?: number
      objectMode?: boolean
    } = {}
  ) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark,
      objectMode: false
    })

    this.decoder = new SymphoniaDecoder() as SymphoniaDecoderLike
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

  abort(): void {
    this._aborted = true
    this._cancelTimers()
  }

  _cancelTimers(): void {
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

  _isDecoderValid(): boolean {
    return this.decoder !== null && !this._aborted && !this.isFinished
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
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

  _scheduleDecode(): void {
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

  async _decodeLoop(): Promise<void> {
    if (!this._isDecoderValid() || (this.readableFlowing as boolean) === false)
      return
    this._isDecoding = true

    try {
      let hasMoreData = true

      while (
        hasMoreData &&
        this._isDecoderValid() &&
        (this.readableFlowing as boolean) !== false &&
        this.readableLength < this.readableHighWaterMark
      ) {
        hasMoreData = await this._processAudio()

        if (hasMoreData && this._isDecoderValid()) {
          await new Promise<void>((resolve) => {
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
      (this.readableFlowing as boolean) !== false &&
      this.readableLength < this.readableHighWaterMark
    ) {
      this._scheduleDecode()
    }
  }

  async _processAudio(): Promise<boolean> {
    if (!this._isDecoderValid()) return false
    if (this.readableLength >= this.readableHighWaterMark) return true

    if (!this.decoder?.isProbed) {
      try {
        if (!this.decoder?.initialize()) return false
      } catch (err) {
        throw new Error(`Symphonia init failed: ${(err as Error).message}`)
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

  async _resample(
    pcmInt16Buf: Buffer,
    channels: number,
    inputRate: number
  ): Promise<Buffer> {
    if (this._aborted) return EMPTY_BUFFER

    if (!this.resampler) {
      this.resampler = await LibSampleRate.create(
        channels,
        inputRate,
        AUDIO_CONFIG.sampleRate,
        {
          converterType: _getResamplerConverterType(
            this.resamplingQuality as ResamplingQuality
            // biome-ignore lint/suspicious/noExplicitAny: library type mismatch
          ) as any
        }
      )
    }

    const i16 = new Int16Array(
      pcmInt16Buf.buffer,
      pcmInt16Buf.byteOffset,
      pcmInt16Buf.byteLength / 2
    )

    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] ?? 0) / 32768

    return _floatToInt16Buffer(this.resampler?.full(f32) || new Float32Array(0))
  }

  override _flush(callback: TransformCallback): void {
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

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
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

  _cleanup(): void {
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
  private ringBuffer: RingBufferLike
  private patPmtId: number | null
  private audioPid: number | null
  private audioPidFound: boolean
  private _aborted: boolean
  private pesBuffer: Buffer

  constructor(options?: { highWaterMark?: number }) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.ringBuffer = new RingBuffer(
      BUFFER_THRESHOLDS.maxCompressed
    ) as RingBufferLike
    this.patPmtId = null
    this.audioPid = null
    this.audioPidFound = false
    this._aborted = false
    this.pesBuffer = Buffer.alloc(0)
  }

  abort(): void {
    this._aborted = true
    this.ringBuffer.clear()
    this.pesBuffer = Buffer.alloc(0)
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this._aborted) {
      callback()
      return
    }

    try {
      this.ringBuffer.write(chunk)

      while (
        this.ringBuffer.length >= MPEGTS_CONFIG.packetSize &&
        !this._aborted
      ) {
        const head = this.ringBuffer.peek(1)
        if (!head || head.length === 0 || head[0] !== MPEGTS_CONFIG.syncByte) {
          this.ringBuffer.read(1)
          continue
        }

        const packet = this.ringBuffer.read(MPEGTS_CONFIG.packetSize)
        if (!packet || packet.length < MPEGTS_CONFIG.packetSize) continue

        const pusi = !!((packet[1] ?? 0) & 0x40)
        const pid = (((packet[1] ?? 0) & 0x1f) << 8) | (packet[2] ?? 0)
        const afc = ((packet[3] ?? 0) & 0x30) >> 4

        let offset = 4
        if (afc > 1) {
          offset = 5 + (packet[4] ?? 0)
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

  _processPAT(packet: Buffer, offset: number): void {
    offset += (packet[offset] || 0) + 1
    if (offset + 11 < MPEGTS_CONFIG.packetSize) {
      this.patPmtId =
        ((packet[offset + 10] || 0 & 0x1f) << 8) | (packet[offset + 11] || 0)
    }
  }

  _processPMT(packet: Buffer, offset: number): void {
    offset += (packet[offset] || 0) + 1
    const sectionLength =
      (((packet[offset + 1] || 0) & 0x0f) << 8) | (packet[offset + 2] || 0)
    const tableEnd = offset + 3 + sectionLength - 4
    const programInfoLength =
      (((packet[offset + 10] || 0) & 0x0f) << 8) | (packet[offset + 11] || 0)
    offset += 12 + programInfoLength

    while (offset < tableEnd && offset < MPEGTS_CONFIG.packetSize) {
      const streamType = packet[offset] || 0
      const elementaryPid =
        (((packet[offset + 1] || 0) & 0x1f) << 8) | (packet[offset + 2] || 0)

      if (
        (streamType === MPEGTS_CONFIG.aacStreamType ||
          streamType === MPEGTS_CONFIG.mp3StreamType ||
          streamType === MPEGTS_CONFIG.mp3StreamType2) &&
        !this.audioPidFound
      ) {
        this.audioPid = elementaryPid
        this.audioPidFound = true
        return
      }
      const esInfoLen =
        (((packet[offset + 3] || 0) & 0x0f) << 8) | (packet[offset + 4] || 0)
      offset += 5 + esInfoLen
    }
  }

  _processAudioPacket(packet: Buffer, pusi: boolean, offset: number): void {
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

  _emitPES(buffer: Buffer): void {
    if (buffer.length < 9) return

    if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01) {
      const headerLength = buffer[8] || 0
      const payloadOffset = 9 + headerLength

      if (payloadOffset < buffer.length) {
        this.push(buffer.subarray(payloadOffset))
      }
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.pesBuffer.length > 0) {
      this._emitPES(this.pesBuffer)
    }
    this.pesBuffer = Buffer.alloc(0)
    this.ringBuffer.clear()
    callback()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
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
  private decoder: FAAD2DecoderLike
  private resampler: ResamplerLike | null
  private isDecoderReady: boolean
  private isConfigured: boolean
  private pendingChunks: PendingChunk[]
  private ringBuffer: RingBufferLike
  private resamplingQuality: string
  private resamplerCreationPromise: Promise<ResamplerLike> | null

  constructor(options: AACDecoderStreamOptions) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })
    this.decoder = new FAAD2NodeDecoder() as unknown as FAAD2DecoderLike
    this.resampler = null
    this.isDecoderReady = false
    this.isConfigured = false
    this.pendingChunks = []
    this.ringBuffer = new RingBuffer(AAC_BUFFER_SIZE) as RingBufferLike
    this.resamplingQuality = options.resamplingQuality || 'fastest'
    this.resamplerCreationPromise = null

    this.decoder.ready
      .then(() => {
        this.isDecoderReady = true
        this._processPendingChunks()
      })
      .catch((err: Error) => this.emit('error', err))
  }

  override _destroy(
    err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    this.ringBuffer.dispose()
    if (this.decoder) this.decoder.free?.()
    if (this.resampler) this.resampler.destroy?.()
    super._destroy(err, cb)
  }

  _downmixToStereo(
    interleavedPCM: Float32Array,
    channels: number,
    samplesPerChannel: number
  ): Float32Array {
    if (channels === 2) return interleavedPCM

    const stereo = new Float32Array(samplesPerChannel * 2)

    if (channels === 1) {
      for (let i = 0; i < samplesPerChannel; i++) {
        const val = interleavedPCM[i] || 0
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
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          left = L + C * CENTER_MIX
          right = R + C * CENTER_MIX
          break
        }
        case 4: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Cs = interleavedPCM[offset + 3] || 0
          left = L + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          right = R + C * CENTER_MIX + Cs * SURROUND_MIX * 0.5
          break
        }
        case 5: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Ls = interleavedPCM[offset + 3] || 0
          const Rs = interleavedPCM[offset + 4] || 0
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX
          break
        }
        case 6: {
          const C = interleavedPCM[offset] || 0
          const L = interleavedPCM[offset + 1] || 0
          const R = interleavedPCM[offset + 2] || 0
          const Ls = interleavedPCM[offset + 3] || 0
          const Rs = interleavedPCM[offset + 4] || 0
          const LFE = interleavedPCM[offset + 5] || 0
          left = L + C * CENTER_MIX + Ls * SURROUND_MIX + LFE * LFE_MIX
          right = R + C * CENTER_MIX + Rs * SURROUND_MIX + LFE * LFE_MIX
          break
        }
        default:
          left = interleavedPCM[offset] || 0
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

  async _processPendingChunks(): Promise<void> {
    if (!this.isDecoderReady || this.pendingChunks.length === 0) return

    for (const item of this.pendingChunks) {
      await this._decodeChunk(item.chunk, item.encoding, item.callback)
    }
    this.pendingChunks = []
  }

  _findADTSFrame(): ADTSFrameInfo | null {
    const buffer = this.ringBuffer.peek(this.ringBuffer.length)
    if (!buffer) return null

    const buf = buffer
    for (let i = 0; i < buf.length - 7; i++) {
      const syncword = ((buf[i] ?? 0) << 4) | ((buf[i + 1] ?? 0) >> 4)
      if (syncword === 0xfff) {
        const frameLength =
          (((buf[i + 3] ?? 0) & 0x03) << 11) |
          ((buf[i + 4] ?? 0) << 3) |
          (((buf[i + 5] ?? 0) >> 5) & 0x07)

        if (buf.length >= i + frameLength) {
          return {
            start: i,
            end: i + frameLength,
            frame: buf.subarray(i, i + frameLength)
          }
        }
      }
    }
    return null
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (!this.isDecoderReady || this.pendingChunks.length > 0) {
      this.pendingChunks.push({ chunk, encoding, callback })
      return
    }

    this._decodeChunk(chunk, encoding, callback)
  }

  async _decodeChunk(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): Promise<void> {
    try {
      this.ringBuffer.write(chunk)

      while (this.ringBuffer.length > 7) {
        const frameInfo = this._findADTSFrame()
        if (!frameInfo) break

        if (frameInfo.start > 0) {
          this.ringBuffer.read(frameInfo.start)
        }

        const adtsFrame = frameInfo.frame

        if (!this.isConfigured) {
          await this.decoder.configure(adtsFrame)
          this.isConfigured = true
        }

        try {
          const result = this.decoder.decode(adtsFrame)
          if (result?.pcm?.length) {
            let { pcm, sampleRate, channels, samplesPerChannel } = result

            if (channels > 2 || channels === 1) {
              pcm = this._downmixToStereo(pcm, channels, samplesPerChannel)
              channels = 2
            }

            if (sampleRate !== AUDIO_CONFIG.sampleRate) {
              if (this.resampler) {
                const resampled = this.resampler.full(pcm)
                const pcmInt16 = new Int16Array(resampled.length)
                for (let i = 0; i < resampled.length; i++) {
                  pcmInt16[i] =
                    Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767
                }
                this.push(Buffer.from(pcmInt16.buffer))
              } else {
                if (!this.resamplerCreationPromise) {
                  this.resamplerCreationPromise = LibSampleRate.create(
                    2,
                    sampleRate,
                    48000,
                    {
                      converterType: _getResamplerConverterType(
                        this.resamplingQuality as ResamplingQuality
                        // biome-ignore lint/suspicious/noExplicitAny: library type mismatch
                      ) as any
                    }
                  ).then((resampler: ResamplerLike) => {
                    this.resampler = resampler
                    this.resamplerCreationPromise = null
                    return resampler
                  })
                }

                const resampler = await this.resamplerCreationPromise
                const resampled = resampler.full(pcm)
                const pcmInt16 = new Int16Array(resampled.length)
                for (let i = 0; i < resampled.length; i++) {
                  pcmInt16[i] =
                    Math.max(-1, Math.min(1, resampled[i] || 0)) * 32767
                }
                this.push(Buffer.from(pcmInt16.buffer))
              }
            } else {
              const pcmInt16 = new Int16Array(pcm.length)
              for (let i = 0; i < pcm.length; i++) {
                pcmInt16[i] = Math.max(-1, Math.min(1, pcm[i] || 0)) * 32767
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
      callback(err as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.ringBuffer.length > 0 && this.isConfigured) {
      try {
        const frameInfo = this._findADTSFrame()
        if (frameInfo) {
          const result = this.decoder.decode(frameInfo.frame)
          if (result?.pcm) {
            const pcmInt16 = new Int16Array(result.pcm.length)
            for (let i = 0; i < result.pcm.length; i++) {
              pcmInt16[i] =
                Math.max(-1, Math.min(1, result.pcm[i] || 0)) * 32767
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
  private mp4boxFile: MP4BoxFile | null
  private audioConfig: AACConfig | null
  private offset: number
  private _aborted: boolean

  constructor(options: TransformOptions = {}) {
    super({
      ...options,
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    this.mp4boxFile = MP4Box.createFile() as unknown as MP4BoxFile
    this.audioConfig = null
    this.offset = 0
    this._aborted = false

    this._setupMP4BoxHandlers()
  }

  abort(): void {
    this._aborted = true
    this._cleanupMp4Box()
  }

  _setupMP4BoxHandlers(): void {
    if (!this.mp4boxFile) return

    this.mp4boxFile.onReady = (info: MP4BoxInfo): void => {
      if (this._aborted || !this.mp4boxFile) return

      try {
        const audioTrack = info.tracks.find((t: MP4BoxTrack) =>
          t.codec?.startsWith('mp4a')
        )

        if (!audioTrack) {
          this.emit('error', new Error('No AAC track found in MP4'))
          return
        }

        this.audioConfig = this._getAudioConfig(audioTrack)
        this.mp4boxFile.setExtractionOptions(audioTrack.id, null, {
          nbSamples: 1
        })
        this.mp4boxFile.start()
      } catch (err) {
        this.emit(
          'error',
          new Error(`MP4 initialization error: ${(err as Error).message}`)
        )
      }
    }

    this.mp4boxFile.onSamples = (
      _id: number,
      _user: unknown,
      samples: MP4BoxSample[]
    ): void => {
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
            new Error(
              `MP4Box sample processing error: ${(err as Error).message}`
            )
          )
        }
      }
    }

    this.mp4boxFile.onError = (e: string): void => {
      if (!this._aborted) {
        this.emit('error', new Error(`MP4Box error: ${e}`))
      }
    }
  }

  _emitSampleWithADTS(sample: MP4BoxSample): void {
    if (!this.audioConfig) return
    const { profile, samplingIndex, channelCount } = this.audioConfig

    const sampleData = Buffer.from(sample.data)

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

  _getAudioConfig(track: MP4BoxTrack): AACConfig {
    const samplingIndex = SAMPLE_RATES.indexOf(track.audio.sample_rate)

    if (samplingIndex === -1) {
      throw new Error('Unsupported sample rate for ADTS')
    }

    let profile = 2

    if (track.codec) {
      const codecParts = (String(track.codec) || '').split('.')

      if (codecParts.length >= 3) {
        const objectType = Number.parseInt(codecParts[2] || '0', 10)

        if (objectType === 5 || objectType === 29) {
          profile = 2
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

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this._aborted || !this.mp4boxFile) {
      callback()
      return
    }

    try {
      const arrayBuffer =
        chunk instanceof ArrayBuffer
          ? chunk
          : (chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength
            ) as ArrayBuffer & { fileStart?: number })

      ;(arrayBuffer as ArrayBuffer & { fileStart?: number }).fileStart =
        this.offset
      this.offset += arrayBuffer.byteLength

      this.mp4boxFile.appendBuffer(arrayBuffer)
      callback()
    } catch {
      callback()
    }
  }

  override _flush(callback: TransformCallback): void {
    if (!this._aborted && this.mp4boxFile) {
      try {
        this.mp4boxFile.flush()
      } catch {}
    }
    this._cleanupMp4Box()
    callback()
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this._aborted = true
    this._cleanupMp4Box()
    super._destroy(err, callback)
  }

  _cleanupMp4Box(): void {
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
  private audioConfig: AACConfig | null
  private initSegmentProcessed: boolean
  private bufferMode: boolean
  private buffer: Buffer
  private _streamState: FMP4StreamState | null

  constructor(options: FMP4StreamOptions = {}) {
    super(options as TransformOptions)
    this.audioConfig = null
    this.initSegmentProcessed = false
    // Quando for true, buffers dados e processa boxes completos (SoundCloud por exemplo)
    // Quando for false (padrão), espera segmentos completos por chunk (NicoVideo por exemplo)
    this.bufferMode = options.bufferMode || false
    this.buffer = Buffer.alloc(0)
    this._streamState = null
  }

  _parseBoxes(buffer: Buffer, offset = 0): MP4BoxType[] {
    const boxes: MP4BoxType[] = []
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

  _extractAudioConfigFromInit(initSegment: Buffer): AACConfig | null {
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

  _createAdtsHeader(sampleLength: number, audioConfig: AACConfig): Buffer {
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

  _extractAACFromSegment(buffer: Buffer): Buffer | null {
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

    const trafBoxes = this._parseBoxes(trafBox?.data || Buffer.alloc(0))
    const trunBox = trafBoxes.find((b) => b.type === 'trun')
    if (!trunBox) return aacData

    const trun = trunBox.data
    if (trun.length < 8) return aacData

    const flags =
      ((trun[1] ?? 0) << 16) | ((trun[2] ?? 0) << 8) | (trun[3] ?? 0)
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
  _processBuffer(): void {
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

      const state = this._streamState
      if (state.mode === 'READ_HEADER') {
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

        state.boxSize = size
        state.boxType = type
        state.headerSize = headerSize

        this.buffer = this.buffer.subarray(headerSize)
        state.boxSize -= headerSize

        if (type === 'mdat') {
          state.mode = 'STREAM_MDAT'
        } else {
          state.mode = 'READ_BODY'
        }
      } else if (state.mode === 'READ_BODY') {
        if (this.buffer.length < state.boxSize) break

        const body = this.buffer.subarray(0, state.boxSize)
        this.buffer = this.buffer.subarray(state.boxSize)

        const type = state.boxType

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
          while (
            samples.length > 0 &&
            samples[0] !== undefined &&
            this.buffer.length >= samples[0]
          ) {
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
        } else if (
          samples.length > 0 &&
          samples[0] !== undefined &&
          this.buffer.length < samples[0]
        ) {
          break
        }
      }
    }
  }

  _parseMoof(moofData: Buffer): number[] {
    const boxes = this._parseBoxes(moofData)
    const trafs = boxes.filter((b) => b.type === 'traf')
    const sizes = []

    for (const traf of trafs) {
      const trafBoxes = this._parseBoxes(traf.data)
      const tfhd = trafBoxes.find((b) => b.type === 'tfhd')
      if (!tfhd || tfhd.data.length < 8) continue

      const trackId = tfhd.data.readUInt32BE(4)

      if (
        trafs.length > 1 &&
        this.audioConfig &&
        trackId !== this.audioConfig.trackId
      ) {
        continue
      }
      if (!this.audioConfig) continue

      const tfhdData = tfhd.data
      const tfhdFlags =
        ((tfhdData[1] ?? 0) << 16) |
        ((tfhdData[2] ?? 0) << 8) |
        (tfhdData[3] ?? 0)
      let currentDefaultSize = this.audioConfig.defaultSampleSize || 0

      let offset = 8
      if (tfhdFlags & 0x01) offset += 8
      if (tfhdFlags & 0x02) offset += 4
      if (tfhdFlags & 0x08) offset += 4
      if (tfhdFlags & 0x10 && offset + 4 <= tfhdData.length) {
        currentDefaultSize = tfhdData.readUInt32BE(offset)
        offset += 4
      }

      const truns = trafBoxes.filter((b) => b.type === 'trun')
      for (const trun of truns) {
        const data = trun.data
        if (data.length < 8) continue
        const flags =
          ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0)
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

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
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

  override _flush(callback: TransformCallback): void {
    if (this.bufferMode) {
      try {
        this._processBuffer()
      } catch (_err) {}
    }
    callback()
  }
}

class FLVToAACStream extends Transform {
  private demuxer: FlvDemuxerLike
  private audioConfig: AACConfig | null
  private _aborted: boolean

  constructor(options: TransformOptions = {}) {
    super(options)
    this.demuxer = new FlvDemuxer() as FlvDemuxerLike
    this.audioConfig = null
    this._aborted = false

    this.demuxer.on('data', (audioTag: Buffer) => {
      if (this._aborted) return
      this._processAudioTag(audioTag)
    })

    this.demuxer.on('error', (err: Error) => {
      if (!this._aborted) this.emit('error', err)
    })
  }

  abort(): void {
    this._aborted = true
    this.demuxer.destroy()
  }

  _processAudioTag(tag: Buffer): void {
    const header = tag[0] ?? 0
    const format = (header & 0xf0) >> 4

    if (format === 10) {
      const aacPacketType = tag[1]
      if (aacPacketType === 0) {
        this.audioConfig = this._parseAudioSpecificConfig(tag.subarray(2))
      } else if (aacPacketType === 1 && this.audioConfig) {
        const adtsHeader = _createAdtsHeader(
          tag.length - 2,
          this.audioConfig.profile || 2,
          this.audioConfig.samplingIndex || 4,
          this.audioConfig.channelCount || 2
        )
        this.push(Buffer.concat([adtsHeader, tag.subarray(2)]))
      }
    } else if (format === 2) {
      this.push(tag.subarray(1))
    }
  }

  _parseAudioSpecificConfig(data: Buffer): AACConfig {
    const objectType = ((data[0] ?? 0) & 0xf8) >> 3
    const samplingIndex =
      (((data[0] ?? 0) & 0x07) << 1) | (((data[1] ?? 0) & 0x80) >> 7)
    const channelConfig = ((data[1] ?? 0) & 0x78) >> 3

    return {
      profile: objectType,
      samplingIndex,
      channelCount: channelConfig
    }
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.demuxer.write(chunk, encoding, callback)
  }

  override _flush(callback: TransformCallback): void {
    this.demuxer.end(callback)
  }
}

class StreamAudioResource extends BaseAudioResource {
  private nodelink: NodeLink

  constructor(
    stream: Readable,
    type: string,
    nodelink: NodeLink,
    initialFilters: FiltersState = {},
    volume = 1.0,
    audioMixer: AudioMixer | null = null,
    returnPCM = false,
    enableAGC = true
  ) {
    super()

    this.nodelink = nodelink
    this._validateInputStream(stream)

    const resamplingQuality =
      nodelink.options.audio?.resamplingQuality || 'fastest'
    const normalizedType = normalizeFormat(type)

    this.pipes = [stream]

    const pcmStream = this._createDecoderPipeline(
      stream,
      type,
      normalizedType,
      resamplingQuality
    )

    if (returnPCM) {
      this._createPCMOutputPipeline(pcmStream, volume, enableAGC)
    } else {
      this._createOutputPipeline(
        pcmStream,
        nodelink as unknown as NodeLink,
        initialFilters,
        volume,
        audioMixer,
        enableAGC
      )
    }

    this._setupEventHandlers(stream)
  }

  _validateInputStream(stream: Readable): void {
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }
  }

  _createDecoderPipeline(
    stream: Readable,
    type: string,
    normalizedType: string,
    resamplingQuality: string
  ): Transform {
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

  _createFLVPipeline(
    stream: Readable,
    _type: string,
    resamplingQuality: string
  ): Transform {
    const demuxer = new FLVToAACStream()
    const decoder = new AACDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality
    })

    this.pipes?.push(demuxer, decoder)

    pipeline(stream, demuxer, decoder, (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createAACPipeline(
    stream: Readable,
    type: string,
    resamplingQuality: string
  ): Transform {
    const lowerType = type.toLowerCase()
    const _aacStream = stream
    const streams: (Readable | Transform)[] = [stream]

    if (_isFmp4Format(lowerType)) {
      // como eu coloquei options = {} no fmp4, ele aceita isso como o bufferMode, se incluir, vai passar true, se nao, vai passar false
      const bufferMode = lowerType.includes('fmp4-buffered')
      const demuxer = new FMP4ToAACStream({ bufferMode })
      streams.push(demuxer)
    } else if (_isMpegtsFormat(lowerType)) {
      const demuxer = new MPEGTSDemuxer()
      streams.push(demuxer)

      if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
        const decoder = new SymphoniaDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality
        })
        streams.push(decoder)

        this.pipes?.push(...streams.slice(1))

        pipeline(
          streams as unknown as Readable[],
          (err: Error | null): void => {
            if (err && !this._destroyed) {
              this.stream?.emit('error', err)
            }
          }
        )

        return decoder
      }
    } else if (_isMp4Format(lowerType)) {
      const demuxer = new MP4ToAACStream()
      streams.push(demuxer)
    }

    const decoder = new AACDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality
    })
    streams.push(decoder)

    this.pipes?.push(...streams.slice(1))

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createSymphoniaPipeline(
    stream: Readable,
    resamplingQuality: string
  ): Transform {
    const decoder = new SymphoniaDecoderStream({
      resamplingQuality: resamplingQuality as ResamplingQuality
    })
    this.pipes?.push(decoder)

    pipeline(stream, decoder, (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOpusPipeline(stream: Readable, type: string): Transform {
    const decoder = new OpusDecoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    const streams: (Readable | Transform)[] = [stream]

    if (_isWebmFormat(type.toLowerCase())) {
      const demuxer = new WebmOpusDemuxer()
      streams.push(demuxer)
      this.pipes?.push(demuxer)
    }

    streams.push(decoder)
    this.pipes?.push(decoder)

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        this.stream?.emit('error', err)
      }
    })

    return decoder
  }

  _createOutputPipeline(
    pcmStream: Transform,
    nodelink: NodeLink,
    initialFilters: FiltersState,
    volume: number,
    audioMixer: AudioMixer | null = null,
    enableAGC = true
  ): void {
    const filters = new FiltersManager(nodelink, initialFilters)
    const volumeTransformer = new VolumeTransformer({
      type: 's16le',
      volume,
      enableAGC,
      lookaheadMs: nodelink.options.audio?.lookaheadMs,
      gateThresholdLUFS: nodelink.options.audio?.gateThresholdLUFS
    })
    const fadeTransformer = new FadeTransformer({
      type: 's16le',
      volume: 1.0,
      sampleRate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    const flowController = new FlowController(
      filters,
      volumeTransformer,
      fadeTransformer,
      // biome-ignore lint/suspicious/noExplicitAny: complexity in flow controller types
      audioMixer as any
    )

    const opusEncoder = new OpusEncoder({
      rate: AUDIO_CONFIG.sampleRate,
      channels: AUDIO_CONFIG.channels
    })

    opusEncoder.setDTX(false)

    const streams: Transform[] = [pcmStream, flowController]
    this.pipes?.push(flowController)

    // Inject Audio Interceptors (Low-level stream manipulation)
    if (nodelink.extensions?.audioInterceptors) {
      for (const interceptorFactory of nodelink.extensions // biome-ignore lint/suspicious/noExplicitAny: dynamic extension types
        .audioInterceptors as any[]) {
        try {
          const interceptorStream = interceptorFactory()
          if (
            interceptorStream &&
            typeof interceptorStream.pipe === 'function'
          ) {
            streams.push(interceptorStream)
            this.pipes?.push(interceptorStream)
          }
        } catch (e) {
          // Log error but don't break pipeline
          console.error(`Audio interceptor error: ${(e as Error).message}`)
        }
      }
    }

    streams.push(opusEncoder)
    this.pipes?.push(opusEncoder)

    pipeline(streams as unknown as Readable[], (err: Error | null): void => {
      if (err && !this._destroyed) {
        opusEncoder.emit('error', err)
      } else if (!this._destroyed) {
        this.stream?.emit('finishBuffering')
      }
    })

    this._assignStream(opusEncoder)
  }

  _createPCMOutputPipeline(
    pcmStream: Transform,
    volume: number,
    enableAGC = true
  ): void {
    if (volume !== 1.0 || enableAGC) {
      const volumeTransformer = new VolumeTransformer({
        type: 's16le',
        volume,
        enableAGC,
        lookaheadMs: this.nodelink?.options?.audio?.lookaheadMs,
        gateThresholdLUFS: this.nodelink?.options?.audio?.gateThresholdLUFS
      })

      pipeline(pcmStream, volumeTransformer, (err: Error | null): void => {
        if (err && !this._destroyed) {
          volumeTransformer.emit('error', err)
        }
      })

      this._assignStream(volumeTransformer as unknown as Transform)
    } else {
      this._assignStream(pcmStream)
    }
  }

  _setupEventHandlers(inputStream: Readable): void {
    inputStream.on('finishBuffering', () => {
      // Waiting for the pipeline to finish
    })

    inputStream.on('error', (err: Error) => {
      this.stream?.emit('error', err)
    })

    if (this.pipes) {
      for (const pipe of this.pipes) {
        if (pipe !== this.stream) {
          pipe.on?.('error', (err: Error) => {
            this.stream?.emit('error', err)
          })
        }
      }
    }

    if (this.stream) {
      this.stream.on('error', () => {
        this._end()
      })
    }
  }

  _createUnsupportedFormatError(type: string): Error {
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
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  initialFilters: FiltersState = {},
  volume: number = 1.0,
  audioMixer: AudioMixer | null = null,
  returnPCM: boolean = false,
  enableAGC: boolean = true
): StreamAudioResource =>
  new StreamAudioResource(
    stream,
    type,
    nodelink,
    initialFilters,
    volume,
    audioMixer,
    returnPCM,
    enableAGC
  )

export const createSeekeableAudioResource = async (
  url: string,
  seekTime: number,
  endTime: number | undefined,
  nodelink: NodeLink,
  initialFilters: FiltersState,
  player: { streamInfo: StreamInfo; loudnessNormalizer?: boolean },
  volume: number = 1.0,
  audioMixer: AudioMixer | null = null
): Promise<StreamAudioResource | ErrorResponse> => {
  try {
    const { stream, meta } = (await seekableStream(
      url,
      seekTime,
      endTime,
      {}
    )) as { stream: Readable; meta: SeekableStreamMeta }

    const passthroughStream = new PassThrough({
      highWaterMark: AUDIO_CONFIG.highWaterMark
    })

    passthroughStream.once('finish', () => {
      passthroughStream.emit('finishBuffering')
    })

    pipeline(stream, passthroughStream, (err: NodeJS.ErrnoException | null) => {
      if (err) passthroughStream.emit('error', err)
    })

    const format = meta.codec?.container || player.streamInfo?.format

    return new StreamAudioResource(
      passthroughStream,
      format as string,
      nodelink,
      initialFilters,
      volume,
      audioMixer,
      false,
      player.loudnessNormalizer
    )
  } catch (err) {
    const cause = err instanceof SeekError ? err.code : 'UNKNOWN'
    return _createErrorResponse((err as Error).message, cause)
  }
}

export const createPCMStream = (
  stream: Readable,
  type: string,
  nodelink: NodeLink,
  volume: number = 1.0,
  filters: FiltersState = {}
): Transform => {
  const resamplingQuality =
    nodelink.options.audio?.resamplingQuality || 'fastest'
  const normalizedType = normalizeFormat(type)

  const streams: (Readable | Transform)[] = [stream]

  switch (normalizedType) {
    case SupportedFormats.AAC: {
      const lowerType = type.toLowerCase()

      if (_isFmp4Format(lowerType)) {
        const bufferMode = lowerType.includes('fmp4-buffered')
        streams.push(new FMP4ToAACStream({ bufferMode }))
      } else if (_isMpegtsFormat(lowerType)) {
        streams.push(new MPEGTSDemuxer())

        if (lowerType.includes('mp3') || lowerType.includes('mpeg')) {
          streams.push(new SymphoniaDecoderStream({ resamplingQuality }))
          break
        }
      } else if (_isMp4Format(lowerType)) streams.push(new MP4ToAACStream())

      streams.push(
        new AACDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality
        })
      )
      break
    }

    case SupportedFormats.FLV: {
      streams.push(new FLVToAACStream())
      streams.push(
        new AACDecoderStream({
          resamplingQuality: resamplingQuality as ResamplingQuality
        })
      )
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
          channels: AUDIO_CONFIG.channels
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
      ;(s as Transform).on('error', (err: Error & { code?: string }) =>
        logger(
          'error',
          'PCMStream',
          `Component error (${s.constructor.name}): ${err.message} (${err.code})`
        )
      )
    }
  }

  pipeline(streams, (err: NodeJS.ErrnoException | null) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger(
        'error',
        'PCMStream',
        `Internal processing pipeline failed: ${err.message}`
      )
    }
  })

  return streams[streams.length - 1] as Transform
}
