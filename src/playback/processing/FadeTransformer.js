import { Transform } from 'node:stream'

const DEFAULT_CURVE = 'linear'
const SUPPORTED_CURVES = new Set([
  'linear',
  'exponential',
  'logarithmic',
  's-curve'
])

const _clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const _normalizeCurve = (curve) =>
  SUPPORTED_CURVES.has(curve) ? curve : DEFAULT_CURVE

const _applyCurve = (progress, curve) => {
  const clamped = _clamp(progress, 0, 1)
  switch (curve) {
    case 'exponential':
      return Math.pow(clamped, 2)
    case 'logarithmic':
      return Math.log10(1 + 9 * clamped)
    case 's-curve':
      return clamped * clamped * (3 - 2 * clamped)
    case 'linear':
    default:
      return clamped
  }
}

export class FadeTransformer extends Transform {
  constructor(options = {}) {
    super({ highWaterMark: 3840, ...options })
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2
    const initialGain = Number.isFinite(options.volume) ? options.volume : 1.0
    this.currentGain = _clamp(initialGain, 0, 1)
    this.fade = null
  }

  setGain(volume) {
    this.currentGain = _clamp(volume, 0, 1)
    this.fade = null
  }

  fadeTo(volume, durationMs, curve = DEFAULT_CURVE) {
    const targetGain = _clamp(volume, 0, 1)
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0

    if (duration === 0) {
      this.setGain(targetGain)
      return
    }

    this.fade = {
      startGain: this.currentGain,
      targetGain,
      durationMs: duration,
      elapsedMs: 0,
      curve: _normalizeCurve(curve)
    }
  }

  _transform(chunk, _encoding, callback) {
    const sampleCount = chunk.length / 2
    if (!sampleCount) {
      this.push(chunk)
      return callback()
    }

    let gainStart = this.currentGain
    let gainEnd = this.currentGain

    if (this.fade) {
      const { startGain, targetGain, durationMs, elapsedMs, curve } = this.fade
      const chunkDurationMs =
        (sampleCount / this.channels / this.sampleRate) * 1000
      const nextElapsed = Math.min(durationMs, elapsedMs + chunkDurationMs)
      const progressStart = durationMs === 0 ? 1 : elapsedMs / durationMs
      const progressEnd = durationMs === 0 ? 1 : nextElapsed / durationMs

      gainStart =
        startGain + (targetGain - startGain) * _applyCurve(progressStart, curve)
      gainEnd =
        startGain + (targetGain - startGain) * _applyCurve(progressEnd, curve)

      this.fade.elapsedMs = nextElapsed
      if (nextElapsed >= durationMs) {
        this.fade = null
        this.currentGain = targetGain
      } else {
        this.currentGain = gainEnd
      }
    }

    if (gainStart === 1 && gainEnd === 1) {
      this.push(chunk)
      return callback()
    }

    const samples = new Int16Array(
      chunk.buffer,
      chunk.byteOffset,
      sampleCount
    )
    const step = sampleCount > 1 ? (gainEnd - gainStart) / (sampleCount - 1) : 0

    for (let i = 0; i < samples.length; i++) {
      const gain = gainStart + step * i
      const value = samples[i] * gain
      samples[i] =
        value < -32768 ? -32768 : value > 32767 ? 32767 : Math.round(value)
    }

    this.push(chunk)
    callback()
  }
}
