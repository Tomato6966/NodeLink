import {
  Transform,
  type TransformCallback,
  type TransformOptions
} from 'node:stream'
import type {
  FilterClass,
  FilterInstance,
  FilterSettings,
  FiltersManagerContext
} from '../../typings/filters.types.ts'
import type { FiltersState } from '../../typings/player.types.ts'

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

const FILTER_CLASSES: Record<string, FilterClass> = {
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

/**
 * Manages the active filter chain and applies it to PCM buffers.
 * @example
 * ```ts
 * const manager = new FiltersManager(nodelink, { filters: { timescale: { speed: 1.1 } } })
 * stream.pipe(manager).on('data', (chunk) => console.log(chunk.length))
 * ```
 * @public
 */
export class FiltersManager extends Transform {
  private readonly nodelink: FiltersManagerContext
  private activeFilters: FilterInstance[]
  private filterInstances: Record<string, FilterInstance>

  /**
   * Creates a new filter manager.
   * @param nodelink - NodeLink context for extensions.
   * @param initialFilters - Initial filter payload.
   * @param options - Transform options for the stream pipeline.
   */
  constructor(
    nodelink: FiltersManagerContext,
    initialFilters: FiltersState = {},
    options: TransformOptions = {}
  ) {
    super(options)
    this.nodelink = nodelink
    this.activeFilters = []
    this.filterInstances = {}

    if (this.nodelink.extensions?.filters) {
      for (const [name, filter] of this.nodelink.extensions.filters) {
        this.filterInstances[name] = filter
      }
    }

    this.update(initialFilters)
  }

  /**
   * Updates the active filter chain using a new filter payload.
   * @param filters - Filter settings (supports `{ filters: {...} }` or direct map).
   */
  update(filters: FiltersState | FilterSettings): void {
    this.activeFilters = []
    const settings = this._normalizeFilters(filters)

    for (const name in settings) {
      const config = (settings as Record<string, unknown>)[name]
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

    this.activeFilters.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  }

  /**
   * Processes a PCM buffer through the active filter chain.
   * @param chunk - PCM audio chunk.
   */
  process(chunk: Buffer): Buffer {
    if (this.activeFilters.length === 0) return chunk

    let processed = chunk
    for (const filter of this.activeFilters) {
      processed = filter.process(processed)
    }
    return processed
  }

  /**
   * Flushes any buffered filter data.
   */
  flush(): Buffer {
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

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.push(this.process(chunk))
    callback()
  }

  override _flush(callback: TransformCallback): void {
    const remaining = this.flush()
    if (remaining.length > 0) this.push(remaining)
    callback()
  }

  /**
   * Normalizes incoming filter payloads to a simple settings map.
   * @param filters - Filter payload in any supported shape.
   */
  private _normalizeFilters(
    filters: FiltersState | FilterSettings
  ): FilterSettings {
    if (!filters || typeof filters !== 'object') return {}
    if ('filters' in filters) {
      return (filters as FiltersState).filters ?? {}
    }
    return filters as FilterSettings
  }
}
