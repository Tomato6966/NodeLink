import { FiltersManager } from './filtersManager.js'
import { PassThrough, Readable } from 'node:stream'
import prism from 'prism-media'

function buildTimescaleArgs(timescale = {}) {
  const { speed = 1.0, pitch = 1.0, rate = 1.0 } = timescale
  if (speed === 1.0 && pitch === 1.0 && rate === 1.0) return []

  const sampleRate = 48000
  const finalRate = sampleRate * speed * pitch
  const tempo = rate / pitch

  const filters = []
  if (Math.abs(finalRate - sampleRate) > 1) {
    filters.push(`asetrate=${finalRate}`)
  }

  if (tempo !== 1.0) {
    const MAX_ATEMPO = 100.0
    const MIN_ATEMPO = 0.5
    let currentTempo = tempo
    while (currentTempo > MAX_ATEMPO) {
      filters.push(`atempo=${MAX_ATEMPO}`)
      currentTempo /= MAX_ATEMPO
    }
    while (currentTempo < MIN_ATEMPO && currentTempo > 0) {
      filters.push(`atempo=${MIN_ATEMPO}`)
      currentTempo /= MIN_ATEMPO
    }
    if (
      currentTempo !== 1.0 &&
      currentTempo >= MIN_ATEMPO &&
      currentTempo <= MAX_ATEMPO
    ) {
      filters.push(`atempo=${currentTempo}`)
    }
  }

  if (filters.length === 0) return []
  return ['-af', filters.join(',')]
}

class BaseAudioResource {
  constructor() {
    this.pipes = []
    this.stream = null
  }

  _end() {
    if (!this.pipes) return

    for (const pipe of this.pipes) {
      pipe.unpipe?.()
      pipe.destroy?.()
      pipe.removeAllListeners?.()
    }

    this.stream = null
    this.pipes = null
  }

  destroy() {
    this._end()
  }

  setVolume(volume) {
    if (!this.pipes) return

    const volumeTransformer = this.pipes.find(
      (pipe) => pipe instanceof prism.VolumeTransformer
    )
    if (volumeTransformer) {
      volumeTransformer.setVolume(volume)
    } else {
      throw new Error('VolumeTransformer not found in the pipeline.')
    }
  }

  setFilters(filters) {
    if (!this.pipes) return

    const filterTransformer = this.pipes.find(
      (pipe) => pipe instanceof FiltersManager
    )

    if (filterTransformer) {
      filterTransformer.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }

  emit(event, ...args) {
    this.stream.emit(event, ...args)
  }
  on(event, listener) {
    this.stream.on(event, listener)
  }
  off(event, listener) {
    this.stream.off(event, listener)
  }
  once(event, listener) {
    this.stream.once(event, listener)
  }
  removeListener(event, listener) {
    this.stream.removeListener(event, listener)
  }
  removeAllListeners() {
    if (!this.stream?.eventNames) return

    for (const eventName of this.stream.eventNames()) {
      for (const listener of this.stream.listeners(eventName)) {
        this.stream.removeListener(eventName, listener)
      }
    }
  }
  read() {
    return this.stream?.read()
  }
  resume() {
    this.stream?.resume()
  }
}

class StreamAudioResource extends BaseAudioResource {
  constructor(stream, type, nodelink, initialFilters = {}) {
    super()
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }

    const lowerType = (type || '').toLowerCase()
    const timescale = initialFilters.filters?.timescale
    const useFFmpegForTimescale =
      timescale &&
      (timescale.speed !== 1.0 ||
        timescale.pitch !== 1.0 ||
        timescale.rate !== 1.0)

    let audioStream

    if (
      !['webm/opus', 'ogg/opus'].includes(lowerType) ||
      useFFmpegForTimescale
    ) {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-analyzeduration',
        '0',
        '-probesize',
        '32',
        '-thread_queue_size',
        '4096',
        '-i',
        '-',
        ...buildTimescaleArgs(timescale),
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2'
      ]
      const ffmpeg = new prism.FFmpeg({ args: ffmpegArgs })
      const volume = new prism.VolumeTransformer({ type: 's16le' })
      const filters = new FiltersManager(nodelink, initialFilters)
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(ffmpeg).pipe(volume).pipe(filters).pipe(opus)

      this.pipes = [stream, ffmpeg, volume, filters, opus]
      audioStream = opus
    } else {
      const DemuxerClass =
        lowerType === 'webm/opus'
          ? prism.opus.WebmDemuxer
          : prism.opus.OggDemuxer
      const demuxer = new DemuxerClass()
      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })
      const volume = new prism.VolumeTransformer({ type: 's16le' })
      const filters = new FiltersManager(nodelink, initialFilters)
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(demuxer).pipe(decoder).pipe(volume).pipe(filters).pipe(opus)

      this.pipes = [stream, demuxer, decoder, volume, filters, opus]
      audioStream = opus
    }

    this.stream = audioStream
    stream.on('finishBuffering', () => this.stream.emit('finishBuffering'))
  }
}

class FFmpegUrlAudioResource extends BaseAudioResource {
  constructor(url, type, seekTime = 0, nodelink, initialFilters = {}) {
    super()

    const timescale = initialFilters.filters?.timescale
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-analyzeduration',
      '0',
      '-probesize',
      '32',
      '-thread_queue_size',
      '4096'
    ]

    if (seekTime > 0) {
      ffmpegArgs.push('-ss', `${seekTime / 1000}`)
    }

    ffmpegArgs.push(
      '-i',
      url,
      ...buildTimescaleArgs(timescale),
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2'
    )

    const ffmpeg = new prism.FFmpeg({ args: ffmpegArgs })
    const stream = new PassThrough()
    const volume = new prism.VolumeTransformer({ type: 's16le' })
    const filters = new FiltersManager(nodelink, initialFilters)
    const opus = new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    })

    ffmpeg.process.stdout.on('data', (data) => stream.write(data))
    ffmpeg.process.stdout.on('end', () => stream.emit('finishBuffering'))

    stream.pipe(volume).pipe(filters).pipe(opus)

    this.pipes = [ffmpeg, stream, volume, filters, opus]
    this.stream = opus

    ffmpeg.on('close', () => this.stream.emit('finishBuffering'))
    ffmpeg.on('error', (err) => this.stream.emit('error', err))
  }
}

export const createAudioResource = (
  stream,
  type,
  nodelink,
  initialFilters = {}
) => new StreamAudioResource(stream, type, nodelink, initialFilters)

export const createFFmpegAudioResource = (
  url,
  type,
  seekTime = 0,
  nodelink,
  initialFilters = {}
) => new FFmpegUrlAudioResource(url, type, seekTime, nodelink, initialFilters)
