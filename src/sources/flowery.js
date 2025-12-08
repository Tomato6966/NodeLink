import { PassThrough } from 'node:stream'
import { URL } from 'node:url'
import { encodeTrack, logger, makeRequest } from '../utils.js'

export default class FlowerySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = this.nodelink.options.sources?.flowery || {}
    this.searchTerms = ['ftts', 'flowery']
    this.patterns = [/^ftts:\/\//]
    this.priority = 50
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Flowery TTS source.')
    return true
  }

  async search(query) {
    if (!query) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const url = this._buildUrl(query)
      const track = this.buildTrack({
        title: query.length > 50 ? `${query.substring(0, 47)}...` : query,
        author: 'Flowery TTS',
        uri: url,
        identifier: `ftts:${query}`
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

  async resolve(url) {
    try {
      let text = ''
      let params = {}

      if (url.startsWith('ftts://')) {
        const pathAndQuery = url.slice(7)
        const splitIdx = pathAndQuery.indexOf('?')
        
        if (splitIdx !== -1) {
          text = decodeURIComponent(pathAndQuery.substring(0, splitIdx))
          const queryStr = pathAndQuery.substring(splitIdx + 1)
          const searchParams = new URLSearchParams(queryStr)
          for (const [key, value] of searchParams) {
            params[key] = value
          }
        } else {
          text = decodeURIComponent(pathAndQuery)
        }
      } else {
        text = url
      }

      if (!text) return { loadType: 'empty', data: {} }

      const apiUrl = this._buildUrl(text, params)
      
      const track = this.buildTrack({
        title: text.length > 50 ? `${text.substring(0, 47)}...` : text,
        author: 'Flowery TTS',
        uri: apiUrl,
        identifier: url
      })

      return { loadType: 'track', data: track }

    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  _buildUrl(text, overrides = {}) {
    const config = this.config
    const enforceConfig = config.enforceConfig || false

    let voice = config.voice || 'Salli'
    let translate = config.translate || false
    let silence = config.silence || 0
    let speed = config.speed || 1.0

    if (!enforceConfig) {
      if (overrides.voice) voice = overrides.voice
      if (overrides.translate !== undefined) translate = overrides.translate
      if (overrides.silence !== undefined) silence = overrides.silence
      if (overrides.speed !== undefined) speed = overrides.speed
    }

    let audioFormat = 'mp3'
    const quality = this.nodelink.options.audio?.quality || 'high'
    
    switch (quality) {
      case 'high': audioFormat = 'wav'; break
      case 'medium': audioFormat = 'flac'; break
      case 'low': audioFormat = 'ogg_opus'; break
      case 'lowest': audioFormat = 'mp3'; break
      default: audioFormat = 'wav'; break
    }

    const baseUrl = 'https://api.flowery.pw/v1/tts'
    const queryParams = new URLSearchParams({
      voice,
      text,
      translate: String(translate),
      silence: String(silence),
      audio_format: audioFormat,
      speed: String(speed)
    })

    return `${baseUrl}?${queryParams.toString()}`
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
      sourceName: 'flowery'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  async getTrackUrl(track) {
    let format = 'mp3'
    try {
      const urlObj = new URL(track.uri)
      const audioFormat = urlObj.searchParams.get('audio_format')
      if (audioFormat) {
        if (audioFormat === 'wav') format = 'wav'
        else if (audioFormat === 'flac') format = 'flac'
        else if (audioFormat === 'ogg_opus') format = 'opus'
        else if (audioFormat === 'mp3') format = 'mp3'
      }
    } catch (e) {
      // ignore
    }

    return {
      url: track.uri,
      protocol: 'https',
      format
    }
  }

  async loadStream(decodedTrack, url) {
    logger(
      'debug',
      'Sources',
      `Loading Flowery TTS stream for "${decodedTrack.title}"`
    )
    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': 'NodeLink/FloweryTTS'
        }
      })

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      response.stream.on('end', () => {
        stream.emit('finishBuffering')
      })

      response.stream.on('error', (err) => {
        logger('error', 'Sources', `Flowery TTS stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.destroy(err)
        }
      })

      return { stream }
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Failed to load Flowery TTS stream: ${err.message}`
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
