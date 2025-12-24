import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { RingBuffer } from './RingBuffer.js'

const LAYER_BUFFER_SIZE = 1024 * 1024 // 1MB per layer (~5 seconds of PCM)

export class AudioMixer extends EventEmitter {
  constructor(config = {}) {
    super()
    this.mixLayers = new Map()
    this.maxLayers = config.maxLayersMix || 5
    this.defaultVolume = config.defaultVolume || 0.8
    this.autoCleanup = config.autoCleanup !== false
    this.enabled = config.enabled !== false
    this.outputBuffer = Buffer.allocUnsafe(3840) 
  }

  mixBuffers(mainPCM, layersPCM) {
    if (layersPCM.size === 0 || !this.enabled) {
      return mainPCM
    }

    if (this.outputBuffer.length < mainPCM.length) {
      this.outputBuffer = Buffer.allocUnsafe(mainPCM.length)
    }
    
    for (let i = 0; i < mainPCM.length; i += 2) {
      let mainSample = mainPCM.readInt16LE(i)
      
      for (const layer of layersPCM.values()) {
        if (i < layer.buffer.length) {
          const layerSample = layer.buffer.readInt16LE(i)
          mainSample += Math.floor(layerSample * layer.volume)
        }
      }
      
      mainSample = Math.max(-32768, Math.min(32767, mainSample))
      this.outputBuffer.writeInt16LE(mainSample, i)
    }
    
    return this.outputBuffer.subarray(0, mainPCM.length)
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
      ringBuffer: new RingBuffer(LAYER_BUFFER_SIZE),
      receivedBytes: 0,
      emptyReads: 0
    }

    this.mixLayers.set(id, layer)

    stream.on('data', (chunk) => {
      if (layer.active) {
        layer.receivedBytes += chunk.length
        layer.ringBuffer.write(chunk)
        layer.emptyReads = 0
      }
    })

    stream.once('error', (error) => {
      this.emit('mixError', { id, error })
      this.removeLayer(id, 'ERROR')
    })

    this.emit('mixStarted', {
      id,
      track,
      volume: layer.volume
    })

    return id
  }

  readLayerChunks(chunkSize) {
    const layerChunks = new Map()

    for (const [id, layer] of this.mixLayers.entries()) {
      if (layer.ringBuffer.length === 0) {
        layer.emptyReads++
        
        if (layer.emptyReads >= 3 && layer.receivedBytes > 0) {
          this.removeLayer(id, 'FINISHED')
        }
        continue
      }

      if (!layer.active) {
        continue
      }

      const chunk = layer.ringBuffer.read(chunkSize)
      if (!chunk) continue

      layer.emptyReads = 0
      
      layerChunks.set(id, {
        buffer: chunk,
        volume: layer.volume
      })

      layer.position += chunk.length
    }

    return layerChunks
  }


  hasActiveLayers() {
    return this.mixLayers.size > 0
  }


  removeLayer(id, reason = 'REMOVED') {
    const layer = this.mixLayers.get(id)
    if (!layer) {
      return false
    }


    layer.active = false
    
    if (layer.stream && !layer.stream.destroyed) {
      layer.stream.destroy()
    }

    layer.ringBuffer.dispose()

    this.mixLayers.delete(id)


    this.emit('mixEnded', { id, reason })


    return true
  }


  updateLayerVolume(id, volume) {
    const layer = this.mixLayers.get(id)
    if (!layer) {
      return false
    }


    layer.volume = Math.max(0, Math.min(1, volume))
    return true
  }


  getLayer(id) {
    const layer = this.mixLayers.get(id)
    if (!layer) {
      return null
    }


    return {
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }
  }


  getLayers() {
    return Array.from(this.mixLayers.values()).map(layer => ({
      id: layer.id,
      track: layer.track,
      volume: layer.volume,
      position: layer.position,
      startTime: layer.startTime
    }))
  }


  clearLayers(reason = 'CLEARED') {
    const ids = Array.from(this.mixLayers.keys())
    
    for (const id of ids) {
      this.removeLayer(id, reason)
    }


    return ids.length
  }
}
