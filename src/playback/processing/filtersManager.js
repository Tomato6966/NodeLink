import { Transform } from 'node:stream'
import { logger } from '../../utils.js'

import ChannelMix from '../filters/channelMix.js'
import Chorus from '../filters/chorus.js'
import Compressor from '../filters/compressor.js'
import Distortion from '../filters/distortion.js'
import Echo from '../filters/echo.js'
import Equalizer from '../filters/equalizer.js'
import Flanger from '../filters/flanger.js'
import Highpass from '../filters/highpass.js'
import Karaoke from '../filters/karaoke.js'
import Lowpass from '../filters/lowpass.js'
import Phaser from '../filters/phaser.js'
import Reverb from '../filters/reverb.js'
import Rotation from '../filters/rotation.js'
import Spatial from '../filters/spatial.js'
import Timescale from '../filters/timescale.js'
import Tremolo from '../filters/tremolo.js'
import Vibrato from '../filters/vibrato.js'

const FILTER_CLASSES = {
  tremolo: Tremolo,
  vibrato: Vibrato,
  lowpass: Lowpass,
  highpass: Highpass,
  rotation: Rotation,
  karaoke: Karaoke,
  distortion: Distortion,
  channelMix: ChannelMix,
  equalizer: Equalizer,
  chorus: Chorus,
  compressor: Compressor,
  echo: Echo,
  phaser: Phaser,
  timescale: Timescale,
  spatial: Spatial,
  reverb: Reverb,
  flanger: Flanger
}

export class FiltersManager extends Transform {
  constructor(nodelink, options = {}) {
    super(options)
    this.nodelink = nodelink
    this.activeFilters = []
    this.filterInstances = {}

    if (this.nodelink.extensions?.filters) {
      for (const [name, filter] of this.nodelink.extensions.filters) {
        this.filterInstances[name] = filter
      }
    }

    this.update(options)
  }

  update(filters) {
    this.activeFilters = []
    const settings = filters.filters || filters

    for (const name in settings) {
      const config = settings[name]
      if (!config) continue

      if (FILTER_CLASSES[name] && !this.filterInstances[name]) {
        this.filterInstances[name] = new FILTER_CLASSES[name]()
      }

      const instance = this.filterInstances[name]
      if (instance) {
        this.activeFilters.push(instance)
        if (typeof instance.update === 'function') {
          instance.update(settings)
        }
      }
    }

    this.activeFilters.sort((a, b) => (a.priority || 99) - (b.priority || 99))
  }

  process(chunk) {
    if (this.activeFilters.length === 0) return chunk

    let processed = chunk
    for (const filter of this.activeFilters) {
      processed = filter.process(processed)
    }
    return processed
  }

  flush() {
    let remaining = Buffer.alloc(0)
    for (const filter of this.activeFilters) {
      if (typeof filter.flush === 'function') {
        const flushed = filter.flush()
        if (flushed && flushed.length > 0) {
          remaining = Buffer.concat([remaining, flushed])
        }
      }
    }
    return remaining
  }

  _transform(chunk, _encoding, callback) {
    this.push(this.process(chunk))
    callback()
  }

  _flush(callback) {
    const remaining = this.flush()
    if (remaining.length > 0) this.push(remaining)
    callback()
  }
}