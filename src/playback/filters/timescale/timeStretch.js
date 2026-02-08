import FloatFifoBuffer from './floatFifoBuffer.js'

const DEFAULT_FRAME_SIZE = 1024
const DEFAULT_OVERLAP = 256
const DEFAULT_SEARCH = 128

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

export default class TimeStretch {
  constructor({
    sampleRate,
    channels,
    frameSize = DEFAULT_FRAME_SIZE,
    overlap = DEFAULT_OVERLAP,
    search = DEFAULT_SEARCH
  }) {
    this.sampleRate = sampleRate
    this.channels = channels
    this.frameSize = frameSize
    this.overlap = Math.min(overlap, frameSize - 1)
    this.search = Math.max(0, Math.floor(search))

    this._analysisHop = this.frameSize - this.overlap
    this._tempo = 1.0
    this._inputPos = 0
    this._prevOverlap = null
    this._buffer = new FloatFifoBuffer(channels)
  }

  setTempo(tempo) {
    this._tempo = tempo
  }

  reset() {
    this._buffer.clear()
    this._inputPos = 0
    this._prevOverlap = null
  }

  process(samples) {
    if (samples && samples.length > 0) {
      this._buffer.push(samples)
    }
    return this._drain(false)
  }

  flush() {
    const output = this._drain(false)
    const start = this._selectStart(true)
    if (start === null) {
      const fallback = this._prevOverlap ? concatFloat32([output, this._prevOverlap]) : output
      this.reset()
      return fallback
    }

    const segment = this._readSegment(start, true)
    const mixed = this._mixSegment(segment)
    const combined = concatFloat32([output, mixed])
    this.reset()
    return combined
  }

  _drain(allowPartial) {
    const outputChunks = []

    while (true) {
      const start = this._selectStart(allowPartial)
      if (start === null) break

      const segment = this._readSegment(start, allowPartial)
      if (!segment) break

      const mixed = this._mixSegment(segment)
      const emitFrames = allowPartial ? this.frameSize : this._analysisHop
      outputChunks.push(mixed.subarray(0, emitFrames * this.channels))
      this._advance(start)

      if (allowPartial) break
    }

    return concatFloat32(outputChunks)
  }

  _selectStart(allowPartial) {
    const available = this._buffer.frameCount
    if (this._prevOverlap === null) {
      if (available < this.frameSize && !allowPartial) return null
      if (available === 0) return null
      return 0
    }

    const expected = this._inputPos
    const minStart = Math.max(0, Math.floor(expected - this.search))
    const maxStart = Math.min(
      Math.floor(expected + this.search),
      available - this.frameSize
    )

    if (maxStart < minStart) {
      if (!allowPartial) return null
      return Math.max(0, available - this.frameSize)
    }

    let bestStart = minStart
    let bestScore = Number.NEGATIVE_INFINITY
    for (let start = minStart; start <= maxStart; start++) {
      const score = this._correlation(start)
      if (score > bestScore) {
        bestScore = score
        bestStart = start
      }
    }

    return bestStart
  }

  _correlation(startFrame) {
    const overlapSamples = this.overlap * this.channels
    const base =
      (this._buffer.startFrame + startFrame) * this.channels
    const samples = this._buffer.buffer

    let score = 0
    for (let i = 0; i < overlapSamples; i++) {
      score += (this._prevOverlap?.[i] ?? 0) * (samples[base + i] ?? 0)
    }
    return score
  }

  _readSegment(startFrame, allowPartial) {
    const available = this._buffer.frameCount - startFrame
    if (available <= 0) return null

    const framesToCopy = Math.min(this.frameSize, available)
    const segment = new Float32Array(this.frameSize * this.channels)
    this._buffer.copyTo(segment, startFrame, framesToCopy)

    if (framesToCopy < this.frameSize && !allowPartial) return null
    return segment
  }

  _mixSegment(segment) {
    const mixed = new Float32Array(segment.length)

    if (!this._prevOverlap) {
      mixed.set(segment)
    } else {
      const overlapSamples = this.overlap * this.channels
      for (let i = 0; i < overlapSamples; i++) {
        const frameIndex = Math.floor(i / this.channels)
        const fadeIn =
          this.overlap > 1 ? frameIndex / (this.overlap - 1) : 1
        const fadeOut = 1 - fadeIn
        mixed[i] = (this._prevOverlap[i] ?? 0) * fadeOut + segment[i] * fadeIn
      }
      mixed.set(segment.subarray(overlapSamples), overlapSamples)
    }

    const overlapStart = this._analysisHop * this.channels
    this._prevOverlap = new Float32Array(this.overlap * this.channels)
    this._prevOverlap.set(mixed.subarray(overlapStart, overlapStart + this._prevOverlap.length))

    return mixed
  }

  _advance(startFrame) {
    const inputHop = this._analysisHop * this._tempo
    this._inputPos = startFrame + inputHop

    const discard = Math.max(0, Math.floor(this._inputPos) - this.search)
    if (discard > 0) {
      this._buffer.discard(discard)
      this._inputPos -= discard
    }
  }
}
