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
} from '../../typings/playback/filters.types.ts'
import type { FiltersState } from '../../typings/playback/player.types.ts'
import type { IFiltersManager } from '../../typings/playback/processing.types.ts'

import ChannelMix from '../filters/channelMix.ts'
import Chorus from '../filters/chorus.ts'
import Compressor from '../filters/compressor.ts'
import Distortion from '../filters/distortion.ts'
import Echo from '../filters/echo.ts'
import Equalizer from '../filters/equalizer.ts'
import Flanger from '../filters/flanger.ts'
import Highpass from '../filters/highpass.ts'
import Karaoke from '../filters/karaoke.ts'
import Lowpass from '../filters/lowpass.ts'
import Phaser from '../filters/phaser.ts'
import Phonograph from '../filters/phonograph.ts'
import Reverb from '../filters/reverb.ts'
import Rotation from '../filters/rotation.ts'
import Spatial from '../filters/spatial.ts'
import Timescale from '../filters/timescale.ts'
import Tremolo from '../filters/tremolo.ts'
import Vibrato from '../filters/vibrato.ts'

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
  flanger: Flanger,
  phonograph: Phonograph
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
export class FiltersManager extends Transform implements IFiltersManager {
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
