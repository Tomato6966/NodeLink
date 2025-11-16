import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const API_BASE = 'https://api.music.apple.com/v1'
const MAX_PAGE_ITEMS = 300
const DURATION_TOLERANCE = 0.15
const BATCH_SIZE_DEFAULT = 5

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
  }

  async setup() {
    if (this.tokenInitialized && this._isTokenValid()) return true

    if (this.settingUp) return true
    this.settingUp = true

    try {
      const appleMusicConfig = this.config.sources?.applemusic
      if (!appleMusicConfig) {
        logger('error', 'AppleMusic', 'Missing config.sources.applemusic')
        return false
      }

      this.mediaApiToken = appleMusicConfig.mediaApiToken
      this.country = appleMusicConfig.market || 'US'

      this.playlistPageLimit = appleMusicConfig.playlistLoadLimit ?? 0
      this.albumPageLimit = appleMusicConfig.albumLoadLimit ?? 0
      this.playlistPageLoadConcurrency = appleMusicConfig.playlistPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
      this.albumPageLoadConcurrency = appleMusicConfig.albumPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
      this.allowExplicit = appleMusicConfig.allowExplicit ?? true

      if (!this.mediaApiToken) {
        logger('error', 'AppleMusic', 'mediaApiToken missing')
        return false
      }

      this._parseToken(this.mediaApiToken)

      if (this.tokenExpiry && !this._isTokenValid()) {
        logger(
          'error',
          'AppleMusic',
          `Token expired (expiresAt: ${new Date(this.tokenExpiry).toISOString()}).`
        )
        this.tokenInitialized = false
        return false
      }

      this.tokenInitialized = true

      logger(
        'info',
        'AppleMusic',
        `Token initialized (origin: ${this.tokenOrigin || 'none'}, expiresAt: ${this.tokenExpiry ? new Date(this.tokenExpiry).toISOString() : 'none'
        })`
      )

      return true
    } catch (error) {
      logger('error', 'AppleMusic', `setup() error: ${error.message}`)
      return false
    } finally {
      this.settingUp = false
    }
  }

  _isTokenValid() {
    if (!this.tokenExpiry) return true
    return Date.now() < (this.tokenExpiry - 10000)
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
      trackUri += `?explicit=${isExplicit}`
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
    return artworkData.url.replace('{w}', artworkData.width).replace('{h}', artworkData.height)
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

      const tracks = songs.map(item => this._buildTrack(item)).filter(Boolean)
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
          return altTrackId ? await this._resolveTrack(altTrackId) : await this._resolveAlbum(id)

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
    const data = await this._apiRequest(`/catalog/${this.country}/songs/${id}?extend=artistUrl`)
    if (!data?.data?.[0]) {
      return { exception: { message: 'Track not found.', severity: 'common' } }
    }

    return { loadType: 'track', data: this._buildTrack(data.data[0]) }
  }

  async _resolveAlbum(id) {
    const albumData = await this._apiRequest(`/catalog/${this.country}/albums/${id}?extend=artistUrl`)
    if (!albumData?.data?.[0]) {
      return { exception: { message: 'Album not found.', severity: 'common' } }
    }

    const album = albumData.data[0]
    const baseTracks = album.relationships?.tracks?.data || []

    const total = album.relationships?.tracks?.meta?.total || baseTracks.length
    const extra = await this._paginate(`/catalog/${this.country}/albums/${id}/tracks`, total, this.albumPageLimit)

    const all = [...baseTracks, ...extra]

    const artwork = this._parseArtwork(album.attributes?.artwork)

    const tracks = all.map(item => this._buildTrack(
      { id: item.id, attributes: { ...item.attributes, artwork: album.attributes.artwork } },
      artwork
    )).filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: album.attributes.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    const playlistResponse = await this._apiRequest(`/catalog/${this.country}/playlists/${id}`)
    if (!playlistResponse?.data?.[0]) {
      return { exception: { message: 'Playlist not found.', severity: 'common' } }
    }

    const playlist = playlistResponse.data[0]
    const baseTracks = playlist.relationships?.tracks?.data || []

    const total = playlist.relationships?.tracks?.meta?.total || baseTracks.length
    const extra = await this._paginate(
      `/catalog/${this.country}/playlists/${id}/tracks?extend=artistUrl`,
      total,
      this.playlistPageLimit
    )

    const all = [...baseTracks, ...extra]

    const artwork = this._parseArtwork(playlist.attributes.artwork)

    const tracks = all.map(item => this._buildTrack(item, artwork)).filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlist.attributes.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveArtist(id) {
    const topTracksData = await this._apiRequest(`/catalog/${this.country}/artists/${id}/view/top-songs`)
    if (!topTracksData?.data) {
      return { exception: { message: 'Artist not found.', severity: 'common' } }
    }

    const artistInfo = await this._apiRequest(`/catalog/${this.country}/artists/${id}`)
    const artist = artistInfo?.data?.[0]?.attributes?.name || 'Artist'
    const artwork = this._parseArtwork(artistInfo?.data?.[0]?.attributes?.artwork)

    const tracks = topTracksData.data.map(trackData => this._buildTrack(trackData, artwork)).filter(Boolean)

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

    for (let index = 1; index < allowed; index++) {
      const offset = index * MAX_PAGE_ITEMS
      const path =
        `${basePath}${basePath.includes('?') ? '&' : '?'}limit=${MAX_PAGE_ITEMS}&offset=${offset}`

      const page = await this._apiRequest(path)
      if (page?.data) results.push(...page.data)
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
    const duration = decodedTrack.length

    const query = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
      const searchResult = await this.nodelink.sources.searchWithDefault(query)
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        return { exception: { message: 'No alternative found.', severity: 'fault' } }
      }

      const bestMatch = this._findBestMatch(searchResult.data, duration, decodedTrack)
      if (!bestMatch) {
        return { exception: { message: 'No suitable match.', severity: 'fault' } }
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
      searchQuery += this.allowExplicit ? ' explicit lyrical video' : ' non explicit lyrical video'
    }
    return searchQuery
  }

  _findBestMatch(list, target, original) {
    const allowed = target * DURATION_TOLERANCE
    let best = null
    let bestScore = Infinity

    for (const item of list) {
      const duration = item.info.length
      const diff = Math.abs(duration - target)
      if (diff > allowed) continue

      const titleSimilarity = this._calculateSimilarity(this._normalize(original.title), this._normalize(item.info.title))
      const authorSimilarity = this._calculateSimilarity(this._normalize(original.author), this._normalize(item.info.author))

      const score = diff * 0.5 + (1 - titleSimilarity) * target * 0.3 + (1 - authorSimilarity) * target * 0.2
      if (score < bestScore) {
        bestScore = score
        best = item
      }
    }

    return best
  }

  _normalize(text) {
    if (!text) return ''
    return text.toLowerCase().replace(/[^\w\s]/g, '').trim()
  }

  _calculateSimilarity(string1, string2) {
    if (!string1.length && !string2.length) return 1
    const longerString = string1.length > string2.length ? string1 : string2
    const shorterString = string1.length > string2.length ? string2 : string1
    const distance = this._levenshteinDistance(string1, string2)
    return (longerString.length - distance) / longerString.length
  }

  _levenshteinDistance(string1, string2) {
    const matrix = []
    for (let i = 0; i <= string2.length; i++) matrix[i] = [i]
    for (let j = 0; j <= string1.length; j++) matrix[0][j] = j

    for (let i = 1; i <= string2.length; i++) {
      for (let j = 1; j <= string1.length; j++) {
        matrix[i][j] =
          string1[j - 1] === string2[i - 1]
            ? matrix[i - 1][j - 1]
            : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
      }
    }

    return matrix[string2.length][string1.length]
  }
}
