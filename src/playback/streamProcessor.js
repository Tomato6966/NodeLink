import prism from 'prism-media'
import { Readable } from 'node:stream'

class streamProcessor {
  constructor(stream, type) {
    if (!stream || !(stream instanceof Readable)) {
      throw new Error('Invalid stream provided')
    }

    const ffmpeg = new prism.FFmpeg({
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-analyzeduration',
        '0',
        '-probesize',
        '32',
        '-fflags',
        'nobuffer',
        '-flags',
        'low_delay',
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
    const opus = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 })

    stream.pipe(ffmpeg).pipe(volume).pipe(opus)
    this.pipes = [stream, ffmpeg, volume, opus]
    this.stream = opus

    stream.on('finishBuffering', () => {
      this.stream.emit('finishBuffering')
    })
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
    const stream = this.stream
    if (!stream?.eventNames) return

    for (const eventName of stream.eventNames()) {
      for (const listener of stream.listeners(eventName)) {
        stream.removeListener(eventName, listener)
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
    this.pipes[2].setVolume(volume)
  }
}

export const createAudioResource = (stream, type) => new streamProcessor(stream, type)
