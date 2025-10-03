import { Filters } from './Filters.js'
import { Readable } from 'node:stream'
import prism from 'prism-media'

class streamProcessor {
  constructor(stream, type) {
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }

    const lowerType = (type || '').toLowerCase()
    let pipeline = []
    let audioStream

    if (['webm/opus', 'ogg/opus'].includes(lowerType)) {
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
      const filters = new Filters()
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(demuxer).pipe(decoder).pipe(volume).pipe(filters).pipe(opus)

      pipeline = [stream, demuxer, decoder, volume, filters, opus]
      audioStream = opus
    } else {
      const ffmpeg = new prism.FFmpeg({
        args: [
          '-re',
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
          '-f',
          's16le',
          '-ar',
          '48000',
          '-ac',
          '2'
        ]
      })

      const volume = new prism.VolumeTransformer({ type: 's16le' })
      const filters = new Filters()
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(ffmpeg).pipe(volume).pipe(filters).pipe(opus)

      pipeline = [stream, ffmpeg, volume, filters, opus]
      audioStream = opus
    }

    this.pipes = pipeline
    this.stream = audioStream

    stream.on('finishBuffering', () => this.stream.emit('finishBuffering'))
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
      (pipe) => pipe instanceof Filters
    )

    if (filterTransformer) {
      filterTransformer.update(filters)
    } else {
      throw new Error('Filters not found in the pipeline.')
    }
  }
}

export const createAudioResource = (stream, type) =>
  new streamProcessor(stream, type)
