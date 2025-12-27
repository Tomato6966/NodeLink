import { encodeTrack, http1makeRequest, logger, getBestMatch } from '../utils.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const API_BASE = 'https://api.music.apple.com/v1'
const MAX_PAGE_ITEMS = 300
const BATCH_SIZE_DEFAULT = 5
const CACHE_VALIDITY_DAYS = 7

export default class AppleMusicSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['amsearch']

    this.patterns = [
      /https?:\/\/(?:www\.)?music\.apple\.com\/(?:[a-zA-Z]{2}\/)?(album|playlist|artist|song)\/[^/]+\/([a-zA-Z0-9\-.]+)(?:\?i=(\d+))?/
    ]

    this.priority = 95

    this.mediaApiToken = null
    this.tokenOrigin = null
    this.tokenExpiry = null
    this.country = 'US'

    this.playlistPageLimit = 0
    this.albumPageLimit = 0
    this.playlistPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.albumPageLoadConcurrency = BATCH_SIZE_DEFAULT

    this.allowExplicit = true

    this.tokenInitialized = false
    this.settingUp = false
    this.tokenCachePath = path.join(
      process.cwd(),
      '.cache',
      'applemusic_token.json'
    )
  }

  async setup() {
    if (this.settingUp) return true
    this.settingUp = true

    try {
      const appleMusicConfig = this.config.sources?.applemusic || {}
      this.country = appleMusicConfig.market || 'US'
      this.playlistPageLimit = appleMusicConfig.playlistLoadLimit ?? 0
      this.albumPageLimit = appleMusicConfig.albumLoadLimit ?? 0
      this.playlistPageLoadConcurrency =
        appleMusicConfig.playlistPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
      this.albumPageLoadConcurrency =
        appleMusicConfig.albumPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
      this.allowExplicit = appleMusicConfig.allowExplicit ?? true

      if (this.tokenInitialized && this._isTokenValid()) {
        return true
      }

      const cachedToken = this.nodelink.credentialManager.get('apple_media_api_token')
      if (cachedToken) {
        this.mediaApiToken = cachedToken
        this._parseToken(this.mediaApiToken)
        if (this._isTokenValid()) {
          logger('info', 'AppleMusic', 'Loaded valid token from CredentialManager.')
          this.tokenInitialized = true
          return true
        }
      }

      const configToken = appleMusicConfig.mediaApiToken
      if (configToken && configToken !== 'token_here') {
        this.mediaApiToken = configToken
        this._parseToken(this.mediaApiToken)
        if (this._isTokenValid()) {
          logger('info', 'AppleMusic', 'Loaded valid token from config file.')
          this.nodelink.credentialManager.set('apple_media_api_token', this.mediaApiToken, this.tokenExpiry - Date.now())
          this.tokenInitialized = true
          return true
        }
      }

      const oldToken = this.mediaApiToken
      const newToken = await this._fetchNewToken()
      if (newToken) {
        if (oldToken && newToken === oldToken) {
          logger(
            'warn',
            'AppleMusic',
            'Fetched a new token, but it is the same as the old one. The token might be long-lived or the fetching method needs an update.'
          )
        }
        this.mediaApiToken = newToken
        this._parseToken(this.mediaApiToken)
        this.nodelink.credentialManager.set('apple_media_api_token', this.mediaApiToken, this.tokenExpiry - Date.now())
        this.tokenInitialized = true
        return true
      }

      logger(
        'warn',
        'AppleMusic',
        'Failed to obtain a valid Media API token. Source will be disabled for this session.'
      )
      this.tokenInitialized = false
      return false
    } catch (error) {
      logger(
        'error',
        'AppleMusic',
        `Critical error during setup: ${error.message}`
      )
      return false
    } finally {
      this.settingUp = false
    }
  }

  async _fetchNewToken() {
    try {
      logger(
        'info',
        'AppleMusic',
        'Attempting to fetch a new Media API token...'
      )
      const { body: html, statusCode } = await http1makeRequest(
        'https://music.apple.com/us/browse'
      )
      if (statusCode !== 200) {
        throw new Error(`Failed to fetch HTML: ${statusCode}`)
      }

      const scriptTagMatch = html.match(
        /<script\s+type="module"\s+crossorigin\s+src="([^"]+)"/
      )
      const scriptTag = scriptTagMatch && scriptTagMatch[1]

      if (!scriptTag) {
        throw new Error('Module script tag not found in Apple Music HTML.')
      }

      const scriptUrl = `https://music.apple.com${scriptTag}`
      const { body: jsData, statusCode: jsStatus } =
        await http1makeRequest(scriptUrl)
      if (jsStatus !== 200) {
        throw new Error(`Failed to fetch JS from ${scriptUrl}: ${jsStatus}`)
      }

      const tokenMatch = jsData.match(
        /(?<token>(ey[\w-]+)\.([\w-]+)\.([\w-]+))/
      )
      const accessToken = tokenMatch?.groups?.token

      if (accessToken) {
        logger(
          'info',
          'AppleMusic',
          'Successfully fetched a new Media API token.'
        )
        return accessToken
      } else {
        throw new Error('Access token not found in JS file.')
      }
    } catch (error) {
      logger(
        'error',
        'AppleMusic',
        `Failed to fetch new token: ${error.message}`
      )
      return null
    }
  }

  _isTokenValid() {
    if (!this.tokenExpiry) return true
    return Date.now() < this.tokenExpiry - 10000
  }

  _parseToken(token) {
    try {
      const parts = token.split('.')
      if (parts.length < 2) return

      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
      const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))

      this.tokenOrigin = json.root_https_origin || null
      this.tokenExpiry = json.exp ? json.exp * 1000 : null
    } catch {
      this.tokenOrigin = null
      this.tokenExpiry = null
    }
  }

  async _apiRequest(path) {
    if (!this.tokenInitialized || !this._isTokenValid()) {
      const ok = await this.setup()
      if (!ok) throw new Error('AppleMusic token unavailable')
    }

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: {
          Authorization: `Bearer ${this.mediaApiToken}`,
          Accept: 'application/json',
          Origin: this.tokenOrigin ? `https://${this.tokenOrigin}` : undefined
        }
      })

      if (statusCode === 401) {
        this.tokenInitialized = false
        await this.setup()
        return this._apiRequest(path)
      }

      if (statusCode < 200 || statusCode >= 300) {
        logger('error', 'AppleMusic', `API error ${statusCode} for ${url}`)
        return null
      }

      return body
    } catch (error) {
      logger('error', 'AppleMusic', `apiRequest error: ${error.message}`)
      return null
    }
  }

  _buildTrack(item, artworkOverride = null) {
    if (!item?.id) return null

    const attributes = item.attributes || {}
    const artwork = artworkOverride || this._parseArtwork(attributes.artwork)
    const isExplicit = attributes.contentRating === 'explicit'
    let trackUri = attributes.url || ''
    if (trackUri) {
      trackUri +=
        (trackUri.includes('?') ? '&' : '?') + `explicit=${isExplicit}`
    }

    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: attributes.artistName || 'Unknown',
      length: attributes.durationInMillis ?? 0,
      isStream: false,
      position: 0,
      title: attributes.name || 'Unknown',
      uri: trackUri,
      artworkUrl: artwork,
      isrc: attributes.isrc || null,
      sourceName: 'applemusic'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  _parseArtwork(artworkData) {
    if (!artworkData?.url) return null
    return artworkData.url
      .replace('{w}', artworkData.width)
      .replace('{h}', artworkData.height)
  }

  async search(query) {
    try {
      const limit = this.config.maxSearchResults || 10
      const encodedQuery = encodeURIComponent(query)
      const data = await this._apiRequest(
        `/catalog/${this.country}/search?term=${encodedQuery}&limit=${limit}&types=songs&extend=artistUrl`
      )

      const songs = data?.results?.songs?.data || []
      if (!songs.length) return { loadType: 'empty', data: {} }

      const tracks = songs.map((item) => this._buildTrack(item)).filter(Boolean)
      return { loadType: 'search', data: tracks }
    } catch (error) {
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const urlMatch = this.patterns[0].exec(url)
      if (!urlMatch) return { loadType: 'empty', data: {} }

      const type = urlMatch[1]
      const id = urlMatch[2]
      const altTrackId = urlMatch[3]

      switch (type) {
        case 'song':
          return await this._resolveTrack(id)

        case 'album':
          return altTrackId
            ? await this._resolveTrack(altTrackId)
            : await this._resolveAlbum(id)

        case 'playlist':
          return await this._resolvePlaylist(id)

        case 'artist':
          return await this._resolveArtist(id)
      }
    } catch (error) {
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async _resolveTrack(id) {
    const data = await this._apiRequest(
      `/catalog/${this.country}/songs/${id}?extend=artistUrl`
    )
    if (!data?.data?.[0]) {
      return { exception: { message: 'Track not found.', severity: 'common' } }
    }

    return { loadType: 'track', data: this._buildTrack(data.data[0]) }
  }

  async _resolveAlbum(id) {
    const albumData = await this._apiRequest(
      `/catalog/${this.country}/albums/${id}?extend=artistUrl`
    )
    if (!albumData?.data?.[0]) {
      return { exception: { message: 'Album not found.', severity: 'common' } }
    }

    const album = albumData.data[0]
    const baseTracks = album.relationships?.tracks?.data || []

    const total = album.relationships?.tracks?.meta?.total || baseTracks.length
    const extra = await this._paginate(
      `/catalog/${this.country}/albums/${id}/tracks`,
      total,
      this.albumPageLimit
    )

    const all = [...baseTracks, ...extra]

    const artwork = this._parseArtwork(album.attributes?.artwork)

    const tracks = all
      .map((item) =>
        this._buildTrack(
          {
            id: item.id,
            attributes: {
              ...item.attributes,
              artwork: album.attributes.artwork
            }
          },
          artwork
        )
      )
      .filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: album.attributes.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    const playlistResponse = await this._apiRequest(
      `/catalog/${this.country}/playlists/${id}`
    )
    if (!playlistResponse?.data?.[0]) {
      return {
        exception: { message: 'Playlist not found.', severity: 'common' }
      }
    }

    const playlist = playlistResponse.data[0]
    const baseTracks = playlist.relationships?.tracks?.data || []

    const total =
      playlist.relationships?.tracks?.meta?.total || baseTracks.length
    const extra = await this._paginate(
      `/catalog/${this.country}/playlists/${id}/tracks?extend=artistUrl`,
      total,
      this.playlistPageLimit
    )

    const all = [...baseTracks, ...extra]

    const artwork = this._parseArtwork(playlist.attributes.artwork)

    const tracks = all
      .map((item) => this._buildTrack(item, artwork))
      .filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlist.attributes.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveArtist(id) {
    const topTracksData = await this._apiRequest(
      `/catalog/${this.country}/artists/${id}/view/top-songs`
    )
    if (!topTracksData?.data) {
      return { exception: { message: 'Artist not found.', severity: 'common' } }
    }

    const artistInfo = await this._apiRequest(
      `/catalog/${this.country}/artists/${id}`
    )
    const artist = artistInfo?.data?.[0]?.attributes?.name || 'Artist'
    const artwork = this._parseArtwork(
      artistInfo?.data?.[0]?.attributes?.artwork
    )

    const tracks = topTracksData.data
      .map((trackData) => this._buildTrack(trackData, artwork))
      .filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: `${artist}'s Top Tracks`, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _paginate(basePath, totalItems, maxPages) {
    const results = []
    const pages = Math.ceil(totalItems / MAX_PAGE_ITEMS)

    let allowed = pages
    if (maxPages > 0) allowed = Math.min(pages, maxPages)

    const promises = []
    for (let index = 1; index < allowed; index++) {
      const offset = index * MAX_PAGE_ITEMS
      const path = `${basePath}${basePath.includes('?') ? '&' : '?'}limit=${MAX_PAGE_ITEMS}&offset=${offset}`
      promises.push(this._apiRequest(path))
    }

    if (promises.length === 0) return results

    const batchSize = this.playlistPageLoadConcurrency
    for (let i = 0; i < promises.length; i += batchSize) {
      const batch = promises.slice(i, i + batchSize)
      try {
        const pageResults = await Promise.all(batch)
        for (const page of pageResults) {
          if (page?.data) results.push(...page.data)
        }
      } catch (e) {
        logger('warn', 'AppleMusic', `Failed to fetch a batch of pages: ${e.message}`)
      }
    }

    return results
  }

  async getTrackUrl(decodedTrack) {
    let isExplicit = false
    if (decodedTrack.uri) {
      try {
        const url = new URL(decodedTrack.uri)
        isExplicit = url.searchParams.get('explicit') === 'true'
      } catch (error) {
        // Ignore malformed URI
      }
    }

    const query = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
      let searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch')
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return {
          exception: { message: 'No alternative found.', severity: 'fault' }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

      if (!bestMatch) {
        return {
          exception: { message: 'No suitable match.', severity: 'fault' }
        }
      }

      const stream = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...stream }
    } catch (error) {
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  _buildSearchQuery(track, isExplicit) {
    let searchQuery = `${track.title} ${track.author}`
    if (isExplicit) {
      searchQuery += this.allowExplicit ? ' official video' : ' clean version'
    }
    return searchQuery
  }
}
