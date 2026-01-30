import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest } from '../utils.js'

export default class PiperSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = this.nodelink.options.sources?.pipertts || {}
    this.searchTerms = ['pipertts']
    this.patterns = [/^pipertts:/]
    this.priority = 50
  }

  async setup() {
    if (!this.config.enabled) {
      logger('debug', 'Piper', 'Piper TTS source is disabled.')
      return false
    }

    if (!this.config.url) {
      logger(
        'warn',
        'Piper',
        'Piper TTS is enabled but no URL is configured. Source will be disabled.'
      )
      return false
    }

    logger('info', 'Sources', 'Loaded Piper TTS source.')
    return true
  }

  async search(query) {
    if (!query) return { loadType: 'empty', data: {} }

    // Strip prefix if present
    const text = query.startsWith('pipertts:') ? query.slice(9) : query
    const track = this.buildTrack(text)

    return {
      loadType: 'track',
      data: track
    }
  }

  async resolve(query) {
    return this.search(query)
  }

  buildTrack(text) {
    const track = {
      identifier: text,
      isSeekable: true,
      author: 'Piper TTS',
      length: -1,
      isStream: false,
      position: 0,
      title: text.length > 50 ? `${text.substring(0, 47)}...` : text,
      uri: `pipertts:${text}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'pipertts'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  async getTrackUrl(track) {
    return {
      url: track.uri,
      protocol: 'piper',
      format: 'wav'
    }
  }

  async loadStream(decodedTrack, url, _protocol, _additionalData) {
    logger(
      'debug',
      'Sources',
      `Loading Piper TTS stream for "${decodedTrack.title}"`
    )

    let text = url.startsWith('pipertts:') ? url.slice(9) : url
    if (!text.toLowerCase().endsWith(' tts')) {
      text = `${text} tts`
    }

    const body = {
      text: text
    }

    if (this.config.voice) body.voice = this.config.voice
    if (this.config.speaker) body.speaker = this.config.speaker
    if (this.config.speaker_id) body.speaker_id = this.config.speaker_id
    if (this.config.length_scale) body.length_scale = this.config.length_scale
    if (this.config.noise_scale) body.noise_scale = this.config.noise_scale
    if (this.config.noise_w_scale)
      body.noise_w_scale = this.config.noise_w_scale

    try {
      const response = await makeRequest(this.config.url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json'
        },
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      if (response.statusCode !== 200) {
        throw new Error(`Piper TTS returned status ${response.statusCode}`)
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      response.stream.on('end', () => {
        stream.emit('finishBuffering')
      })

      response.stream.on('error', (err) => {
        logger('error', 'Sources', `Piper TTS stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.destroy(err)
        }
      })

      return { stream, type: 'wav' }
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Failed to load Piper TTS stream: ${err.message}`
      )
      return {
        exception: {
          message: err.message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }
}
