import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'
const TOKEN_REFRESH_MARGIN = 300000
const DURATION_TOLERANCE = 0.15
const BATCH_SIZE_DEFAULT = 5

export default class SpotifySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['spsearch']
    this.patterns = [
      /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z]{2}\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/
    ]
    this.priority = 95

    this.accessToken = null
    this.tokenExpiry = null
    this.clientId = null
    this.clientSecret = null
    this.playlistLoadLimit = 0
    this.playlistPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.albumLoadLimit = 0
    this.albumPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.market = 'US'
    this.tokenInitialized = false
    this.allowExplicit = true
  }

  async setup() {
    if (this.tokenInitialized && this._isTokenValid()) return true

    try {
      this.clientId = this.config.sources.spotify?.clientId
      this.clientSecret = this.config.sources.spotify?.clientSecret
      this.playlistLoadLimit =
        this.config.sources.spotify?.playlistLoadLimit ?? 0
      this.playlistPageLoadConcurrency =
        this.config.sources.spotify?.playlistPageLoadConcurrency ??
        BATCH_SIZE_DEFAULT
      this.albumLoadLimit = this.config.sources.spotify?.albumLoadLimit ?? 0
      this.albumPageLoadConcurrency =
        this.config.sources.spotify?.albumPageLoadConcurrency ??
        BATCH_SIZE_DEFAULT
      this.market = this.config.sources.spotify?.market || 'US'
      this.allowExplicit = this.config.sources.spotify?.allowExplicit ?? true

      if (!this.clientId || !this.clientSecret) {
        logger(
          'warn',
          'Spotify',
          'Client ID or Client Secret not provided. Disabling source.'
        )
        return false
      }

      const success = await this._refreshToken()
      if (success) {
        logger(
          'info',
          'Spotify',
          `Tokens initialized successfully (playlistLoadLimit: ${this._formatLimit(this.playlistLoadLimit, 100)}, albumLoadLimit: ${this._formatLimit(this.albumLoadLimit, 50)})`
        )
      }
      return success
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error initializing Spotify tokens: ${e.message}`
      )
      return false
    }
  }

  _formatLimit(limit, multiplier) {
    return limit === 0 ? 'unlimited' : `${limit * multiplier} tracks max`
  }

  _isTokenValid() {
    return (
      this.tokenExpiry && Date.now() < this.tokenExpiry - TOKEN_REFRESH_MARGIN
    )
  }

  async _refreshToken() {
    try {
      const auth = Buffer.from(
        `${this.clientId}:${this.clientSecret}`
      ).toString('base64')

      const {
        body: tokenData,
        error,
        statusCode
      } = await http1makeRequest('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials',
        disableBodyCompression: true
      })

      if (error || statusCode !== 200) {
        logger(
          'error',
          'Spotify',
          `Error refreshing token: ${statusCode} - ${error?.message || 'Unknown error'}`
        )
        return false
      }

      this.accessToken = tokenData.access_token
      this.tokenExpiry = Date.now() + tokenData.expires_in * 1000
      this.tokenInitialized = true
      return true
    } catch (e) {
      logger('error', 'Spotify', `Token refresh failed: ${e.message}`)
      return false
    }
  }

  async _apiRequest(path) {
    if (!this.tokenInitialized || !this._isTokenValid()) {
      const success = await this.setup()
      if (!success)
        throw new Error('Failed to initialize Spotify for API request.')
    }

    try {
      const url = path.startsWith('http')
        ? path
        : `${SPOTIFY_API_BASE_URL}${path}`

      const { body, statusCode } = await http1makeRequest(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json'
        }
      })

      if (statusCode === 401) {
        this.tokenInitialized = false
        return this._apiRequest(path)
      }

      if (statusCode !== 200) {
        logger('error', 'Spotify', `API error: ${statusCode}`)
        return null
      }

      return body
    } catch (e) {
      logger('error', 'Spotify', `Error in Spotify apiRequest: ${e.message}`)
      return null
    }
  }

  _buildTrack(item, artworkUrl = null) {
    if (!item?.id) return null

    const isExplicit = item.explicit || false
    let trackUri = item.external_urls?.spotify || ''
    if (trackUri) {
      trackUri +=
        (trackUri.includes('?') ? '&' : '?') + `explicit=${isExplicit}`
    }

    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: item.artists?.map((a) => a.name).join(', ') || 'Unknown',
      length: item.duration_ms,
      isStream: false,
      position: 0,
      title: item.name,
      uri: trackUri,
      artworkUrl: artworkUrl || item.album?.images?.[0]?.url || null,
      isrc: item.external_ids?.isrc || null,
      sourceName: 'spotify'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async _fetchPaginatedData(baseUrl, totalItems, limit, maxPages, concurrency) {
    const allItems = []
    let pagesToFetch = Math.ceil(totalItems / limit)

    if (maxPages > 0) {
      pagesToFetch = Math.min(pagesToFetch, maxPages)
    }

    const promises = []
    for (let i = 1; i < pagesToFetch; i++) {
      const offset = i * limit
      promises.push(
        this._apiRequest(`${baseUrl}&offset=${offset}&limit=${limit}`)
      )
    }

    if (promises.length === 0) return allItems

    const batchSize = concurrency
    for (let i = 0; i < promises.length; i += batchSize) {
      const batch = promises.slice(i, i + batchSize)
      try {
        const results = await Promise.all(batch)
        for (const page of results) {
          if (page?.items) {
            allItems.push(...page.items)
          }
        }
      } catch (e) {
        logger(
          'warn',
          'Spotify',
          `Failed to fetch a batch of pages: ${e.message}`
        )
      }
    }

    return allItems
  }

  async search(query) {
    try {
      const limit = this.config.maxSearchResults || 10
      const data = await this._apiRequest(
        `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=${this.market}`
      )

      if (!data || data.error) {
        return {
          exception: {
            message: data?.error?.message || 'Search failed on Spotify.',
            severity: 'common'
          }
        }
      }

      if (!data.tracks || data.tracks.items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = data.tracks.items
        .map((item) => this._buildTrack(item))
        .filter(Boolean)

      if (tracks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      return { loadType: 'search', data: tracks }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async resolve(url) {
    try {
      const match = url.match(this.patterns[0])
      if (!match) return { loadType: 'empty', data: {} }

      const [, type, id] = match

      switch (type) {
        case 'track':
          return await this._resolveTrack(id)
        case 'album':
          return await this._resolveAlbum(id)
        case 'playlist':
          return await this._resolvePlaylist(id)
        case 'artist':
          return await this._resolveArtist(id)
        case 'episode':
        case 'show':
          return {
            exception: {
              message: 'This source does not support episodes or shows.',
              severity: 'common'
            }
          }
        default:
          return { loadType: 'empty', data: {} }
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _resolveTrack(id) {
    const data = await this._apiRequest(`/tracks/${id}?market=${this.market}`)
    if (!data) {
      return {
        exception: { message: 'Track not found.', severity: 'common' }
      }
    }
    return { loadType: 'track', data: this._buildTrack(data) }
  }

  async _resolveAlbum(id) {
    const albumData = await this._apiRequest(
      `/albums/${id}?market=${this.market}`
    )
    if (!albumData) {
      return {
        exception: { message: 'Album not found.', severity: 'common' }
      }
    }

    const allItems = []
    if (albumData.tracks?.items) {
      allItems.push(...albumData.tracks.items)
    }

    const totalTracks = albumData.tracks.total
    const additionalItems = await this._fetchPaginatedData(
      `/albums/${id}/tracks?market=${this.market}`,
      totalTracks,
      50,
      this.albumLoadLimit,
      this.albumPageLoadConcurrency
    )

    allItems.push(...additionalItems)

    const tracks = allItems
      .map((item) => {
        if (!item?.id) return null
        return this._buildTrack(
          { ...item, album: { images: albumData.images } },
          albumData.images?.[0]?.url
        )
      })
      .filter(Boolean)

    logger(
      'info',
      'Spotify',
      `Loaded ${tracks.length} of ${totalTracks} tracks from album "${albumData.name}".`
    )

    return {
      loadType: 'playlist',
      data: {
        info: { name: albumData.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    const fields =
      'name,tracks(items(track(id,name,artists,duration_ms,external_urls,external_ids,explicit,album(images))),total)'
    const playlistData = await this._apiRequest(
      `/playlists/${id}?fields=${fields}&market=${this.market}`
    )
    if (!playlistData) {
      return {
        exception: { message: 'Playlist not found.', severity: 'common' }
      }
    }

    const allItems = []
    if (playlistData.tracks?.items) {
      allItems.push(...playlistData.tracks.items)
    }

    const totalTracks = playlistData.tracks.total
    const additionalFields =
      'items(track(id,name,artists,duration_ms,external_urls,external_ids,explicit,album(images)))'
    const additionalItems = await this._fetchPaginatedData(
      `/playlists/${id}/tracks?fields=${additionalFields}&market=${this.market}`,
      totalTracks,
      100,
      this.playlistLoadLimit,
      this.playlistPageLoadConcurrency
    )

    allItems.push(...additionalItems)

    const tracks = allItems
      .map((item) => {
        const track = item.track || item
        return this._buildTrack(track)
      })
      .filter(Boolean)

    logger(
      'info',
      'Spotify',
      `Loaded ${tracks.length} of ${totalTracks} tracks from playlist "${playlistData.name}".`
    )

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistData.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveArtist(id) {
    const artist = await this._apiRequest(`/artists/${id}`)
    if (!artist) {
      return {
        exception: { message: 'Artist not found.', severity: 'common' }
      }
    }

    const topTracks = await this._apiRequest(
      `/artists/${id}/top-tracks?market=${this.market}`
    )
    if (!topTracks?.tracks) {
      return {
        exception: {
          message: 'Failed to get artist top tracks.',
          severity: 'common'
        }
      }
    }

    const tracks = topTracks.tracks
      .map((item) => this._buildTrack(item, artist.images?.[0]?.url))
      .filter(Boolean)

    return {
      loadType: 'playlist',
      data: {
        info: { name: `${artist.name}'s Top Tracks`, selectedTrack: 0 },
        tracks
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    let isExplicit = false
    if (decodedTrack.uri) {
      try {
        const url = new URL(decodedTrack.uri)
        isExplicit = url.searchParams.get('explicit') === 'true'
      } catch (e) {
        // Ignore malformed URI
      }
    }

    const spotifyDuration = decodedTrack.length

    const query = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
      const searchResult = await this.nodelink.sources.searchWithDefault(query)

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return {
          exception: {
            message: 'No alternative stream found via default search.',
            severity: 'fault'
          }
        }
      }

      const bestMatch = await this._findBestMatch(
        searchResult.data,
        spotifyDuration,
        decodedTrack,
        isExplicit,
        this.allowExplicit
      )

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative stream found after filtering.',
            severity: 'fault'
          }
        }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger('warn', 'Spotify', `Search for "${query}" failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _buildSearchQuery(track, isExplicit) {
    let searchQuery = `${track.title} ${track.author}`
    if (isExplicit) {
      searchQuery += this.allowExplicit ? ' lyrical video' : ' clean version'
    }
    return searchQuery
  }

  async _findBestMatch(
    list,
    target,
    original,
    isExplicit,
    allowExplicit,
    retried = false
  ) {
    const allowedDurationDiff = target * DURATION_TOLERANCE
    const normalizedOriginalTitle = this._normalize(original.title)
    const normalizedOriginalAuthor = this._normalize(original.author)

    const scoredCandidates = list
      .filter(
        (item) => Math.abs(item.info.length - target) <= allowedDurationDiff
      )
      .map((item) => {
        const normalizedItemTitle = this._normalize(item.info.title)
        const normalizedItemAuthor = this._normalize(item.info.author)
        let score = 0

        const originalTitleWords = new Set(
          normalizedOriginalTitle.split(' ').filter((w) => w.length > 0)
        )
        const itemTitleWords = new Set(
          normalizedItemTitle.split(' ').filter((w) => w.length > 0)
        )

        let titleScore = 0
        for (const word of originalTitleWords) {
          if (itemTitleWords.has(word)) {
            titleScore++
          }
        }
        score += titleScore * 100

        const originalArtists = normalizedOriginalAuthor
          .split(/,\s*|\s+&\s+/)
          .map((a) => a.trim())
          .filter(Boolean)
        let authorMatchScore = 0
        for (const artist of originalArtists) {
          if (normalizedItemAuthor.includes(artist)) {
            authorMatchScore += 100
          }
        }
        if (authorMatchScore > 0) {
          score += authorMatchScore
        } else {
          const authorSimilarity = this._calculateSimilarity(
            normalizedOriginalAuthor,
            normalizedItemAuthor
          )
          score += authorSimilarity * 50
        }

        const titleWords = new Set(normalizedItemTitle.split(' '))
        const originalTitleWordsSet = new Set(
          normalizedOriginalTitle.split(' ')
        )
        const extraWords = [...titleWords].filter(
          (word) => !originalTitleWordsSet.has(word)
        )
        score -= extraWords.length * 5

        const isCleanOrRadio =
          normalizedItemTitle.includes('clean') ||
          normalizedItemTitle.includes('radio')

        if (isExplicit && !allowExplicit) {
          if (isCleanOrRadio) {
            score += 500
          }
        } else if (!isExplicit) {
          if (isCleanOrRadio) {
            score -= 200
          }
        } else {
          if (isCleanOrRadio) {
            score -= 200
          }
        }

        return { item, score }
      })
      .filter((c) => c.score >= 0)

    if (scoredCandidates.length === 0 && !retried) {
      const newSearch = await this.nodelink.sources.searchWithDefault(
        `${original.title} ${original.author} official video`
      )
      if (newSearch.loadType !== 'search' || newSearch.data.length === 0) {
        return null
      }

      return await this._findBestMatch(
        newSearch.data,
        target,
        original,
        isExplicit,
        allowExplicit,
        true
      )
    }

    if (scoredCandidates.length === 0) {
      return null
    }

    scoredCandidates.sort((a, b) => b.score - a.score)

    return scoredCandidates[0].item
  }

  _normalize(str) {
    return str
      .toLowerCase()
      .replace(/feat\.?/g, '')
      .replace(/ft\.?/g, '')
      .replace(/[^\w\s]/g, '')
      .trim()
  }

  _calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2
    const shorter = str1.length > str2.length ? str2 : str1

    if (longer.length === 0) return 1.0

    const editDistance = this._levenshteinDistance(longer, shorter)
    return (longer.length - editDistance) / longer.length
  }

  _levenshteinDistance(str1, str2) {
    const matrix = []

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i]
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          )
        }
      }
    }

    return matrix[str2.length][str1.length]
  }
}
