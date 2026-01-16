/*
* Credits: https://github.com/southctrl; adapted for NodeLink
I added support for lfsearch:query in this file. you're welcome <3
*/

import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js'

const LASTFM_PATTERN =
  /^https?:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?music\/.+/
const YOUTUBE_LINK_PATTERN =
  /header-new-playlink[^>]*href="([^"]*youtube\.com[^"]+)"/
const YOUTUBE_URL_PATTERN =
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[a-zA-Z0-9_-]+/

export default class LastFMSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.lastfm || {}
    this.patterns = [LASTFM_PATTERN]
    this.priority = 40
    this.searchTerms = ['lfsearch']
    this.maxSearchResults = nodelink.options.maxSearchResults || 10
    this.apiKey = this.config.apiKey || null
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Last.fm source.')
    return true
  }

  isLinkMatch(link) {
    return LASTFM_PATTERN.test(link)
  }

  async search(query, _sourceTerm, searchType = 'track') {
    try {
      if (!this.apiKey) {
        if (searchType !== 'track') {
          return {
            exception: {
              message:
                'Last.fm API key required for album/artist search. Configure sources.lastfm.apiKey.',
              severity: 'common'
            }
          }
        }
        return await this._searchTracksHtml(query)
      }

      return await this._searchApi(query, searchType)
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
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
    try {
      const youtubeUrl = decodedTrack?.pluginInfo?.youtubeUrl
      if (youtubeUrl) {
        const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl)
        if (youtubeResult?.loadType === 'track') {
          const streamInfo = await this.nodelink.sources.getTrackUrl(
            youtubeResult.data.info
          )
          return { newTrack: youtubeResult.data, ...streamInfo }
        }
      }

      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      let searchResult = await this.nodelink.sources.search(
        'youtube',
        query,
        'ytmsearch'
      )

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return {
          exception: {
            message: 'No matching track found on default source.',
            severity: 'common'
          }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)
      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative found after filtering.',
            severity: 'common'
          }
        }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _searchApi(query, searchType) {
    const typeMap = {
      track: { method: 'track.search', param: 'track' },
      album: { method: 'album.search', param: 'album' },
      artist: { method: 'artist.search', param: 'artist' }
    }
    const selected = typeMap[searchType] || typeMap.track

    const url =
      `https://ws.audioscrobbler.com/2.0/?method=${selected.method}` +
      `&${selected.param}=${encodeURIComponent(query)}` +
      `&limit=${this.maxSearchResults}&api_key=${this.apiKey}&format=json`

    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Last.fm API error: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    if (body?.error) {
      return {
        exception: { message: body.message || 'Last.fm API error', severity: 'fault' }
      }
    }

    const results = this._mapApiResults(body, searchType)
    return results.length
      ? { loadType: 'search', data: results }
      : { loadType: 'empty', data: {} }
  }

  _mapApiResults(body, searchType) {
    if (searchType === 'album') {
      const albums = body?.results?.albummatches?.album || []
      const list = Array.isArray(albums) ? albums : [albums]
      return list
        .filter((item) => item?.name && item?.artist)
        .map((item) => this._buildCollectionResult(item.name, item.artist, item.url, 'album'))
    }

    if (searchType === 'artist') {
      const artists = body?.results?.artistmatches?.artist || []
      const list = Array.isArray(artists) ? artists : [artists]
      return list
        .filter((item) => item?.name)
        .map((item) => this._buildCollectionResult(item.name, 'Last.fm', item.url, 'artist'))
    }

    const tracks = body?.results?.trackmatches?.track || []
    const list = Array.isArray(tracks) ? tracks : [tracks]
    return list
      .filter((item) => item?.name && item?.artist)
      .map((item) => this._buildTrackResult(item.name, item.artist, item.url))
  }

  async _searchTracksHtml(query) {
    const url = `https://www.last.fm/search/tracks?q=${encodeURIComponent(query)}`
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'GET'
    })

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Failed to fetch Last.fm search page: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const results = this._parseTrackSearchHtml(body)
    return results.length
      ? { loadType: 'search', data: results.slice(0, this.maxSearchResults) }
      : { loadType: 'empty', data: {} }
  }

  _parseTrackSearchHtml(html) {
    const results = []
    const regex =
      /data-youtube-url="([^"]+)"[\s\S]*?data-track-name="([^"]+)"[\s\S]*?data-track-url="([^"]+)"[\s\S]*?data-artist-name="([^"]+)"/g

    let match
    while ((match = regex.exec(html)) !== null) {
      const youtubeUrl = this._decodeHtml(match[1])
      const title = this._decodeHtml(match[2])
      const trackUrl = this._decodeHtml(match[3])
      const artist = this._decodeHtml(match[4])
      const fullUrl = trackUrl.startsWith('http')
        ? trackUrl
        : `https://www.last.fm${trackUrl}`

      results.push(
        this._buildTrackResult(title, artist, fullUrl, {
          youtubeUrl
        })
      )
    }

    return results
  }

  _buildTrackResult(title, artist, url, pluginInfo = {}) {
    const info = {
      identifier: url || `${artist} - ${title}`,
      isSeekable: true,
      author: artist,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lastfm'
    }

    return { encoded: encodeTrack(info), info, pluginInfo }
  }

  _buildCollectionResult(title, author, url, type) {
    const info = {
      identifier: url || title,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lastfm'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: { type } }
  }

  _decodeHtml(text) {
    if (!text) return text
    return text
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
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
