import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'
import { fetchCanvas } from '../modules/spotifyCanvas.js'
import { getLocalToken } from '../modules/spotifyAuth.js'

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'
const SPOTIFY_CLIENT_API_URL = 'https://spclient.wg.spotify.com'
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
  getRecommendations: {
    name: 'internalLinkRecommenderTrack',
    hash: 'c77098ee9d6ee8ad3eb844938722db60570d040b49f41f5ec6e7be9160a7c86b'
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
    this.recommendationTerm = ['sprec']
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
    this.anonymousToken = null
    this.mobileToken = null
    this.spDc = null
  }

  async setup() {
    this.accessToken = this.nodelink.credentialManager.get(
      'spotify_access_token'
    )
    this.anonymousToken = this.nodelink.credentialManager.get(
      'spotify_anonymous_token'
    )
    this.mobileToken = this.nodelink.credentialManager.get(
      'spotify_mobile_token'
    )

    const hasOfficialConfig =
      this.config.sources.spotify?.clientId &&
      this.config.sources.spotify?.clientSecret
    const hasAnonymousConfig =
      this.config.sources.spotify?.externalAuthUrl ||
      this.config.sources.spotify?.sp_dc

    const missingOfficial = hasOfficialConfig && !this.accessToken
    const missingAnonymous = hasAnonymousConfig && !this.anonymousToken

    if (!missingOfficial && !missingAnonymous) {
      if (this.accessToken || this.anonymousToken) {
        this.tokenInitialized = true

        if (this.config.sources.spotify?.sp_dc) {
          this.spDc = this.config.sources.spotify.sp_dc
          if (!this.mobileToken) await this._refreshMobileToken()
        }

        return true
      }
    }

    try {
      this.clientId = this.config.sources.spotify?.clientId
      this.clientSecret = this.config.sources.spotify?.clientSecret
      this.externalAuthUrl = this.config.sources.spotify?.externalAuthUrl
      this.spDc = this.config.sources.spotify?.sp_dc
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

      if (!this.externalAuthUrl && !this.spDc && (!this.clientId || !this.clientSecret)) {
        logger(
          'warn',
          'Spotify',
          'Neither externalAuthUrl, sp_dc nor Client ID/Secret provided. Disabling source.'
        )
        return false
      }

      const success = await this._refreshToken()
      if (success) {
        logger(
          'info',
          'Spotify',
          `Tokens initialized successfully. Official: ${!!this.accessToken}, Anonymous: ${!!this.anonymousToken}, Mobile: ${!!this.mobileToken}`
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

  _base62ToHex(id) {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let bn = 0n
    for (const char of id) {
      bn = bn * 62n + BigInt(alphabet.indexOf(char))
    }
    return bn.toString(16).padStart(32, '0')
  }

  async _fetchTrackMetadata(id) {
    const token = this.anonymousToken || this.mobileToken || this.accessToken
    if (!token) return null

    try {
      const hexId = this._base62ToHex(id)
      const url = `${SPOTIFY_CLIENT_API_URL}/metadata/4/track/${hexId}?market=from_token`
      const { body, statusCode } = await http1makeRequest(url, {
        responseType: 'buffer',
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept': 'application/json',
          'App-Platform': 'WebPlayer',
          'Spotify-App-Version': '1.2.83.284.g147edeea'
        }
      })

      if (statusCode !== 200 || !body) return null

      const bodyStr = body.toString()
      try {
        return JSON.parse(bodyStr)
      } catch {
        const isrcIndex = body.indexOf('isrc')
        if (isrcIndex !== -1) {
          const bodyRange = body.subarray(isrcIndex, isrcIndex + 50).toString()
          const isrcMatch = bodyRange.match(/[A-Z0-9]{12}/)
          if (isrcMatch) return { external_id: [{ type: 'isrc', id: isrcMatch[0] }] }
        }
      }

      return null
    } catch (e) {
      logger('debug', 'Spotify', `Exception in _fetchTrackMetadata for ${id}: ${e.message}`)
      return null
    }
  }

  _buildTrackFromMetadata(data) {
    if (!data || !data.name) return null

    const id = data.canonical_uri?.split(':').pop() || data.gid

    const isExplicit = !!data.explicit
    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: data.artist?.map((a) => a.name).join(', ') || 'Unknown',
      length: data.duration || 0,
      isStream: false,
      position: 0,
      title: data.name,
      uri: `https://open.spotify.com/track/${id}?explicit=${isExplicit}`,
      artworkUrl: data.album?.cover_group?.image?.find(img => img.size === 'LARGE' || img.size === 'DEFAULT')?.file_id
        ? `https://i.scdn.co/image/${data.album.cover_group.image.find(img => img.size === 'LARGE' || img.size === 'DEFAULT').file_id}`
        : null,
      isrc: data.external_id?.find((e) => e.type === 'isrc')?.id || null,
      sourceName: 'spotify'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  _isTokenValid() {
    return (
      this.tokenExpiry && Date.now() < this.tokenExpiry - TOKEN_REFRESH_MARGIN
    )
  }

  async _refreshMobileToken() {
    if (!this.spDc) return

    try {
      const { getLocalToken } = await import('../modules/spotifyAuth.js')
      const tokenData = await getLocalToken(this.spDc, 'mobile-web-player')
      if (tokenData?.accessToken) {
        this.mobileToken = tokenData.accessToken
        const expiresMs = tokenData.accessTokenExpirationTimestampMs
          ? tokenData.accessTokenExpirationTimestampMs - Date.now()
          : 3600000

        this.nodelink.credentialManager.set(
          'spotify_mobile_token',
          this.mobileToken,
          Math.max(expiresMs, 60000)
        )
        logger('debug', 'Spotify', 'Canvas token (mobile) refreshed successfully')
      }
    } catch (e) {
      logger('warn', 'Spotify', `Mobile token refresh failed: ${e.message}`)
    }
  }

  async _refreshToken() {
    let success = false

    if (!this.anonymousToken) {
      this.nodelink.credentialManager.set('spotify_anonymous_token', null)

      try {
        const tokenData = await getLocalToken(null, 'web-player')

        if (tokenData?.accessToken) {
          this.anonymousToken = tokenData.accessToken
          const expiresMs = tokenData.accessTokenExpirationTimestampMs
            ? tokenData.accessTokenExpirationTimestampMs - Date.now()
            : 3600000

          if (!this.accessToken) {
            this.tokenExpiry = Date.now() + Math.max(expiresMs, 60000)
          }

          this.nodelink.credentialManager.set(
            'spotify_anonymous_token',
            this.anonymousToken,
            Math.max(expiresMs, 60000)
          )
          success = true
          logger('debug', 'Spotify', 'Generated local anonymous token')
        }
      } catch (e) {
        logger(
          'warn',
          'Spotify',
          `Local anonymous token generation failed: ${e.message}`
        )
      }

      if (!this.anonymousToken && this.externalAuthUrl) {
        try {
          const response = await http1makeRequest(this.externalAuthUrl, {
            headers: { Accept: 'application/json' },
            disableBodyCompression: true
          })

          const { body: tokenData, error, statusCode } = response

          if (!error && statusCode === 200 && tokenData?.accessToken) {
            this.anonymousToken = tokenData.accessToken
            const expiresMs = tokenData.accessTokenExpirationTimestampMs
              ? tokenData.accessTokenExpirationTimestampMs - Date.now()
              : 3600000

            if (!this.accessToken) {
              this.tokenExpiry = Date.now() + Math.max(expiresMs, 60000)
            }

            this.nodelink.credentialManager.set(
              'spotify_anonymous_token',
              this.anonymousToken,
              Math.max(expiresMs, 60000)
            )
            success = true
          } else {
            logger(
              'warn',
              'Spotify',
              `Failed to fetch anonymous token from external URL: ${statusCode}`
            )
          }
        } catch (e) {
          logger(
            'error',
            'Spotify',
            `External anonymous token refresh failed: ${e.message}`
          )
        }
      }
    } else if (this.anonymousToken) {
      success = true
    }

    if (this.clientId && this.clientSecret && !this.accessToken) {
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

        if (!error && statusCode === 200) {
          this.accessToken = tokenData.access_token
          this.tokenExpiry = Date.now() + tokenData.expires_in * 1000
          this.nodelink.credentialManager.set(
            'spotify_access_token',
            this.accessToken,
            tokenData.expires_in * 1000
          )
          success = true
        } else {
          logger(
            'error',
            'Spotify',
            `Failed to refresh official token: ${statusCode}`
          )
        }
      } catch (e) {
        logger(
          'error',
          'Spotify',
          `Official token refresh failed: ${e.message}`
        )
      }
    } else if (this.accessToken) {
      success = true
    }

    if (this.spDc) {
      await this._refreshMobileToken()

      if (!this.externalAuthUrl && this.mobileToken) {
        this.anonymousToken = this.mobileToken
      }
    }

    this.tokenInitialized = success || !!this.mobileToken
    return this.tokenInitialized
  }

  async _apiRequest(path, retryCount = 0) {
    if (!this.accessToken) return null

    if (!this.tokenInitialized || !this._isTokenValid()) {
      await this.setup()
    }

    if (!this.accessToken) return null

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
        if (retryCount >= 3) {
          logger('error', 'Spotify', `Rate limit retry cap reached for ${path}. Skipping.`)
          return null
        }

        const retryAfter = headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : 5

        logger(
          'warn',
          'Spotify',
          `Rate limited (Attempt ${retryCount + 1}/3). Requesting new token...`
        )

        if (this.externalAuthUrl) {
          this.anonymousToken = null
          this.accessToken = null
          this.tokenInitialized = false
          await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1)))
          const refreshed = await this._refreshToken()
          if (refreshed) return this._apiRequest(path, retryCount + 1)
        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 10) * 1000))
        return this._apiRequest(path, retryCount + 1)
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

  async _internalApiRequest(operation, variables, retryCount = 0) {
    if (!this.tokenInitialized || !this._isTokenValid()) {
      await this.setup()
    }

    const token = this.anonymousToken || this.accessToken

    if (!token) {
      return null
    }

    try {
      const { body, statusCode, headers } = await http1makeRequest(
        SPOTIFY_INTERNAL_API_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
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
        if (retryCount >= 3) {
          logger('error', 'Spotify', `Internal API Rate limit retry cap reached. Skipping.`)
          return null
        }

        const retryAfter = headers['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : 5

        logger(
          'warn',
          'Spotify',
          `Internal API Rate limited (Attempt ${retryCount + 1}/3). Requesting new token...`
        )

        if (this.externalAuthUrl) {
          this.anonymousToken = null
          this.accessToken = null
          this.tokenInitialized = false
          await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1)))
          const refreshed = await this._refreshToken()
          if (refreshed) return this._internalApiRequest(operation, variables, retryCount + 1)
        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 10) * 1000))
        return this._internalApiRequest(operation, variables, retryCount + 1)
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
      let attempts = 0
      while (attempts < 3) {
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
          break
        } catch (e) {
          attempts++
          if (attempts >= 3) {
            logger(
              'warn',
              'Spotify',
              `Failed to fetch a batch of internal pages after 3 attempts: ${e.message}`
            )
          } else {
            await new Promise((r) => setTimeout(r, 1500))
          }
        }
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
      let attempts = 0
      while (attempts < 3) {
        try {
          const results = await Promise.all(batch)
          for (const page of results) {
            if (page?.items) {
              allItems.push(...page.items)
            }
          }
          break
        } catch (e) {
          attempts++
          if (attempts >= 3) {
            logger(
              'warn',
              'Spotify',
              `Failed to fetch a batch of pages after 3 attempts: ${e.message}`
            )
          } else {
            await new Promise((r) => setTimeout(r, 1500))
          }
        }
      }
    }

    return allItems
  }

  async _fetchFullTracks(ids) {
    if (!this.clientId || !this.clientSecret || !this.accessToken || ids.length === 0) return []

    const batches = []
    for (let i = 0; i < ids.length; i += 50) {
      batches.push(ids.slice(i, i + 50))
    }

    const aggregatedTracks = []
    const fetchPromises = batches.map((batch) =>
      this._apiRequest(`/tracks?ids=${encodeURIComponent(batch.join(','))}`)
    )

    try {
      const results = await Promise.all(fetchPromises)
      for (const data of results) {
        if (Array.isArray(data?.tracks)) {
          aggregatedTracks.push(...data.tracks)
        }
      }
    } catch (e) {
      logger('warn', 'Spotify', `Failed to fetch full track details: ${e.message}`)
    }

    return aggregatedTracks
  }

  async search(query, sourceTerm, searchType = 'track') {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    try {
      const limit = this.config.maxSearchResults || 10

      if (this.externalAuthUrl || this.anonymousToken) {
        const data = await this._internalApiRequest(QUERIES.searchDesktop, {
          searchTerm: query,
          offset: 0,
          limit,
          numberOfTopResults: 5,
          includeAudiobooks: false,
          includeArtistHasConcertsField: false,
          includePreReleases: false
        })

        if (data?.searchV2) {
          const results = this._processInternalSearchResults(
            data.searchV2,
            searchType
          )
          if (results.length > 0 && searchType === 'track') {
            const topTrack = results[0]
            if (!topTrack.info.isrc) {
              const metadata = await this._fetchTrackMetadata(topTrack.info.identifier)
              if (metadata) {
                const isrc = metadata.external_id?.find((e) => e.type === 'isrc')?.id
                if (isrc) {
                  topTrack.info.isrc = isrc
                  topTrack.encoded = encodeTrack(topTrack.info)
                }
              }
            }
          }

          if (results.length > 0) {
            return { loadType: 'search', data: results }
          }
        }
      }

      if (this.clientId && this.clientSecret) {
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

        if (data && !data.error) {
          const results = this._processOfficialSearchResults(data, spotifyType)

          if (results.length > 0 && spotifyType === 'track') {
            const topTrack = results[0]
            if (!topTrack.info.isrc) {
              const metadata = await this._fetchTrackMetadata(topTrack.info.identifier)
              if (metadata) {
                const isrc = metadata.external_id?.find((e) => e.type === 'isrc')?.id
                if (isrc) {
                  topTrack.info.isrc = isrc
                  topTrack.encoded = encodeTrack(topTrack.info)
                }
              }
            }
          }

          if (results.length > 0) {
            return { loadType: 'search', data: results }
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async getRecommendations(query) {
    try {
      const token = this.anonymousToken || this.accessToken
      if (!token) return { loadType: 'empty', data: {} }

      let trackId = query
      if (query.includes('seed_tracks=')) {
        trackId = query.split('seed_tracks=')[1].split('&')[0]
      }

      if (!/^[a-zA-Z0-9]{22}$/.test(trackId) && !query.includes('=')) {
        const searchResult = await this.search(query, 'spsearch', 'track')
        if (searchResult.loadType === 'search' && searchResult.data.length > 0) {
          trackId = searchResult.data[0].info.identifier
        }
      }

      if (/^[a-zA-Z0-9]{22}$/.test(trackId)) {
        try {
          const { body: rjson, statusCode } = await http1makeRequest(
            `${SPOTIFY_CLIENT_API_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${trackId}?response-format=json`,
            {
              headers: { Authorization: `Bearer ${token}` },
              disableBodyCompression: true
            }
          )

          if (statusCode === 200 && rjson?.mediaItems?.length > 0) {
            const playlistId = rjson.mediaItems[0].uri.split(':')[2]
            return this._resolvePlaylist(playlistId)
          }
        } catch (e) {
          logger('debug', 'Spotify', `inspiredby-mix failed: ${e.message}`)
        }

        const data = await this._internalApiRequest(QUERIES.getRecommendations, {
          uri: `spotify:track:${trackId}`,
          limit: 20
        })

        const items = data?.internalLinkRecommenderTrack?.items || data?.seoRecommendedTrack?.items
        if (items?.length > 0) {
          const tracks = items
            .map((it) => this._buildTrackFromInternal(it.content?.data || it.data))
            .filter(Boolean)

          return {
            loadType: 'playlist',
            data: {
              info: { name: 'Spotify Recommendations', selectedTrack: 0 },
              pluginInfo: { type: 'recommendations' },
              tracks
            }
          }
        }
      }

      if (query.startsWith('mix:') || (!query.includes('=') && !query.includes(':'))) {
        let seedType = 'track'
        let seed = query

        if (query.startsWith('mix:')) {
          const mixMatch = query.match(
            /^mix:(track|artist|album|isrc):([^:]+)$/
          )
          if (mixMatch) {
            seedType = mixMatch[1]
            seed = mixMatch[2]
          }
        }

        if (
          seedType === 'isrc' ||
          (seedType === 'track' &&
            (seed.includes(' ') || !/^[a-zA-Z0-9]{22}$/.test(seed)))
        ) {
          const searchResult = await this.search(
            seedType === 'isrc' ? `isrc:${seed}` : seed,
            'spsearch',
            'track'
          )
          if (
            searchResult.loadType === 'search' &&
            searchResult.data.length > 0
          ) {
            seed = searchResult.data[0].info.identifier
            seedType = 'track'
          } else {
            return { loadType: 'empty', data: {} }
          }
        }

        const { body: rjson, statusCode } = await http1makeRequest(
          `${SPOTIFY_CLIENT_API_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:${seedType}:${seed}?response-format=json`,
          {
            headers: { Authorization: `Bearer ${token}` },
            disableBodyCompression: true
          }
        )

        if (statusCode === 200 && rjson?.mediaItems?.length > 0) {
          const playlistId = rjson.mediaItems[0].uri.split(':')[2]
          return this._resolvePlaylist(playlistId)
        }

        if (query.startsWith('mix:')) return { loadType: 'empty', data: {} }
      }

      if (this.accessToken) {
        const data = await this._apiRequest(
          `/recommendations?${query.includes('=') ? query : `seed_tracks=${query}`}`
        )
        if (data?.tracks?.length > 0) {
          const tracks = data.tracks
            .map((item) => this._buildTrack(item))
            .filter(Boolean)
          return {
            loadType: 'playlist',
            data: {
              info: { name: 'Spotify Recommendations', selectedTrack: 0 },
              pluginInfo: { type: 'recommendations' },
              tracks
            }
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
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
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/album/${item.id}`,
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
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/playlist/${item.id}`,
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
          uri:
            item.external_urls?.spotify ||
            `https://open.spotify.com/artist/${item.id}`,
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
    if (this.externalAuthUrl || this.anonymousToken) {
      const data = await this._internalApiRequest(QUERIES.getTrack, {
        uri: `spotify:track:${id}`
      })
      if (data?.trackUnion && data.trackUnion.__typename !== 'NotFound') {
        const track = this._buildTrackFromInternal(data.trackUnion)

        if (this.mobileToken && track) {
          const cachedCanvas = this.nodelink.trackCacheManager.get('spotify-canvas', id)
          if (cachedCanvas) {
            track.pluginInfo.canvas = cachedCanvas
          } else {
            const canvasRes = await fetchCanvas(
              `spotify:track:${id}`,
              this.mobileToken
            )
            if (canvasRes?.data?.canvasesList?.[0]) {
              track.pluginInfo.canvas = canvasRes.data
              this.nodelink.trackCacheManager.set('spotify-canvas', id, canvasRes.data, 1000 * 60 * 60 * 12)
            }
          }
        }

        if (!track.info.isrc) {
          const metadata = await this._fetchTrackMetadata(id)
          if (metadata) {
            const isrc = metadata.external_id?.find((e) => e.type === 'isrc')?.id
            if (isrc) {
              track.info.isrc = isrc
              track.encoded = encodeTrack(track.info)
            }
          }
        }

        return {
          loadType: 'track',
          data: track
        }
      } else {
        // GraphQL failed, try metadata endpoint as primary fallback
        const metadata = await this._fetchTrackMetadata(id)
        const track = this._buildTrackFromMetadata(metadata)
        if (track) {
          return {
            loadType: 'track',
            data: track
          }
        }
      }
    }

    if (this.clientId && this.clientSecret) {
      const data = await this._apiRequest(`/tracks/${id}?market=${this.market}`)
      if (data) {
        const track = this._buildTrack(data)

        if (this.mobileToken && track) {
          const cachedCanvas = this.nodelink.trackCacheManager.get('spotify-canvas', id)
          if (cachedCanvas) {
            track.pluginInfo.canvas = cachedCanvas
          } else {
            const canvasRes = await fetchCanvas(
              `spotify:track:${id}`,
              this.mobileToken
            )
            if (canvasRes?.data?.canvasesList?.[0]) {
              track.pluginInfo.canvas = canvasRes.data
              this.nodelink.trackCacheManager.set('spotify-canvas', id, canvasRes.data, 1000 * 60 * 60 * 12)
            }
          }
        }

        if (!track.info.isrc) {
          const metadata = await this._fetchTrackMetadata(id)
          if (metadata) {
            const isrc = metadata.external_id?.find((e) => e.type === 'isrc')?.id
            if (isrc) {
              track.info.isrc = isrc
              track.encoded = encodeTrack(track.info)
            }
          }
        }

        return { loadType: 'track', data: track }
      }
    }

    return { loadType: 'empty', data: {} }
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
    const isAutogenerated = id.startsWith('37i9dQZF') || id.startsWith('37i9dQZE')

    if (this.externalAuthUrl || isAutogenerated) {
      const data = await this._internalApiRequest(QUERIES.getPlaylist, {
        uri: `spotify:playlist:${id}`,
        offset: 0,
        limit: 100,
        enableWatchFeedEntrypoint: false
      })

      if (data?.playlistV2 && data.playlistV2.__typename !== 'NotFound') {
        const allItems = [...(data.playlistV2.content?.items || [])]
        const totalTracks = data.playlistV2.content?.totalCount || allItems.length

        if (totalTracks > 100) {
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
        }

        const trackIds = allItems
          .map((it) => it.itemV2?.data?.uri?.split(':').pop())
          .filter(Boolean)

        let tracks = []
        const hasOfficial = this.clientId && this.clientSecret

        if (hasOfficial && trackIds.length > 0) {
          const fullTracks = await this._fetchFullTracks(trackIds)
          if (fullTracks.length > 0) {
            tracks = fullTracks
              .map((t) => this._buildTrack(t))
              .filter(Boolean)
          }
        }

        if (tracks.length === 0) {
          tracks = allItems
            .map((item) => this._buildTrackFromInternal(item.itemV2?.data))
            .filter(Boolean)
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: data.playlistV2.name, selectedTrack: 0 },
            tracks
          }
        }
      }

      if (isAutogenerated && !this.externalAuthUrl) {
        return {
          exception: {
            message: 'Autogenerated playlists require externalAuthUrl to be configured.',
            severity: 'common'
          }
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

    const searchQuery = this._buildSearchQuery(decodedTrack, isExplicit)

    try {
      let searchResult
      if (decodedTrack.isrc) {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          `"${decodedTrack.isrc}"`,
          'ytmsearch'
        )
        if (
          searchResult.loadType !== 'search' ||
          searchResult.data.length === 0
        ) {
          searchResult = await this.nodelink.sources.search(
            'youtube',
            searchQuery,
            'ytmsearch'
          )
        }
      } else {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          searchQuery,
          'ytmsearch'
        )
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        searchResult =
          await this.nodelink.sources.searchWithDefault(searchQuery)
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
      logger(
        'warn',
        'Spotify',
        `Search for "${searchQuery}" failed: ${e.message}`
      )
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
