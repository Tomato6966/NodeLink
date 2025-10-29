import { http1makeRequest, logger } from '../utils.js'

const LASTFM_PATTERN =
  /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music\/.+/
const YOUTUBE_LINK_PATTERN =
  /header-new-playlink[^>]*href="([^"]*youtube\.com[^"]+)"/
const YOUTUBE_URL_PATTERN =
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/

export default class LastFMSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [LASTFM_PATTERN]
    this.priority = 40
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Last.fm source.')
    return true
  }

  isLinkMatch(link) {
    return LASTFM_PATTERN.test(link)
  }

  async search() {
    return {
      exception: {
        message: 'Search not supported for Last.fm',
        severity: 'common'
      }
    }
  }

  async resolve(url) {
    if (!LASTFM_PATTERN.test(url)) {
      return { loadType: 'empty', data: {} }
    }

    const path = this._parsePath(url)
    if (!path) return { loadType: 'empty', data: {} }

    try {
      const { body, error, statusCode } = await http1makeRequest(url, {
        method: 'GET'
      })

      if (error || statusCode !== 200) {
        return {
          exception: {
            message: `Failed to fetch Last.fm page: ${error?.message || statusCode}`,
            severity: 'fault'
          }
        }
      }

      const youtubeUrls = this._extractYouTubeUrls(body)
      if (!youtubeUrls.length) {
        return {
          exception: {
            message: 'No YouTube URLs found on Last.fm page',
            severity: 'common'
          }
        }
      }

      // Check if it's a track URL (contains '_' separator or has 4+ segments)
      const isTrack = path.includes('_') || path.length >= 4

      if (isTrack) {
        const youtubeResult = await this.nodelink.sources.resolve(
          youtubeUrls[0]
        )
        if (youtubeResult.loadType === 'track') {
          return {
            loadType: 'track',
            data: {
              ...youtubeResult.data,
              info: {
                ...youtubeResult.data.info,
                uri: url,
                sourceName: 'lastfm'
              }
            }
          }
        }
      } else {
        const tracks = []
        for (const youtubeUrl of youtubeUrls) {
          const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl)
          if (youtubeResult.loadType === 'track') {
            tracks.push({
              ...youtubeResult.data,
              info: {
                ...youtubeResult.data.info,
                uri: url,
                sourceName: 'lastfm'
              }
            })
          }
        }

        if (tracks.length) {
          const artist = decodeURIComponent(
            path[2]?.replace(/\+/g, ' ') || 'Unknown'
          )
          const album = decodeURIComponent(
            path[3]?.replace(/\+/g, ' ') ||
              path[1]?.replace(/\+/g, ' ') ||
              'Unknown'
          )
          return {
            loadType: 'playlist',
            data: {
              info: { name: `${album} - ${artist}`, selectedTrack: 0 },
              pluginInfo: {},
              tracks
            }
          }
        }
      }

      return {
        exception: {
          message: 'Failed to resolve YouTube URLs from Last.fm',
          severity: 'fault'
        }
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  _parsePath(url) {
    try {
      const urlObj = new URL(url)
      const path = urlObj.pathname.split('/').filter(Boolean)
      if (path.length > 1 && path[0].length === 2 && path[1] === 'music') {
        path.shift()
      }
      return path[0] === 'music' && path.length >= 2 ? path : null
    } catch {
      return null
    }
  }

  _extractYouTubeUrl(html) {
    const playLinkMatch = html.match(YOUTUBE_LINK_PATTERN)
    if (playLinkMatch) return playLinkMatch[1]

    const youtubeMatch = html.match(YOUTUBE_URL_PATTERN)
    return youtubeMatch ? youtubeMatch[0] : null
  }

  _extractYouTubeUrls(html) {
    const urls = new Set()

    const playMatch = html.match(YOUTUBE_LINK_PATTERN)
    if (playMatch) urls.add(playMatch[1])

    const regex = new RegExp(YOUTUBE_URL_PATTERN, 'g')
    let match
    while ((match = regex.exec(html)) !== null) {
      urls.add(match[0])
    }

    return Array.from(urls)
  }

  _createError(message, severity) {
    return {
      loadType: 'error',
      data: { message, severity }
    }
  }

  async getTrackUrl(decodedTrack) {
    return this.nodelink.sources.getTrackUrl(decodedTrack)
  }

  async loadStream(track, url, protocol, additionalData) {
    return this.nodelink.sources.loadStream(
      track,
      url,
      protocol,
      additionalData
    )
  }
}
