import { Transform } from 'node:stream'

const FRAME_SIZE = 3840

export class FlowController extends Transform {
  constructor(filters, volume, fade, audioMixer = null) {
    super({ highWaterMark: 1920 })

    this.filters = filters
    this.volume = volume
    this.fade = fade
    this.audioMixer = audioMixer
    this.pending = Buffer.alloc(0)
  }

  setVolume(volume) {
    this.volume.setVolume(volume)
  }

  setFilters(filters) {
    this.filters.update(filters)
  }

  setFadeVolume(volume) {
    this.fade.setGain(volume)
  }

  fadeTo(volume, durationMs, curve) {
    this.fade.fadeTo(volume, durationMs, curve)
  }

  _transform(chunk, encoding, callback) {
    this.pending = Buffer.concat([this.pending, chunk])

    while (this.pending.length >= FRAME_SIZE) {
      const processed = Buffer.allocUnsafe(FRAME_SIZE)
      this.pending.copy(processed, 0, 0, FRAME_SIZE)
      this.pending = Buffer.from(this.pending.subarray(FRAME_SIZE))

      let output = processed

      if (this.filters) output = this.filters.process(output)
      if (this.volume) output = this.volume.process(output)
      if (this.fade) output = this.fade.process(output)

      if (this.audioMixer?.enabled && this.audioMixer.hasActiveLayers()) {
        try {
          const layerChunks = this.audioMixer.readLayerChunks(output.length)
          output = this.audioMixer.mixBuffers(output, layerChunks)
        } catch (_error) {}
      }

      this.push(output)
    }

    callback()
  }

  _flush(callback) {
    let remaining = this.pending
    this.pending = Buffer.alloc(0)

    if (this.filters) remaining = Buffer.concat([remaining, this.filters.flush()])
    
    if (remaining.length > 0) {
      if (this.volume) remaining = this.volume.process(remaining)
      if (this.fade) remaining = this.fade.process(remaining)

      if (this.audioMixer?.enabled && this.audioMixer.hasActiveLayers()) {
        try {
          const layerChunks = this.audioMixer.readLayerChunks(remaining.length)
          remaining = this.audioMixer.mixBuffers(remaining, layerChunks)
        } catch (_error) {}
      }
      
      const finalRemainder = remaining.length % 4
      if (finalRemainder > 0) {
        remaining = remaining.subarray(0, remaining.length - finalRemainder)
      }
      
      if (remaining.length > 0) this.push(remaining)
    }

    callback()
  }
}