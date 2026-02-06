import { Transform } from 'node:stream'
import { LoudnessNormalizer } from './LoudnessNormalizer.js'
import { Buffer } from 'node:buffer'

const INT16_MAX = 32767
const INT16_MIN = -32768
const DEFAULT_CURVE = 'sinusoidal'
const SUPPORTED_CURVES = new Set(['linear', 'sine', 'sinusoidal'])

const alignedBufferIfRequired = (size) => {
  const buffer = Buffer.allocUnsafe(size)
  if (buffer.byteOffset % 2 === 0) return buffer
  return Buffer.allocUnsafe(size + 1).subarray(1)
}

export class VolumeTransformer extends Transform {
  constructor(options = {}) {
    const {
      volume = 1,
      fadeDurationMs = 1000,
      fadeCurve = DEFAULT_CURVE,
      sampleRate = 48000,
      channels = 2,
      limiterThreshold = 0.95,
      limiterSoftness = 0.4,
      enableAGC = true,
      lookaheadMs = 5,
      ...rest
    } = options

    super({ highWaterMark: 3840, ...rest })

    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000
    this.channels = Number.isFinite(channels) && channels >= 1 ? Math.max(1, Math.floor(channels)) : 2

    this.lookaheadSamples = Math.max(0, Math.round((lookaheadMs / 1000) * this.sampleRate)) * this.channels
    this.lookaheadBuffer = new Int16Array(this.lookaheadSamples)
    this.lookaheadIndex = 0
    this.lookaheadFull = false

    const initialVolume = Number.isFinite(volume) ? volume : 1
    this.currentVolume = initialVolume
    this.targetVolume = initialVolume
    this.startVolume = initialVolume

    this.fadeDurationMs = Number.isFinite(fadeDurationMs) && fadeDurationMs >= 0 ? fadeDurationMs : 1000
    this.fadeFramesTotal = Math.max(0, Math.round((this.fadeDurationMs / 1000) * this.sampleRate))
    this.fadeFramesElapsed = this.fadeFramesTotal
    this.fadeActive = false
    this.fadeCurve = SUPPORTED_CURVES.has(fadeCurve) ? fadeCurve : DEFAULT_CURVE

    this.limiterThreshold = Math.min(0.999, Math.max(0, Number.isFinite(limiterThreshold) ? limiterThreshold : 0.95))
    this.limiterSoftness = Math.max(0.01, Number.isFinite(limiterSoftness) ? limiterSoftness : 0.4)
    this._thresholdValue = this.limiterThreshold * INT16_MAX
    this._limitHeadroom = INT16_MAX - this._thresholdValue

    this.agc = enableAGC ? new LoudnessNormalizer({
      sampleRate: this.sampleRate,
      channels: this.channels,
      targetLoudness: -14
    }) : null
  }

  _getFadeCurveValue(progress) {
    const clamped = Math.min(1, Math.max(0, progress))
    switch (this.fadeCurve) {
      case 'linear':
        return clamped
      case 'sine':
      case 'sinusoidal':
        return 0.5 - 0.5 * Math.cos(clamped * Math.PI)
      default:
        return clamped
    }
  }

  _computeFadeGains(sampleCount) {
    if (!this.fadeActive || this.fadeFramesTotal === 0) {
      this.currentVolume = this.targetVolume
      return { gainStart: this.targetVolume, gainEnd: this.targetVolume }
    }

    const frames = sampleCount / this.channels
    if (frames <= 0) {
      return { gainStart: this.currentVolume, gainEnd: this.currentVolume }
    }

    const prevElapsed = this.fadeFramesElapsed
    const nextElapsed = Math.min(this.fadeFramesTotal, prevElapsed + frames)

    const progressStart = prevElapsed / this.fadeFramesTotal
    const progressEnd = nextElapsed / this.fadeFramesTotal

    const mappedStart = this._getFadeCurveValue(progressStart)
    const mappedEnd = this._getFadeCurveValue(progressEnd)
    const range = this.targetVolume - this.startVolume

    const gainStart = this.startVolume + range * mappedStart
    const gainEnd = this.startVolume + range * mappedEnd

    this.fadeFramesElapsed = nextElapsed
    if (nextElapsed >= this.fadeFramesTotal) {
      this.fadeActive = false
      this.currentVolume = this.targetVolume
      this.startVolume = this.targetVolume
    } else {
      this.currentVolume = gainEnd
    }

    return { gainStart, gainEnd }
  }

  _prepareView(buffer, sampleCount) {
    if (buffer.byteOffset % 2 === 0) {
      return {
        buffer,
        view: new Int16Array(buffer.buffer, buffer.byteOffset, sampleCount)
      }
    }

    const aligned = Buffer.allocUnsafe(buffer.length)
    buffer.copy(aligned)
    return {
      buffer: aligned,
      view: new Int16Array(aligned.buffer, aligned.byteOffset, sampleCount)
    }
  }

  _applyLimiter(value) {
    const abs = Math.abs(value)
    if (abs <= this._thresholdValue || this._limitHeadroom <= 0) return value

    const normalizedOvershoot = (abs - this._thresholdValue) / this._limitHeadroom
    const softened = 1 - Math.exp(-normalizedOvershoot * this.limiterSoftness)
    const limited = this._thresholdValue + this._limitHeadroom * softened

    return Math.sign(value) * Math.min(INT16_MAX, limited)
  }

  _clampToInt16(value) {
    if (value >= INT16_MAX) return INT16_MAX
    if (value <= INT16_MIN) return INT16_MIN
    return Math.round(value)
  }

  setVolume(volume) {
    const nextVolume = Number.isFinite(volume) ? volume : this.targetVolume
    if (nextVolume === this.targetVolume) return

    this.startVolume = this.currentVolume
    this.targetVolume = nextVolume
    this.fadeFramesElapsed = 0
    this.fadeActive = this.fadeFramesTotal > 0

    if (!this.fadeActive) {
      this.currentVolume = nextVolume
      this.startVolume = nextVolume
    }
  }

  process(chunk) {
    const usableSamples = chunk.length >> 1
    if (!usableSamples) return chunk

    const { buffer, view } = this._prepareView(chunk, usableSamples)
    
    if (this.agc) {
      this.agc.process(view)
    }

    const { gainStart, gainEnd } = this._computeFadeGains(usableSamples)
    const gainStep = usableSamples > 1 ? (gainEnd - gainStart) / (usableSamples - 1) : 0
    let gain = gainStart

    if (this.lookaheadSamples > 0) {
      const outputBuffer = alignedBufferIfRequired(chunk.length)
      const outputView = new Int16Array(outputBuffer.buffer, outputBuffer.byteOffset, usableSamples)

      for (let i = 0; i < view.length; i++) {
        const rawSample = view[i]
        const scaled = rawSample * gain
        const limited = this._applyLimiter(scaled)
        
        const outputSample = this.lookaheadBuffer[this.lookaheadIndex]
        this.lookaheadBuffer[this.lookaheadIndex] = limited
        this.lookaheadIndex = (this.lookaheadIndex + 1) % this.lookaheadSamples
        
        outputView[i] = this._clampToInt16(outputSample)
        gain += gainStep
      }
      return outputBuffer
    }

    for (let i = 0; i < view.length; i++) {
      const scaled = view[i] * gain
      const limited = this._applyLimiter(scaled)
      view[i] = this._clampToInt16(limited)
      gain += gainStep
    }

    return buffer
  }

  flush() {
    return Buffer.alloc(0)
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.push(this.process(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }
}
