import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest } from '../utils.js'

export default class GoogleTTSSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.language =
      this.nodelink.options.sources?.googleTts?.language || 'en-US'
    this.searchTerms = ['gtts']
    this.baseUrl = 'https://translate.google.com'
    this.priority = 50
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Google TTS source.')
    return true
  }

  async search(query) {
    const text = query
    if (!text) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const url = this._buildUrl(text)
      const track = this.buildTrack({
        title: `TTS: ${text.length > 50 ? `${text.substring(0, 47)}...` : text}`,
        author: 'Google TTS',
        uri: url,
        identifier: `gtts:${text}`
      })

      return {
        loadType: 'track',
        data: track
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  async resolve(query) {
    return this.search(query)
  }

  _buildUrl(text) {
    const encodedText = encodeURIComponent(text)
    return `${this.baseUrl}/translate_tts?ie=UTF-8&q=${encodedText}&tl=${this.language}&total=1&idx=0&textlen=${text.length}&client=gtx`
  }

  buildTrack(partialInfo) {
    const track = {
      identifier: partialInfo.identifier,
      isSeekable: false,
      author: partialInfo.author,
      length: -1,
      isStream: true,
      position: 0,
      title: partialInfo.title,
      uri: partialInfo.uri,
      artworkUrl: null,
      isrc: null,
      sourceName: 'google-tts'
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
      protocol: 'https',
      format: 'mp3'
    }
  }

  async loadStream(decodedTrack, url) {
    logger(
      'debug',
      'Sources',
      `Loading Google TTS stream for "${decodedTrack.title}"`
    )
    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        }
      })

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()
      response.stream.on('data', (chunk) => {
        stream.write(chunk)
      })

      response.stream.on('end', () => {
        stream.emit('finishBuffering')
      })

      response.stream.on('error', (err) => {
        logger('error', 'Sources', `Google TTS stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.destroy(err)
        }
      })

      return { stream }
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Failed to load Google TTS stream: ${err.message}`
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
