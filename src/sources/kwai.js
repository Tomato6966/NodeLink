import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.js'

export default class KwaiSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?kwai\.com\/(?:@[\w-]+\/)?video\/(\d+)/
    ]
    this.priority = 60
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Kwai source.')
    return true
  }

  getVideoId(url) {
    if (!url) {
      throw new Error('Kwai URL not provided')
    }
    const match = url.match(/\/video\/(\d+)/)
    if (!match) {
      throw new Error('Kwai video ID not found')
    }
    return match[1]
  }

  decodeUnicodeEscapes(str) {
    if (!str) return null
    return str.replace(/\\u([\dA-Fa-f]{4})/g, (match, code) => {
      return String.fromCharCode(Number.parseInt(code, 16))
    })
  }

  async getVideoInfo(videoId) {
    const url = `https://www.kwai.com/video/${videoId}?responseType=json`
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
      Accept: '*/*'
    }

    try {
      const response = await makeRequest(url, { method: 'GET', headers })

      if (response.statusCode !== 200) {
        throw new Error(`Request failed with code ${response.statusCode}`)
      }

      const body = response.body

      if (!body) {
        throw new Error('Error fetching video info')
      }

      const urlMatch = body.match(/share_info:c,main_mv_urls:\s*\[(.*?)\]/)
      const kwaiIdMatch = body.match(/kwai_id\s*:\s*"([^"]+)"/)
      const durationMatch = body.match(/duration:\s*([\d]+)/)

      let thumbnailUrl = body.match(/poster="([^"]+)"/)?.[1]
      if (!thumbnailUrl) {
        const thumbnailMatch = body.match(
          /cover_thumbnail_urls:\[\{cdn:p,url:\s*"([^"]+)"/
        )
        thumbnailUrl = thumbnailMatch
          ? this.decodeUnicodeEscapes(thumbnailMatch[1])
          : null
      }

      if (!urlMatch) {
        throw new Error('Video URL not found in response')
      }

      const videoUrlMatch = urlMatch[1].match(/url:\s*"([^"]+)"/)

      if (!videoUrlMatch) {
        throw new Error('Could not extract video URL')
      }

      const videoInfo = {
        author: kwaiIdMatch ? kwaiIdMatch[1] : 'Unknown',
        title: kwaiIdMatch ? `Kwai - ${kwaiIdMatch[1]}` : 'Kwai Video',
        length: durationMatch
          ? Number.parseInt(durationMatch[1], 10) * 1000
          : null,
        thumbnail: thumbnailUrl,
        videoUrl: this.decodeUnicodeEscapes(videoUrlMatch[1])
      }

      return videoInfo
    } catch (error) {
      throw new Error(`Failed to fetch video info: ${error.message}`)
    }
  }

  async search(query) {
    throw {
      exception: {
        message: 'Search not supported for Kwai',
        severity: 'fault',
        cause: 'Kwai Source'
      }
    }
  }

  async resolve(queryUrl) {
    try {
      const videoId = this.getVideoId(queryUrl)
      const videoData = await this.getVideoInfo(videoId)

      const track = this.buildTrack(videoData, queryUrl, videoId)
      return { loadType: 'track', data: track }
    } catch (error) {
      return {
        exception: {
          message: error.message || 'Invalid Kwai URL',
          severity: 'fault',
          cause: 'Kwai Source'
        }
      }
    }
  }

  buildTrack(videoData, queryUrl, videoId) {
    const trackInfo = {
      identifier: videoId,
      title: videoData.title,
      author: videoData.author,
      length: videoData.length,
      sourceName: 'kwai',
      artworkUrl: videoData.thumbnail,
      uri: queryUrl,
      isStream: false,
      isSeekable: false,
      position: 0,
      isrc: null
    }
    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async getTrackUrl(track) {
    try {
      const videoData = await this.getVideoInfo(track.identifier)

      if (!videoData.videoUrl) {
        return {
          exception: {
            message: 'Video URL not found',
            severity: 'fault',
            cause: 'StreamLink'
          }
        }
      }

      return {
        url: videoData.videoUrl,
        protocol: videoData.videoUrl.startsWith('https:') ? 'https' : 'http',
        format: 'mp4'
      }
    } catch (error) {
      return {
        exception: {
          message: error.message || 'Failed to get video URL',
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      const options = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Accept: '*/*'
        },
        disableBodyCompression: true
      }

      const response = await http1makeRequest(url, options)

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }
      const stream = new PassThrough()

      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', (error) => {
        logger('error', 'Kwai', `Upstream stream error: ${error.message}`)
        stream.emit('error', error)
        stream.emit('finishBuffering')
      })

      return { stream: stream, type: 'mp4' }
    } catch (error) {
      throw {
        exception: {
          message: error.message || 'Failed to load stream',
          severity: 'fault',
          cause: 'Kwai Source'
        }
      }
    }
  }
}
