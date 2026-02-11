export default class FloatFifoBuffer {
  constructor(channels) {
    this._channels = channels
    this._buffer = new Float32Array(0)
    this._startFrame = 0
    this._frames = 0
  }

  get frameCount() {
    return this._frames
  }

  get startFrame() {
    return this._startFrame
  }

  get channels() {
    return this._channels
  }

  get buffer() {
    return this._buffer
  }

  clear() {
    this._buffer = new Float32Array(0)
    this._startFrame = 0
    this._frames = 0
  }

  _startIndex() {
    return this._startFrame * this._channels
  }

  _endIndex() {
    return (this._startFrame + this._frames) * this._channels
  }

  _ensureCapacity(targetFrames) {
    const requiredSamples = targetFrames * this._channels
    if (this._buffer.length < requiredSamples) {
      const next = new Float32Array(requiredSamples)
      if (this._frames > 0) {
        next.set(this._buffer.subarray(this._startIndex(), this._endIndex()))
      }
      this._buffer = next
      this._startFrame = 0
      return
    }

    if (this._startFrame > 0) {
      this._buffer.set(
        this._buffer.subarray(this._startIndex(), this._endIndex())
      )
      this._startFrame = 0
    }
  }

  push(samples) {
    const frames = Math.floor(samples.length / this._channels)
    if (frames <= 0) return
    const sampleCount = frames * this._channels
    this._ensureCapacity(this._frames + frames)
    this._buffer.set(samples.subarray(0, sampleCount), this._endIndex())
    this._frames += frames
  }

  copyTo(target, startFrame, frameCount) {
    if (frameCount <= 0) return
    const startIndex = (this._startFrame + startFrame) * this._channels
    const sampleCount = frameCount * this._channels
    target.set(this._buffer.subarray(startIndex, startIndex + sampleCount), 0)
  }

  discard(frames) {
    if (frames <= 0) return
    if (frames >= this._frames) {
      this.clear()
      return
    }
    this._startFrame += frames
    this._frames -= frames
  }
}
