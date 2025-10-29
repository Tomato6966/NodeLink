import { encodeTrack, logger, http1makeRequest } from '../utils.js'

export default class HttpSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = ['http']
    this.priority = 10
  }

  async setup() {
    return true
  }

  async search(query) {
    return this.resolve(query)
  }

  async resolve(url) {
    try {
      const data = await http1makeRequest(url, { method: 'HEAD' })
      if (data.error) {
        return {
          exception: { message: data.error.message, severity: 'common' }
        }
      }

      const headers = data.headers || {}
      const contentType = headers['content-type'] || ''

      const validAudioPrefixes = ['audio/', 'video/']
      const validApplicationTypes = ['application/octet-stream']

      const isValidMedia =
        validAudioPrefixes.some((prefix) => contentType.startsWith(prefix)) ||
        validApplicationTypes.includes(contentType) ||
        contentType === ''

      if (!isValidMedia) {
        return {
          exception: {
            message: `Unsupported content type: ${contentType}`,
            severity: 'common'
          }
        }
      }

      const isStream =
        Boolean(headers['icy-metaint']) || !('content-length' in headers)
      return {
        loadType: 'track',
        data: this.buildTrack(url, headers, isStream)
      }
    } catch (err) {
      return {
        exception: {
          message: `Failed to resolve URL: ${err.message}`,
          severity: 'common'
        }
      }
    }
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
      const response = await http1makeRequest(url, opts)
      if (response.error) throw response.error

      const contentType = response.headers?.['content-type'] || ''
      const httpStream = response.stream

      httpStream.on('end', () => {
        logger(
          'debug',
          'HTTP Source',
          `Stream ended for ${url}, emitting finishBuffering.`
        )
        httpStream.emit('finishBuffering')
      })

      httpStream.on('error', (err) => {
        logger('error', 'HTTP Source', `Stream error: ${err.message}`)
      })

      return { stream: httpStream, type: contentType }
    } catch (err) {
      logger('error', 'Sources', `Failed to load http stream: ${err.message}`)
      return { exception: { message: err.message, severity: 'common' } }
    }
  }
}
