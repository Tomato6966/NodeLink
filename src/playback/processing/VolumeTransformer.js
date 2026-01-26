import { Transform } from 'node:stream'

const FADE_FRAMES = 50 

const VOLUME_LUT = new Int32Array(151)
for (let i = 0; i <= 150; i++) {
  const floatMultiplier = Math.tan(i * 0.0079)
  VOLUME_LUT[i] = Math.floor(floatMultiplier * 10000)
}

export class VolumeTransformer extends Transform {
  constructor(options = {}) {
    super({ highWaterMark: 3840, ...options })
    this.targetVolume = options.volume ?? 1.0
    this.currentVolume = this.targetVolume
    this.startFadeVolume = this.targetVolume
    this.fadeProgress = FADE_FRAMES

    this.integerMultiplier = 10000
    this.lastVolumePercent = null
  }

  _setupMultipliers(activeVolumePercent) {
    const roundedPercent = Math.round(activeVolumePercent)
    if (roundedPercent <= 150) {
      this.integerMultiplier = VOLUME_LUT[Math.max(0, roundedPercent)]
    } else {
      this.integerMultiplier = Math.floor((24621 * activeVolumePercent) / 150)
    }
  }

  setVolume(volume) {
    if (this.targetVolume === volume) return
    this.startFadeVolume = this.currentVolume
    this.targetVolume = volume
    this.fadeProgress = 0
  }

  process(chunk) {
    const sampleCount = chunk.length / 2
    if (!sampleCount) return chunk

    let volumeToApply = this.currentVolume
    if (this.fadeProgress < FADE_FRAMES) {
      const progress = this.fadeProgress / FADE_FRAMES
      volumeToApply = this.startFadeVolume + (this.targetVolume - this.startFadeVolume) * progress
      this.fadeProgress++
    } else {
      volumeToApply = this.targetVolume
    }
    this.currentVolume = volumeToApply

    const volumePercent = volumeToApply * 100
    if (Math.round(volumePercent) === 100) return chunk

    if (volumePercent !== this.lastVolumePercent) {
      this._setupMultipliers(volumePercent)
      this.lastVolumePercent = volumePercent
    }

    const multiplier = this.integerMultiplier
    const view = chunk.byteOffset % 2 === 0 
      ? new Int16Array(chunk.buffer, chunk.byteOffset, sampleCount)
      : new Int16Array(Uint8Array.prototype.slice.call(chunk).buffer)

    for (let i = 0; i < view.length; i++) {
      const val = (view[i] * multiplier) / 10000
      view[i] = val < -32768 ? -32768 : val > 32767 ? 32767 : (val | 0)
    }

    return chunk.byteOffset % 2 === 0 ? chunk : Buffer.from(view.buffer)
  }

  flush() {
    return Buffer.alloc(0)
  }

  _transform(chunk, _encoding, callback) {
    this.push(this.process(chunk))
    callback()
  }
}