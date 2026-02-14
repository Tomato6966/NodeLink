import { Buffer } from 'node:buffer'

type FadeCurve = 'linear' | 'exponential' | 'sinusoidal'

const SUPPORTED_CURVES = new Set<FadeCurve>([
  'linear',
  'exponential',
  'sinusoidal'
])
const DEFAULT_CURVE: FadeCurve = 'sinusoidal'

interface TapeState {
  startRate: number
  targetRate: number
  durationMs: number
  elapsedMs: number
  curve: FadeCurve
  completed?: boolean
}

/**
 * Resampling audio transformer that implements tape-like start/stop effects.
 * Uses Cubic Hermite Spline interpolation for high-quality pitch/speed shifting.
 *
 * @remarks
 * Maintains a sliding window input buffer. To avoid "looping" or "jumps",
 * the precision of the read pointer is maintained during buffer compaction.
 */
export class TapeTransformer {
  private readonly sampleRate: number
  private readonly channels: number
  private currentRate = 1.0
  private tape: TapeState | null = null
  private _lastRampCompleted = false

  // Input buffer for resampling (sliding window)
  private inputBuffer: Float32Array
  private inputReadPos = 0
  private inputWritePos = 0
  private readonly maxBufferSize: number

  constructor(options: { sampleRate?: number; channels?: number } = {}) {
    this.sampleRate = options.sampleRate ?? 48000
    this.channels = options.channels ?? 2
    // 10 seconds buffer to handle extreme deceleration and pipeline jitter
    this.maxBufferSize = this.sampleRate * this.channels * 10
    this.inputBuffer = new Float32Array(this.maxBufferSize)
  }

  public setRate(rate: number): void {
    this.currentRate = Math.max(0.01, Math.min(2.0, rate))
    this.tape = null
    this._lastRampCompleted = false
  }

  public tapeTo(
    durationMs: number,
    type: 'start' | 'stop',
    curve: string = DEFAULT_CURVE
  ): void {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    this._lastRampCompleted = false

    if (duration === 0) {
      this.currentRate = type === 'start' ? 1.0 : 0.01
      this.tape = null
      return
    }

    this.tape = {
      startRate: this.currentRate,
      targetRate: type === 'start' ? 1.0 : 0.01,
      durationMs: duration,
      elapsedMs: 0,
      curve: (SUPPORTED_CURVES.has(curve as FadeCurve)
        ? curve
        : DEFAULT_CURVE) as FadeCurve
    }
  }

  public isActive(): boolean {
    return this.tape !== null || Math.abs(this.currentRate - 1.0) > 0.001
  }

  public checkRampCompleted(): boolean {
    if (this._lastRampCompleted) {
      this._lastRampCompleted = false
      return true
    }
    return false
  }

  private _getCurveValue(t: number, curve: FadeCurve): number {
    switch (curve) {
      case 'linear':
        return t
      case 'exponential':
        return t * t
      case 'sinusoidal':
        return (1 - Math.cos(t * Math.PI)) / 2
      default:
        return t
    }
  }

  /**
   * Processes a PCM S16LE chunk.
   * Produces an output chunk of the same frame size to maintain pacing.
   */
  public process(chunk: Buffer): Buffer {
    if (chunk.length === 0) return chunk

    const incomingSamples = chunk.length / 2
    const incomingFrames = incomingSamples / this.channels

    // 1. Ensure space in input buffer
    if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
      this._compact()

      // If STILL no space after compaction, we must drop oldest data but keep continuity
      if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
        // Shift read pointer forward to make room, but keep it sample-aligned
        const samplesToDrop =
          Math.ceil(incomingSamples / this.channels) * this.channels
        this.inputReadPos = Math.max(0, this.inputReadPos - samplesToDrop)
        this._compact()
      }
    }

    // 2. Convert to Float and push to buffer
    for (let i = 0; i < incomingSamples; i++) {
      this.inputBuffer[this.inputWritePos++] = chunk.readInt16LE(i * 2) / 32767
    }

    // 3. Prepare output
    const outI16 = new Int16Array(incomingSamples)

    // 4. Resample with Cubic Hermite Spline
    const sampleDurationMs = 1000 / this.sampleRate
    for (let f = 0; f < incomingFrames; f++) {
      // Update ramp
      if (this.tape) {
        this.tape.elapsedMs += sampleDurationMs
        const t = Math.min(1.0, this.tape.elapsedMs / this.tape.durationMs)
        const curveT = this._getCurveValue(t, this.tape.curve)
        this.currentRate =
          this.tape.startRate +
          (this.tape.targetRate - this.tape.startRate) * curveT

        if (t >= 1.0) {
          this.currentRate = this.tape.targetRate
          this.tape = null
          this._lastRampCompleted = true
        }
      }

      // If we are stopped and the ramp is done, we stay in silence
      if (this.currentRate <= 0.01 && !this.tape) {
        break
      }

      // Check if we have enough samples for cubic interpolation (need p0, p1, p2, p3)
      const iPos = Math.floor(this.inputReadPos / this.channels) * this.channels
      // We need up to iPos + 2*channels for p3
      if (iPos + this.channels * 3 >= this.inputWritePos) {
        // Not enough data yet, we'll return what we have (rest is silence)
        break
      }

      const frac = (this.inputReadPos - iPos) / this.channels

      for (let c = 0; c < this.channels; c++) {
        // Cubic points
        const p0 =
          this.inputBuffer[iPos - this.channels + c] ??
          this.inputBuffer[iPos + c]
        const p1 = this.inputBuffer[iPos + c]
        const p2 = this.inputBuffer[iPos + this.channels + c]
        const p3 = this.inputBuffer[iPos + this.channels * 2 + c]

        // Catmull-Rom formulation
        const val =
          0.5 *
          (2 * p1 +
            (-p0 + p2) * frac +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * frac * frac +
            (-p0 + 3 * p1 - 3 * p2 + p3) * frac * frac * frac)

        outI16[f * this.channels + c] = Math.max(
          -32768,
          Math.min(32767, Math.round(val * 32767))
        )
      }

      this.inputReadPos += this.currentRate * this.channels
    }

    // Periodically compact buffer to keep pointers low
    if (this.inputReadPos > this.sampleRate * this.channels * 2) {
      this._compact()
    }

    return Buffer.from(outI16.buffer, outI16.byteOffset, outI16.byteLength)
  }

  private _compact(): void {
    // Crucial: Keep the fractional part of inputReadPos to maintain phase continuity!
    const integralReadPos =
      Math.floor(this.inputReadPos / this.channels) * this.channels
    const fractionalReadPos = this.inputReadPos - integralReadPos

    if (integralReadPos <= 0) return

    const remaining = this.inputWritePos - integralReadPos
    if (remaining > 0) {
      this.inputBuffer.copyWithin(0, integralReadPos, this.inputWritePos)
    }

    this.inputReadPos = fractionalReadPos
    this.inputWritePos = Math.max(0, remaining)
  }
}
