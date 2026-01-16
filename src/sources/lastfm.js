import { http1makeRequest, logger } from '../utils.js'

const LASTFM_PATTERN =
  /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music\/.+/
const YOUTUBE_LINK_PATTERN =
  /header-new-playlink[^>]*href="([^"]*youtube\.com[^"]+)"/
const YOUTUBE_URL_PATTERN =
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/
const SEARCH_PREFIX = 'lfsearch:'

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
    return LASTFM_PATTERN.test(link) || link.startsWith(SEARCH_PREFIX)
  }

  async search(query) {
    if (!query?.startsWith(SEARCH_PREFIX)) {
      return this._createException('Invalid search query format. Use lfsearch:query', 'common')
    }

    const searchQuery = query.substring(SEARCH_PREFIX.length).trim()
    if (!searchQuery) {
      return this._createException('Search query cannot be empty', 'common')
    }

    try {
      logger('debug', 'LastFM', `Searching for: ${searchQuery}`)
      const searchUrl = `https://www.last.fm/search/tracks?q=${encodeURIComponent(searchQuery)}`
      
      const { body, error, statusCode } = await http1makeRequest(searchUrl, { method: 'GET' })
      if (error || statusCode !== 200) {
        return this._createException(`Failed to search Last.fm: ${error?.message || statusCode}`, 'fault')
      }

      const trackUrl = this._extractFirstTrackUrl(body)
      if (!trackUrl) {
        return { loadType: 'empty', data: {} }
      }

      logger('debug', 'LastFM', `Found track URL: ${trackUrl}`)
      return await this.resolve(trackUrl)
    } catch (e) {
      logger('error', 'LastFM', `Search error: ${e.message}`)
      return this._createException(e.message, 'fault')
    }
  }

  async resolve(url) {
    if (url.startsWith(SEARCH_PREFIX)) {
      return await this.search(url)
    }

    if (!LASTFM_PATTERN.test(url)) {
      return { loadType: 'empty', data: {} }
    }

    const path = this._parsePath(url)
    if (!path) {
      return { loadType: 'empty', data: {} }
    }

    try {
      const { body, error, statusCode } = await http1makeRequest(url, { method: 'GET' })
      if (error || statusCode !== 200) {
        return this._createException(`Failed to fetch Last.fm page: ${error?.message || statusCode}`, 'fault')
      }

      const youtubeUrls = this._extractYouTubeUrls(body)
      if (!youtubeUrls.length) {
        return this._createException('No YouTube URLs found on Last.fm page', 'common')
      }

      const isTrack = path.includes('_') || path.length >= 4

      if (isTrack) {
        return await this._resolveTrack(url, path, youtubeUrls[0])
      } else {
        return await this._resolvePlaylist(url, path, youtubeUrls)
      }
    } catch (e) {
      return this._createException(e.message, 'fault')
    }
  }

  async _resolveTrack(lastfmUrl, path, youtubeUrl) {
    const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl)
    
    if (youtubeResult.loadType !== 'track') {
      return this._createException('Failed to resolve YouTube URL from Last.fm', 'fault')
    }

    const artist = decodeURIComponent(path[1]?.replace(/\+/g, ' ') || 'Unknown Artist')
    const trackName = decodeURIComponent(path[3]?.replace(/\+/g, ' ') || youtubeResult.data.info.title)

    return {
      loadType: 'track',
      data: {
        ...youtubeResult.data,
        info: {
          title: trackName,
          author: artist,
          length: youtubeResult.data.info.length,
          identifier: youtubeResult.data.info.identifier,
          isSeekable: youtubeResult.data.info.isSeekable,
          isStream: youtubeResult.data.info.isStream,
          uri: lastfmUrl,
          artworkUrl: youtubeResult.data.info.artworkUrl,
          isrc: youtubeResult.data.info.isrc,
          sourceName: 'lastfm'
        }
      }
    }
  }

  async _resolvePlaylist(lastfmUrl, path, youtubeUrls) {
    const tracks = []
    
    for (const youtubeUrl of youtubeUrls) {
      const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl)
      if (youtubeResult.loadType === 'track') {
        tracks.push({
          ...youtubeResult.data,
          info: {
            ...youtubeResult.data.info,
            uri: lastfmUrl,
            sourceName: 'lastfm'
          }
        })
      }
    }

    if (!tracks.length) {
      return this._createException('Failed to resolve YouTube URLs from Last.fm', 'fault')
    }

    const artist = decodeURIComponent(path[2]?.replace(/\+/g, ' ') || 'Unknown')
    const album = decodeURIComponent(path[3]?.replace(/\+/g, ' ') || path[1]?.replace(/\+/g, ' ') || 'Unknown')

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: `${album} - ${artist}`,
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  _parsePath(url) {
    try {
      const urlObj = new URL(url)
      let path = urlObj.pathname.split('/').filter(Boolean)
      
      // Remove language prefix if present
      if (path.length > 1 && path[0].length === 2 && path[1] === 'music') {
        path.shift()
      }
      
      return path[0] === 'music' && path.length >= 2 ? path : null
    } catch {
      return null
    }
  }

  _extractFirstTrackUrl(html) {
    // The pattern just checks for the: /music/Artist/_/Track
    const trackLinkPattern = /<a[^>]+href="(https?:\/\/(?:www\.)?last\.fm\/music\/[^"]+?\/_\/[^"]+?)"[^>]*>/i
    const match = html.match(trackLinkPattern)
    if (match) return match[1]

    // Just a fallback incase something fails.
    const musicLinkPattern = /<a[^>]+href="(https?:\/\/(?:www\.)?last\.fm\/music\/[^"]+?)"[^>]*>/i
    const musicMatch = html.match(musicLinkPattern)
    return musicMatch ? musicMatch[1] : null
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

  _createException(message, severity) {
    return {
      exception: { message, severity }
    }
  }

  async getTrackUrl(decodedTrack) {
    return this.nodelink.sources.getTrackUrl(decodedTrack)
  }

  async loadStream(track, url, protocol, additionalData) {
    return this.nodelink.sources.loadStream(track, url, protocol, additionalData)
  }
}
