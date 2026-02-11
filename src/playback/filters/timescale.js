import { SAMPLE_RATE } from '../../constants.ts'
import { clamp16Bit } from './dsp/clamp16Bit.js'
import { resample } from './timescale/resampler.js'
import TimeStretch from './timescale/timeStretch.js'

const CHANNELS = 2
const BYTES_PER_SAMPLE = 2
const FRAME_SIZE = CHANNELS * BYTES_PER_SAMPLE
const FLOAT_DENOMINATOR = 32768
const FLOAT_TO_INT_SCALE = 32767
const EMPTY_BUFFER = Buffer.alloc(0)

const concatFloat32 = (chunks) => {
  if (chunks.length === 0) return new Float32Array(0)
  if (chunks.length === 1) return chunks[0]

  let total = 0
  for (const chunk of chunks) total += chunk.length
  const output = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

const int16ToFloat = (input) => {
  const output = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    output[i] = (input[i] ?? 0) / FLOAT_DENOMINATOR
  }
  return output
}

const floatToInt16Buffer = (input) => {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    output[i] = clamp16Bit((input[i] ?? 0) * FLOAT_TO_INT_SCALE)
  }
  return Buffer.from(output.buffer)
}

export default class Timescale {
  constructor() {
    this.priority = 1
    this.speed = 1.0
    this.pitch = 1.0
    this.rate = 1.0

    this._pending = EMPTY_BUFFER
    this._bypass = true
    this._silence = false
    this._effectiveTempo = 1.0
    this._effectiveRate = 1.0
    this._usesStretch = false

    this._timeStretch = new TimeStretch({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS
    })
  }

  update(filters) {
    const settings = filters.timescale || {}

    const speed = Number.isFinite(settings.speed) ? settings.speed : 1.0
    const pitch = Number.isFinite(settings.pitch) ? settings.pitch : 1.0
    const rate = Number.isFinite(settings.rate) ? settings.rate : 1.0

    const bypass = speed === 1.0 && pitch === 1.0 && rate === 1.0
    const silence = speed <= 0 || pitch <= 0 || rate <= 0
    const wasBypassed = this._bypass || this._silence

    this.speed = speed
    this.pitch = pitch
    this.rate = rate
    this._bypass = bypass
    this._silence = silence

    if (this._bypass || this._silence) {
      this._reset()
      return
    }

    const tempo = speed / pitch
    const rateScale = rate * pitch
    const usesStretch = tempo !== 1.0
    const needsReset = wasBypassed || usesStretch !== this._usesStretch

    this._effectiveTempo = tempo
    this._effectiveRate = rateScale
    this._usesStretch = usesStretch

    if (needsReset) {
      this._reset()
    }

    if (this._usesStretch) {
      this._timeStretch.setTempo(this._effectiveTempo)
    }
  }

  _reset() {
    this._pending = EMPTY_BUFFER
    this._timeStretch.reset()
  }

  _processFloat(samples) {
    if (samples.length === 0) return samples

    if (this._effectiveRate > 1) {
      const stretched = this._usesStretch
        ? this._timeStretch.process(samples)
        : samples
      return this._effectiveRate !== 1
        ? resample(stretched, CHANNELS, this._effectiveRate)
        : stretched
    }

    const resampled =
      this._effectiveRate !== 1
        ? resample(samples, CHANNELS, this._effectiveRate)
        : samples
    return this._usesStretch ? this._timeStretch.process(resampled) : resampled
  }

  process(chunk) {
    if (this._bypass) return chunk
    if (this._silence) return EMPTY_BUFFER
    if (!chunk || chunk.length === 0) return EMPTY_BUFFER

    const inputBuffer =
      this._pending.length > 0 ? Buffer.concat([this._pending, chunk]) : chunk
    const totalFrames = Math.floor(inputBuffer.length / FRAME_SIZE)

    if (totalFrames === 0) {
      this._pending = inputBuffer
      return EMPTY_BUFFER
    }

    const bytesToProcess = totalFrames * FRAME_SIZE
    const processBuffer =
      bytesToProcess === inputBuffer.length
        ? inputBuffer
        : inputBuffer.subarray(0, bytesToProcess)

    this._pending =
      bytesToProcess === inputBuffer.length
        ? EMPTY_BUFFER
        : inputBuffer.subarray(bytesToProcess)

    const int16 = new Int16Array(
      processBuffer.buffer,
      processBuffer.byteOffset,
      processBuffer.byteLength / 2
    )
    const floatInput = int16ToFloat(int16)
    const processed = this._processFloat(floatInput)

    return processed.length === 0 ? EMPTY_BUFFER : floatToInt16Buffer(processed)
  }

  flush() {
    if (this._bypass || this._silence) return EMPTY_BUFFER

    const outputChunks = []

    if (this._pending.length > 0) {
      const int16 = new Int16Array(
        this._pending.buffer,
        this._pending.byteOffset,
        this._pending.byteLength / 2
      )
      this._pending = EMPTY_BUFFER
      const processed = this._processFloat(int16ToFloat(int16))
      if (processed.length > 0) outputChunks.push(processed)
    }

    if (this._usesStretch) {
      let tail = this._timeStretch.flush()
      if (this._effectiveRate > 1 && tail.length > 0) {
        tail = resample(tail, CHANNELS, this._effectiveRate)
      }
      if (tail.length > 0) outputChunks.push(tail)
    }

    if (outputChunks.length === 0) {
      this._reset()
      return EMPTY_BUFFER
    }

    const combined = concatFloat32(outputChunks)
    this._reset()
    return floatToInt16Buffer(combined)
  }
}
