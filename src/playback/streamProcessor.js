import { FiltersManager } from './filtersManager.js'
import { PassThrough, Readable, Transform } from 'node:stream'
import prism from 'prism-media'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MPEGDecoder } = require('mpg123-decoder')
const LibSampleRate = require('@alexanderolsen/libsamplerate-js')

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

class MpegDecoderStream extends Transform {
  constructor(options) {
    super(options)
    this.decoder = new MPEGDecoder()
    this.resampler = null
    this.isDecoderReady = false

    this.decoder.ready.then(() => {
        this.isDecoderReady = true;
        this.emit('decoderReady');
    }).catch(err => this.emit('error', err));
  }

  _transform(chunk, encoding, callback) {
    if (!this.isDecoderReady) {
        this.once('decoderReady', () => this._transform(chunk, encoding, callback));
        return;
    }

    try {
        const { channelData, samplesDecoded, sampleRate, channels } = this.decoder.decode(chunk);

        if (samplesDecoded > 0) {
            if (sampleRate === 48000) {
                this._process(channelData, channels, callback);
            } else if (this.resampler) {
                this._resample(channelData, channels, callback);
            } else {
                LibSampleRate.create(2, sampleRate, 48000, { converterType: LibSampleRate.ConverterType.SRC_SINC_BEST_QUALITY })
                    .then(src => {
                        this.resampler = src;
                        this._resample(channelData, channels, callback);
                    })
                    .catch(err => callback(err));
            }
        } else {
            callback();
        }
    } catch (e) {
        callback(e);
    }
  }

  _process(channelData, channels, callback) {
    const sampleCount = channelData[0].length;
    const pcm = new Int16Array(sampleCount * 2);
    const floatL = channelData[0];
    const floatR = channels > 1 ? channelData[1] : floatL;

    for (let i = 0; i < sampleCount; i++) {
        pcm[i * 2] = Math.max(-1, Math.min(1, floatL[i])) * 32767;
        pcm[i * 2 + 1] = Math.max(-1, Math.min(1, floatR[i])) * 32767;
    }
    
    this.push(Buffer.from(pcm.buffer));
    callback();
  }

  _resample(channelData, channels, callback) {
    const floatL = channelData[0];
    const floatR = channels > 1 ? channelData[1] : floatL;
    const interleaved = new Float32Array(floatL.length * 2);
    for (let i = 0; i < floatL.length; i++) {
        interleaved[i * 2] = floatL[i];
        interleaved[i * 2 + 1] = floatR[i];
    }

    const resampled = this.resampler.full(interleaved);

    const pcmInt16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
        pcmInt16[i] = Math.max(-1, Math.min(1, resampled[i])) * 32767;
    }

    this.push(Buffer.from(pcmInt16.buffer));
    callback();
  }

  _flush(callback) {
    if (this.resampler) {
        this.resampler.destroy();
    }
    callback();
  }
}

class StreamAudioResource extends BaseAudioResource {
  constructor(stream, type, nodelink, initialFilters = {}) {
    super()
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }

    const lowerType = (type || '').toLowerCase()
    let pcmStream

    this.pipes = [stream]

    if (['audio/mpeg', 'audio/mp3'].includes(lowerType)) {
      const mpegDecoder = new MpegDecoderStream()
      pcmStream = stream.pipe(mpegDecoder)
      this.pipes.push(mpegDecoder)
    } else if (['webm/opus', 'ogg/opus'].includes(lowerType)) {
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
      pcmStream = stream.pipe(demuxer).pipe(decoder)
      this.pipes.push(demuxer, decoder)
    } else {
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
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2'
      ]
      const ffmpeg = new prism.FFmpeg({ args: ffmpegArgs })
      pcmStream = stream.pipe(ffmpeg)
      this.pipes.push(ffmpeg)
    }

    const volume = new prism.VolumeTransformer({ type: 's16le' })
    const filters = new FiltersManager(nodelink, initialFilters)
    const opus = new prism.opus.Encoder({
      rate: 48000,
      channels: 2,
      frameSize: 960
    })

    pcmStream.pipe(volume).pipe(filters).pipe(opus)

    this.pipes.push(volume, filters, opus)
    this.stream = opus

    stream.on('finishBuffering', () => this.stream.emit('finishBuffering'))
  }
}

class FFmpegUrlAudioResource extends BaseAudioResource {
  constructor(url, type, seekTime = 0, nodelink, initialFilters = {}) {
    super()

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
