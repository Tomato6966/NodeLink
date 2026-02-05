import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { RingBuffer } from '../structs/RingBuffer.js'

const LAYER_BUFFER_SIZE = 1024 * 1024 // 1MB per layer (~5 seconds of PCM)

export class AudioMixer extends EventEmitter {
  constructor(config = {}) {
    super()
    this.mixLayers = new Map()
    this.maxLayers = config.maxLayersMix || 5
    this.defaultVolume = config.defaultVolume || 0.8
    this.autoCleanup = config.autoCleanup !== false
    this.enabled = config.enabled !== false
  }

  _asInt16Array(buffer) {
    if (buffer.byteOffset % 2 === 0 && buffer.length % 2 === 0) {
      return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2)
    }
    
    const alignedBuffer = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)))
    return new Int16Array(alignedBuffer.buffer, alignedBuffer.byteOffset, alignedBuffer.length / 2)
  }

  mixBuffers(mainPCM, layersPCM) {
    if (layersPCM.size === 0 || !this.enabled) return mainPCM

    const outputBuffer = Buffer.allocUnsafe(mainPCM.length)

    const mainView = this._asInt16Array(mainPCM)
    const outputView = this._asInt16Array(outputBuffer)
    
    const activeLayers = []
    for (const layer of layersPCM.values()) {
      activeLayers.push({
        view: this._asInt16Array(layer.buffer),
        volume: layer.volume
      })
    }

    for (let i = 0; i < mainView.length; i++) {
      let sample = mainView[i]
      for (let j = 0; j < activeLayers.length; j++) {
        const l = activeLayers[j]
        if (i < l.view.length) {
          sample += (l.view[i] * l.volume) | 0
        }
      }
      outputView[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample
    }

    return outputBuffer
  }

  addLayer(stream, track, volume = null) {
    if (this.mixLayers.size >= this.maxLayers) {
      throw new Error(`Maximum mix layers (${this.maxLayers}) reached`)
    }

    const id = randomBytes(8).toString('hex')
    const actualVolume = volume !== null ? volume : this.defaultVolume

    const layer = {
      id,
      stream,
      track,
      volume: Math.max(0, Math.min(1, actualVolume)),
      position: 0,
      startTime: Date.now(),
      active: true,
      finishedFeeding: false,
      ringBuffer: new RingBuffer(LAYER_BUFFER_SIZE),
      receivedBytes: 0,
      pending: Buffer.alloc(0),
      paused: false
    }

    this.mixLayers.set(id, layer)

    stream.on('data', (chunk) => {
      if (!layer.active) return
      
      if (layer.ringBuffer.length > LAYER_BUFFER_SIZE * 0.8) {
        layer.paused = true
        stream.pause()
      }

      let data = chunk
      if (layer.pending.length > 0) {
        data = Buffer.concat([layer.pending, chunk])
        layer.pending = Buffer.alloc(0)
      }

      const remainder = data.length % 4
      if (remainder > 0) {
        layer.pending = data.subarray(data.length - remainder)
        data = data.subarray(0, data.length - remainder)
      }

      if (data.length > 0) {
        layer.receivedBytes += data.length
        layer.ringBuffer.write(data)
      }
    })

    stream.once('end', () => {
      layer.finishedFeeding = true 
    })

    stream.once('close', () => {
      layer.finishedFeeding = true
    })

    stream.once('error', (error) => {
      this.emit('mixError', { id, error })
      this.removeLayer(id, 'ERROR')
    })

    this.emit('mixStarted', { id, track, volume: layer.volume })

    return id
  }

  readLayerChunks(chunkSize) {
    const layerChunks = new Map()
    const safeSize = chunkSize - (chunkSize % 4)

    for (const [id, layer] of this.mixLayers.entries()) {
      if (!layer.active) continue

      if (layer.ringBuffer.length < safeSize) {
        if (layer.finishedFeeding && layer.ringBuffer.length === 0) {
          this.removeLayer(id, 'FINISHED')
        }
        continue
      }

      const chunk = layer.ringBuffer.read(safeSize)
      if (!chunk) continue

      layerChunks.set(id, { buffer: chunk, volume: layer.volume })
      layer.position += chunk.length

      if (layer.paused && layer.ringBuffer.length < LAYER_BUFFER_SIZE * 0.5) {
        layer.paused = false
        layer.stream.resume()
      }
    }

    return layerChunks
  }

  hasActiveLayers() {
    return this.mixLayers.size > 0
  }

  removeLayer(id, reason = 'REMOVED') {
    const layer = this.mixLayers.get(id)
    if (!layer) return false

    layer.active = false
    if (layer.stream && !layer.stream.destroyed) {
      layer.stream.removeAllListeners('data')
      layer.stream.destroy()
    }
    layer.ringBuffer.dispose()
    this.mixLayers.delete(id)
    this.emit('mixEnded', { id, reason })
    return true
  }

  updateLayerVolume(id, volume) {
    const layer = this.mixLayers.get(id)
    if (!layer) return false
    layer.volume = Math.max(0, Math.min(1, volume))
    return true
  }

  getLayer(id) {
    const layer = this.mixLayers.get(id)
    if (!layer) return null
    return {
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }
  }

  getLayers() {
    return Array.from(this.mixLayers.values()).map((layer) => ({
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }))
  }

  clearLayers(reason = 'CLEARED') {
    const ids = Array.from(this.mixLayers.keys())
    for (const id of ids) this.removeLayer(id, reason)
    return ids.length
  }
}