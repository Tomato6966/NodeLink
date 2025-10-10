import { encodeTrack, logger, makeRequest } from '../utils.js'

export default class HttpSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = ['http']
  }

  async setup() {
    return true
  }

  async search(query) {
    return this.resolve(query)
  }

  async resolve(url) {
    const data = await makeRequest(url, { method: 'HEAD' })
    if (data.error) {
      return {
        loadType: 'error',
        data: { message: data.error.message, severity: 'common' }
      }
    }

    const headers = data.headers || {}
    if (!headers['content-type']?.startsWith('audio/')) {
      return {
        loadType: 'error',
        data: { message: 'Not an audio file', severity: 'common' }
      }
    }

    const isStream =
      Boolean(headers['icy-metaint']) || !('content-length' in headers)
    return { loadType: 'track', data: this.buildTrack(url, headers, isStream) }
  }

  buildTrack(url, headers, isStream) {
    const title = headers['icy-name'] || 'Unknown'
    const description = headers['icy-description'] || ''
    const genre = headers['icy-genre'] || ''
    const stationUrl = headers['icy-url'] || url
    const icyBr = headers['icy-br']
    const audioInfo = headers['ice-audio-info']
    const bitrate = Number.parseInt(
      icyBr || audioInfo?.split(';')?.[0]?.split('=')?.[1] || 0,
      10
    )

    const track = {
      identifier: url,
      isSeekable: !isStream,
      author: description || 'unknown',
      length: -1,
      isStream,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'http'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {
        bitrate,
        genre,
        stationUrl,
        icyBr,
        audioInfo
      }
    }
  }

  getTrackUrl(info) {
    return { url: info.uri, protocol: 'http' }
  }

  async loadStream(decodedTrack, url) {
    try {
      const opts = {
        method: 'GET',
        streamOnly: true
      }
      const response = await makeRequest(url, opts)
      if (response.error) throw response.error

      const contentType = response.headers?.['content-type']
      const httpStream = response.stream

      httpStream.on('end', () => {
        logger('debug', 'HTTP Source', `Stream ended for ${url}, emitting finishBuffering.`)
        httpStream.emit('finishBuffering')
      })

      return { stream: httpStream, type: contentType }
    } catch (err) {
      logger('error', 'Sources', `Failed to load http stream: ${err.message}`)
      return { exception: { message: err.message, severity: 'common' } }
    }
  }
}
