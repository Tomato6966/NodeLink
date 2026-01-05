import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'
const SPOTIFY_INTERNAL_API_URL =
  'https://api-partner.spotify.com/pathfinder/v2/query'
const TOKEN_REFRESH_MARGIN = 300000
const BATCH_SIZE_DEFAULT = 5

const QUERIES = {
  getTrack: {
    name: 'getTrack',
    hash: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294'
  },
  getAlbum: {
    name: 'getAlbum',
    hash: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10'
  },
  getPlaylist: {
    name: 'fetchPlaylist',
    hash: 'bb67e0af06e8d6f52b531f97468ee4acd44cd0f82b988e15c2ea47b1148efc77'
  },
  getArtist: {
    name: 'queryArtistOverview',
    hash: '35648a112beb1794e39ab931365f6ae4a8d45e65396d641eeda94e4003d41497'
  },
  searchDesktop: {
    name: 'searchDesktop',
    hash: 'fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c'
  }
}

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
    this.externalAuthUrl = null
    this.playlistLoadLimit = 0
    this.playlistPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.albumLoadLimit = 0
    this.albumPageLoadConcurrency = BATCH_SIZE_DEFAULT
    this.market = 'US'
    this.tokenInitialized = false
    this.allowExplicit = true
  }

  async setup() {
    const cachedToken = this.nodelink.credentialManager.get(
      'spotify_access_token'
    )
    if (cachedToken) {
      this.accessToken = cachedToken
      this.tokenInitialized = true
      return true
    }

    if (this.tokenInitialized && this._isTokenValid()) return true

    try {
      this.clientId = this.config.sources.spotify?.clientId
      this.clientSecret = this.config.sources.spotify?.clientSecret
      this.externalAuthUrl = this.config.sources.spotify?.externalAuthUrl
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

      if (!this.externalAuthUrl && (!this.clientId || !this.clientSecret)) {
        logger(
          'warn',
          'Spotify',
          'Neither externalAuthUrl nor Client ID/Secret provided. Disabling source.'
        )
        return false
      }

      const success = await this._refreshToken()
      if (success) {
        logger(
          'info',
          'Spotify',
          `Tokens initialized successfully (${this.externalAuthUrl ? 'Anonymous' : 'OAuth'}, playlistLoadLimit: ${this._formatLimit(this.playlistLoadLimit, 100)}, albumLoadLimit: ${this._formatLimit(this.albumLoadLimit, 50)})`
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
      if (this.externalAuthUrl) {
        const response = await http1makeRequest(this.externalAuthUrl, {
          headers: { Accept: 'application/json' },
          disableBodyCompression: true
        }).catch((err) => {
          return { error: err }
        })

        const { body: tokenData, error, statusCode } = response

        if (error || statusCode !== 200 || !tokenData?.accessToken) {
          const errorMsg =
            error?.message ||
            (typeof error === 'string'
              ? error
              : JSON.stringify(error || tokenData)) ||
            'Unknown error'
          logger(
            'error',
            'Spotify',
            `Error fetching anonymous token from external server: ${statusCode || 'No status'} - ${errorMsg}`
          )
          return false
        }

        this.accessToken = tokenData.accessToken
        const expiresMs = tokenData.accessTokenExpirationTimestampMs
          ? tokenData.accessTokenExpirationTimestampMs - Date.now()
          : 3600000
        this.tokenExpiry = Date.now() + Math.max(expiresMs, 60000)
        this.nodelink.credentialManager.set(
          'spotify_access_token',
          this.accessToken,
          Math.max(expiresMs, 60000)
        )
        this.tokenInitialized = true
        return true
      }

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
      this.nodelink.credentialManager.set(
        'spotify_access_token',
        this.accessToken,
        tokenData.expires_in * 1000
      )
      this.tokenInitialized = true
      return true
    } catch (e) {
      logger('error', 'Spotify', `Token refresh failed: ${e.message || e}`)
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
      const { body, statusCode, headers } = await http1makeRequest(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json'
        }
      })

      if (statusCode === 429) {
        const retryAfter = headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : 5
        logger(
          'warn',
          'Spotify',
          `Rate limited. Retrying after ${retryAfter} seconds.`
        )
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
        return this._apiRequest(path)
      }

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

  async _internalApiRequest(operation, variables) {
    if (!this.tokenInitialized || !this._isTokenValid()) {
      const success = await this.setup()
      if (!success)
        throw new Error(
          'Failed to initialize Spotify for Internal API request.'
        )
    }

    try {
      const { body, statusCode, headers } = await http1makeRequest(
        SPOTIFY_INTERNAL_API_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'App-Platform': 'WebPlayer',
            'Spotify-App-Version': '1.2.81.104.g225ec0e6',
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: {
            variables,
            operationName: operation.name,
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: operation.hash
              }
            }
          },
          disableBodyCompression: true
        }
      )

      if (statusCode === 429) {
        const retryAfter = headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : 5
        logger(
          'warn',
          'Spotify',
          `Internal API Rate limited. Retrying after ${retryAfter} seconds.`
        )
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000))
        return this._internalApiRequest(operation, variables)
      }

      if (statusCode === 401) {
        this.tokenInitialized = false
        return this._internalApiRequest(operation, variables)
      }

      if (statusCode !== 200 || body.errors) {
        logger(
          'error',
          'Spotify',
          `Internal API error: ${statusCode} - ${JSON.stringify(body.errors || body)}`
        )
        return null
      }

      return body.data
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error in Spotify internalApiRequest: ${e.message}`
      )
      return null
    }
  }

  async _fetchInternalPaginatedData(
    operation,
    uri,
    totalItems,
    limit,
    maxPages,
    concurrency,
    extraVars = {}
  ) {
    const allItems = []
    let pagesToFetch = Math.ceil(totalItems / limit)

    if (maxPages > 0) {
      pagesToFetch = Math.min(pagesToFetch, maxPages)
    }

    const requests = []
    for (let i = 1; i < pagesToFetch; i++) {
      requests.push({
        ...extraVars,
        uri,
        offset: i * limit,
        limit
      })
    }

    if (requests.length === 0) return allItems

    for (let i = 0; i < requests.length; i += concurrency) {
      const batch = requests.slice(i, i + concurrency)
      try {
        this.nodelink.sendHeartbeat?.()
        const results = await Promise.all(
          batch.map((vars) => this._internalApiRequest(operation, vars))
        )
        for (const data of results) {
          const items =
            data?.playlistV2?.content?.items ||
            data?.albumUnion?.tracksV2?.items
          if (items) {
            allItems.push(...items)
          }
        }
      } catch (e) {
        logger(
          'warn',
          'Spotify',
          `Failed to fetch a batch of internal pages: ${e.message}`
        )
      }
    }

    return allItems
  }

  _buildTrackFromInternal(item, artworkUrl = null) {
    if (!item?.uri) return null

    const id = item.uri.split(':').pop()
    const isExplicit =
      item.contentRating?.label === 'EXPLICIT' || item.explicit === true

    let trackUri = `https://open.spotify.com/track/${id}`
    trackUri += `?explicit=${isExplicit}`

    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author:
        item.artists?.items?.map((a) => a.profile?.name || a.name).join(', ') ||
        item.firstArtist?.items[0]?.profile?.name ||
        item.otherArtists.items.map((a) => a.profile.name).join(', ') ||
        'Unknown',
      length:
        item.duration?.totalMilliseconds ||
        item.trackDuration?.totalMilliseconds ||
        0,
      isStream: false,
      position: 0,
      title: item.name,
      uri: trackUri,
      artworkUrl:
        artworkUrl ||
        item.albumOfTrack?.coverArt?.sources?.[0]?.url ||
        item.album?.images?.[0]?.url ||
        null,
      isrc: item.externalIds?.isrc || null,
      sourceName: 'spotify'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  _buildTrack(item, artworkUrl = null) {
    if (!item?.id) return null

    const isExplicit = item.explicit || false
    let trackUri = item.external_urls?.spotify || ''
    if (trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
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

  async search(query, sourceTerm, searchType = 'track') {
    try {
      const limit = this.config.maxSearchResults || 10

      if (this.externalAuthUrl) {
        const data = await this._internalApiRequest(QUERIES.searchDesktop, {
          searchTerm: query,
          offset: 0,
          limit,
          numberOfTopResults: 5,
          includeAudiobooks: false,
          includeArtistHasConcertsField: false,
          includePreReleases: false
        })

        if (!data?.searchV2) {
          return { loadType: 'empty', data: {} }
        }

        const results = this._processInternalSearchResults(data.searchV2, searchType)
        return results.length === 0
          ? { loadType: 'empty', data: {} }
          : { loadType: 'search', data: results }
      }

      const typeMap = {
        track: 'track',
        album: 'album',
        playlist: 'playlist',
        artist: 'artist'
      }
      const spotifyType = typeMap[searchType] || 'track'

      const data = await this._apiRequest(
        `/search?q=${encodeURIComponent(query)}&type=${spotifyType}&limit=${limit}&market=${this.market}`
      )

      if (!data || data.error) {
        return {
          exception: {
            message: data?.error?.message || 'Search failed on Spotify.',
            severity: 'common'
          }
        }
      }

      const results = this._processOfficialSearchResults(data, spotifyType)
      return results.length === 0
        ? { loadType: 'empty', data: {} }
        : { loadType: 'search', data: results }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  _processInternalSearchResults(searchV2, searchType) {
    const results = []

    if (searchType === 'track' && searchV2.tracksV2?.items) {
      for (const item of searchV2.tracksV2.items) {
        const track = this._buildTrackFromInternal(item.item.data)
        if (track) results.push(track)
      }
    } else if (searchType === 'album' && searchV2.albumsV2?.items) {
      for (const item of searchV2.albumsV2.items) {
        const album = item.data
        const info = {
          title: album.name,
          author: album.artists.items.map((a) => a.profile.name).join(', '),
          length: 0,
          identifier: album.uri.split(':').pop(),
          isSeekable: true,
          isStream: false,
          uri: `https://open.spotify.com/album/${album.uri.split(':').pop()}`,
          artworkUrl: album.coverArt?.sources?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'album' }
        })
      }
    } else if (searchType === 'playlist' && searchV2.playlists?.items) {
      for (const item of searchV2.playlists.items) {
        const playlist = item.data
        const info = {
          title: playlist.name,
          author: playlist.ownerV2?.data?.name || 'Unknown',
          length: 0,
          identifier: playlist.uri.split(':').pop(),
          isSeekable: true,
          isStream: false,
          uri: `https://open.spotify.com/playlist/${playlist.uri.split(':').pop()}`,
          artworkUrl: playlist.images?.items?.[0]?.sources?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'playlist' }
        })
      }
    } else if (searchType === 'artist' && searchV2.artists?.items) {
      for (const item of searchV2.artists.items) {
        const artist = item.data
        const info = {
          title: artist.profile.name,
          author: 'Spotify',
          length: 0,
          identifier: artist.uri.split(':').pop(),
          isSeekable: false,
          isStream: false,
          uri: `https://open.spotify.com/artist/${artist.uri.split(':').pop()}`,
          artworkUrl: artist.visuals?.avatarImage?.sources?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'artist' }
        })
      }
    }

    return results
  }

  _processOfficialSearchResults(data, spotifyType) {
    const results = []

    if (spotifyType === 'track' && data.tracks?.items) {
      for (const item of data.tracks.items) {
        const track = this._buildTrack(item)
        if (track) results.push(track)
      }
    } else if (spotifyType === 'album' && data.albums?.items) {
      for (const item of data.albums.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: item.artists.map((a) => a.name).join(', '),
          length: 0,
          identifier: item.id,
          isSeekable: true,
          isStream: false,
          uri: item.external_urls?.spotify || `https://open.spotify.com/album/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'album' }
        })
      }
    } else if (spotifyType === 'playlist' && data.playlists?.items) {
      for (const item of data.playlists.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: item.owner?.display_name || 'Unknown',
          length: 0,
          identifier: item.id,
          isSeekable: true,
          isStream: false,
          uri: item.external_urls?.spotify || `https://open.spotify.com/playlist/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'playlist' }
        })
      }
    } else if (spotifyType === 'artist' && data.artists?.items) {
      for (const item of data.artists.items) {
        if (!item) continue
        const info = {
          title: item.name,
          author: 'Spotify',
          length: 0,
          identifier: item.id,
          isSeekable: false,
          isStream: false,
          uri: item.external_urls?.spotify || `https://open.spotify.com/artist/${item.id}`,
          artworkUrl: item.images?.[0]?.url || null,
          isrc: null,
          sourceName: 'spotify',
          position: 0
        }
        results.push({
          encoded: encodeTrack(info),
          info,
          pluginInfo: { type: 'artist' }
        })
      }
    }

    return results
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
    if (this.externalAuthUrl) {
      const data = await this._internalApiRequest(QUERIES.getTrack, {
        uri: `spotify:track:${id}`
      })
      if (!data?.trackUnion || data.trackUnion.__typename === 'NotFound') {
        return {
          exception: { message: 'Track not found.', severity: 'common' }
        }
      }
      return {
        loadType: 'track',
        data: this._buildTrackFromInternal(data.trackUnion)
      }
    }

    const data = await this._apiRequest(`/tracks/${id}?market=${this.market}`)
    if (!data) {
      return {
        exception: { message: 'Track not found.', severity: 'common' }
      }
    }
    return { loadType: 'track', data: this._buildTrack(data) }
  }

  async _resolveAlbum(id) {
    if (this.externalAuthUrl) {
      const data = await this._internalApiRequest(QUERIES.getAlbum, {
        uri: `spotify:album:${id}`,
        locale: 'en',
        offset: 0,
        limit: 300
      })

      if (!data?.albumUnion || data.albumUnion.__typename === 'NotFound') {
        return {
          exception: { message: 'Album not found.', severity: 'common' }
        }
      }

      const allItems = [...data.albumUnion.tracksV2.items]
      const totalTracks = data.albumUnion.tracksV2.totalCount
      if (totalTracks > 300) {
        const additionalItems = await this._fetchInternalPaginatedData(
          QUERIES.getAlbum,
          `spotify:album:${id}`,
          totalTracks,
          300,
          this.albumLoadLimit,
          this.albumPageLoadConcurrency,
          { locale: 'en' }
        )
        allItems.push(...additionalItems)
      }

      const tracks = allItems
        .map((item) =>
          this._buildTrackFromInternal(
            item.track,
            data.albumUnion.coverArt.sources[0].url
          )
        )
        .filter(Boolean)

      return {
        loadType: 'playlist',
        data: {
          info: { name: data.albumUnion.name, selectedTrack: 0 },
          tracks
        }
      }
    }

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
    if (this.externalAuthUrl) {
      const data = await this._internalApiRequest(QUERIES.getPlaylist, {
        uri: `spotify:playlist:${id}`,
        offset: 0,
        limit: 100,
        enableWatchFeedEntrypoint: false
      })

      if (!data?.playlistV2 || data.playlistV2.__typename === 'NotFound') {
        return {
          exception: { message: 'Playlist not found.', severity: 'common' }
        }
      }

      const allItems = [...data.playlistV2.content.items]
      const totalTracks = data.playlistV2.content.totalCount
      const additionalItems = await this._fetchInternalPaginatedData(
        QUERIES.getPlaylist,
        `spotify:playlist:${id}`,
        totalTracks,
        100,
        this.playlistLoadLimit,
        this.playlistPageLoadConcurrency,
        { enableWatchFeedEntrypoint: false }
      )
      allItems.push(...additionalItems)

      const tracks = allItems
        .map((item) => this._buildTrackFromInternal(item.itemV2.data))
        .filter(Boolean)

      return {
        loadType: 'playlist',
        data: {
          info: { name: data.playlistV2.name, selectedTrack: 0 },
          tracks
        }
      }
    }

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
    if (this.externalAuthUrl) {
      const data = await this._internalApiRequest(QUERIES.getArtist, {
        uri: `spotify:artist:${id}`,
        locale: 'en',
        includePrerelease: true
      })

      if (!data?.artistUnion || data.artistUnion.__typename === 'NotFound') {
        return {
          exception: { message: 'Artist not found.', severity: 'common' }
        }
      }

      const tracks = data.artistUnion.discography.topTracks.items
        .map((item) => this._buildTrackFromInternal(item.track))
        .filter(Boolean)

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: `${data.artistUnion.profile.name}'s Top Tracks`,
            selectedTrack: 0
          },
          tracks
        }
      }
    }

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
      } catch (_e) {
        // Ignore malformed URI
      }
    }

    const query = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
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
            message: 'No alternative stream found via default search.',
            severity: 'fault'
          }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

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
}
