import { Transform } from 'node:stream'
import { clamp16Bit } from './filters/dsp/clamp16Bit.js'

const FADE_FRAMES = 50 // 50 frames * 20ms/frame = 1 second fade

export class VolumeTransformer extends Transform {
  constructor(options = {}) {
    super({ highWaterMark: 3840, ...options })
    this.targetVolume = options.volume ?? 1.0
    this.currentVolume = this.targetVolume
    this.startFadeVolume = this.targetVolume
    this.fadeProgress = FADE_FRAMES

    this.integerMultiplier = 10000
  }

  _setupMultipliers(activeVolumePercent) {
    if (activeVolumePercent <= 150) {
      const floatMultiplier = Math.tan(activeVolumePercent * 0.0079)
      this.integerMultiplier = Math.floor(floatMultiplier * 10000)
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

  _transform(chunk, _encoding, callback) {
    let volumeToApply = this.currentVolume

    if (this.fadeProgress < FADE_FRAMES) {
      const progress = this.fadeProgress / FADE_FRAMES
      volumeToApply =
        this.startFadeVolume +
        (this.targetVolume - this.startFadeVolume) * progress
      this.fadeProgress++
    } else {
      volumeToApply = this.targetVolume
    }

    this.currentVolume = volumeToApply

    const volumePercent = volumeToApply * 100

    if (Math.round(volumePercent) === 100) {
      this.push(chunk)
      return callback()
    }

    this._setupMultipliers(volumePercent)

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i)
      const value = (sample * this.integerMultiplier) / 10000
      chunk.writeInt16LE(clamp16Bit(value), i)
    }

    this.push(chunk)
    callback()
  }
}
