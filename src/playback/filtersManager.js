import { Transform } from 'node:stream'
import { logger } from '../utils.js'

import ChannelMix from './filters/channelMix.js'
import Chorus from './filters/chorus.js'
import Compressor from './filters/compressor.js'
import Distortion from './filters/distortion.js'
import Echo from './filters/echo.js'
import Equalizer from './filters/equalizer.js'
import Flanger from './filters/flanger.js'
import Highpass from './filters/highpass.js'
import Karaoke from './filters/karaoke.js'
import Lowpass from './filters/lowpass.js'
import Phaser from './filters/phaser.js'
import Reverb from './filters/reverb.js'
import Rotation from './filters/rotation.js'
import Timescale from './filters/timescale.js'
import Tremolo from './filters/tremolo.js'
import Vibrato from './filters/vibrato.js'
import Spatial from './filters/spatial.js'

export class FiltersManager extends Transform {
  constructor(nodelink, options = {}) {
    super(options)
    this.nodelink = nodelink
    this.activeFilters = []

    this.availableFilters = {
      tremolo: new Tremolo(),
      vibrato: new Vibrato(),
      lowpass: new Lowpass(),
      highpass: new Highpass(),
      rotation: new Rotation(),
      karaoke: new Karaoke(),
      distortion: new Distortion(),
      channelMix: new ChannelMix(),
      equalizer: new Equalizer(),
      chorus: new Chorus(),
      compressor: new Compressor(),
      echo: new Echo(),
      phaser: new Phaser(),
      timescale: new Timescale(),
      spatial: new Spatial(),
      reverb: new Reverb(),
      flanger: new Flanger()
    }

    if (this.nodelink.extensions?.filters) {
      for (const [name, filter] of this.nodelink.extensions.filters) {
        this.availableFilters[name] = filter
      }
    }

    this.update(options)
  }

  update(filters) {
    this.activeFilters = []

    for (const filterName in this.availableFilters) {
      const filter = this.availableFilters[filterName]

      if (filters.filters?.[filterName]) {
        this.activeFilters.push(filter)
      }

      filter.update(filters.filters || filters)
    }

    this.activeFilters.sort((a, b) => (a.priority || 99) - (b.priority || 99))

    if (this.activeFilters.length > 0) {
      logger(
        'debug',
        'Filters',
        `Active filter order: ${this.activeFilters.map((f) => f.constructor.name).join(', ')}`
      )
    }
  }

  _transform(chunk, encoding, callback) {
    if (this.activeFilters.length === 0) {
      this.push(chunk)
      return callback()
    }

    let processedChunk = chunk
    for (const filter of this.activeFilters) {
      processedChunk = filter.process(processedChunk)
    }

    if (processedChunk && processedChunk.length > 0) {
      this.push(processedChunk)
    }

    callback()
  }

  _flush(callback) {
    let remainingChunk = Buffer.alloc(0)

    for (const filter of this.activeFilters) {
      if (typeof filter.flush === 'function') {
        const flushed = filter.flush()
        if (flushed && flushed.length > 0) {
          remainingChunk = Buffer.concat([remainingChunk, flushed])
        }
      }
    }

    if (remainingChunk.length > 0) {
      this.push(remainingChunk)
    }

    callback()
  }
}
