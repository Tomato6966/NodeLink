import { FiltersManager } from './filtersManager.js'
import { PassThrough, Readable } from 'node:stream'
import prism from 'prism-media'

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
  constructor(stream, type) {
    super()
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }

    const lowerType = (type || '').toLowerCase()
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
      const filters = new FiltersManager()
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(demuxer).pipe(decoder).pipe(volume).pipe(filters).pipe(opus)

      this.pipes = [stream, demuxer, decoder, volume, filters, opus]
      audioStream = opus
    } else {
      const ffmpeg = new prism.FFmpeg({
        args: [
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
          'ar',
          '48000',
          'ac',
          '2'
        ]
      })

      const volume = new prism.VolumeTransformer({ type: 's16le' })
      const filters = new FiltersManager()
      const opus = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
      })

      stream.pipe(ffmpeg).pipe(volume).pipe(filters).pipe(opus)

      this.pipes = [stream, ffmpeg, volume, filters, opus]
      audioStream = opus
    }

    this.stream = audioStream
    stream.on('finishBuffering', () => this.stream.emit('finishBuffering'))
  }
}

class FFmpegUrlAudioResource extends BaseAudioResource {
  constructor(url, type, seekTime = 0) {
    super()

    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-analyzeduration', '0',
      '-probesize', '32',
      '-thread_queue_size', '4096',
    ];

    if (seekTime > 0) {
      ffmpegArgs.push('-ss', `${seekTime / 1000}`);
    }

    ffmpegArgs.push('-i', url, '-f', 's16le', '-ar', '48000', '-ac', '2');

    const ffmpeg = new prism.FFmpeg({ args: ffmpegArgs });
    const stream = new PassThrough();
    const volume = new prism.VolumeTransformer({ type: 's16le' });
    const filters = new FiltersManager();
    const opus = new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    });

    ffmpeg.process.stdout.on('data', (data) => stream.write(data));
    ffmpeg.process.stdout.on('end', () => stream.emit('finishBuffering'));

    stream.pipe(volume).pipe(filters).pipe(opus);

    this.pipes = [ffmpeg, stream, volume, filters, opus];
    this.stream = opus;

    ffmpeg.on('close', () => this.stream.emit('finishBuffering'));
    ffmpeg.on('error', (err) => this.stream.emit('error', err));
  }
}

export const createAudioResource = (stream, type) =>
  new StreamAudioResource(stream, type)

export const createFFmpegAudioResource = (url, type, seekTime = 0) =>
  new FFmpegUrlAudioResource(url, type, seekTime)
