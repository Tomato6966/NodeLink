import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'

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
    this.clientId = null
    this.clientSecret = null
    this.playlistLoadLimit = 0
    this.playlistPageLoadConcurrency = 5
    this.albumLoadLimit = 0
    this.albumPageLoadConcurrency = 5
    this.market = 'US'
    this.tokenInitialized = false
    this.allowExplicit = true
  }

  async setup() {
    if (this.tokenInitialized) return true

    try {
      this.clientId = this.config.sources.spotify?.clientId
      this.clientSecret = this.config.sources.spotify?.clientSecret
      this.playlistLoadLimit =
        this.config.sources.spotify?.playlistLoadLimit ?? 0
      this.playlistPageLoadConcurrency =
        this.config.sources.spotify?.playlistPageLoadConcurrency ?? 5
      this.albumLoadLimit = this.config.sources.spotify?.albumLoadLimit ?? 0
      this.albumPageLoadConcurrency =
        this.config.sources.spotify?.albumPageLoadConcurrency ?? 5
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
          `Error initializing token: ${statusCode} - ${error?.message || 'Unknown error'}`
        )
        return false
      }

      this.accessToken = tokenData.access_token
      this.tokenInitialized = true
      logger(
        'info',
        'Spotify',
        `Tokens initialized successfully (playlistLoadLimit: ${this.playlistLoadLimit === 0 ? 'unlimited' : `${this.playlistLoadLimit * 100} tracks max`}, albumLoadLimit: ${this.albumLoadLimit === 0 ? 'unlimited' : `${this.albumLoadLimit * 50} tracks max`})`
      )
      return true
    } catch (e) {
      logger(
        'error',
        'Spotify',
        `Error initializing Spotify tokens: ${e.message}`
      )
      return false
    }
  }

  async _apiRequest(path) {
    if (!this.tokenInitialized) {
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

  buildTrack(item, artworkUrl = null) {
    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: item.artists?.map((a) => a.name).join(', ') || 'Unknown',
      length: item.duration_ms,
      isStream: false,
      position: 0,
      title: item.name,
      uri: `${item.external_urls.spotify}?explicit=${item.explicit}`,
      artworkUrl: artworkUrl || item.album?.images[0]?.url,
      isrc: item.external_ids?.isrc || null,
      sourceName: 'spotify'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
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

      const tracks = data.tracks.items.map((item) => this.buildTrack(item))

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
        case 'track': {
          const data = await this._apiRequest(`/tracks/${id}`)
          if (!data)
            return {
              exception: { message: 'Track not found.', severity: 'common' }
            }
          return { loadType: 'track', data: this.buildTrack(data) }
        }

        case 'album': {
          const albumData = await this._apiRequest(`/albums/${id}`)
          if (!albumData)
            return {
              exception: { message: 'Album not found.', severity: 'common' }
            }

          const allItems = []
          if (albumData.tracks && Array.isArray(albumData.tracks.items)) {
            allItems.push(...albumData.tracks.items)
          }

          const totalTracks = albumData.tracks.total
          const limit = 50
          let pagesToFetch = Math.ceil(totalTracks / limit)

          if (this.albumLoadLimit > 0) {
            pagesToFetch = Math.min(pagesToFetch, this.albumLoadLimit)
          }

          const promises = []
          for (let i = 1; i < pagesToFetch; i++) {
            const offset = i * limit
            promises.push(
              this._apiRequest(
                `/albums/${id}/tracks?offset=${offset}&limit=${limit}`
              )
            )
          }

          if (promises.length > 0) {
            const batchSize = this.albumPageLoadConcurrency
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
                  `Failed to fetch a batch of album pages: ${e.message}`
                )
              }
            }
          }

          const tracks = allItems
            .map((item) => {
              if (!item || !item.id) return null
              return this.buildTrack(item, albumData.images[0]?.url)
            })
            .filter(Boolean)

          logger(
            'info',
            'Spotify',
            `Loaded ${tracks.length} of ${totalTracks} tracks from album "${albumData.name}".`
          )

          return {
            loadType: 'album',
            data: { info: { name: albumData.name, selectedTrack: 0 }, tracks }
          }
        }

        case 'playlist': {
          const fields =
            'name,tracks(items(track(id,name,artists,duration_ms,external_urls,external_ids,album(images))),total)'
          const playlistData = await this._apiRequest(
            `/playlists/${id}?fields=${fields}`
          )
          if (!playlistData)
            return {
              exception: { message: 'Playlist not found.', severity: 'common' }
            }

          const allItems = []
          if (playlistData.tracks && Array.isArray(playlistData.tracks.items)) {
            allItems.push(...playlistData.tracks.items)
          }

          const totalTracks = playlistData.tracks.total
          const limit = 100
          let pagesToFetch = Math.ceil(totalTracks / limit)

          if (this.playlistLoadLimit > 0) {
            pagesToFetch = Math.min(pagesToFetch, this.playlistLoadLimit)
          }

          const promises = []
          for (let i = 1; i < pagesToFetch; i++) {
            const offset = i * limit
            promises.push(
              this._apiRequest(
                `/playlists/${id}/tracks?offset=${offset}&limit=${limit}&fields=items(track(id,name,artists,duration_ms,external_urls,external_ids,album(images)))`
              )
            )
          }

          if (promises.length > 0) {
            const batchSize = this.playlistPageLoadConcurrency
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
                  `Failed to fetch a batch of playlist pages: ${e.message}`
                )
              }
            }
          }

          const tracks = allItems
            .map((item) => {
              const t = item.track || item
              if (!t || !t.id) return null
              return this.buildTrack(t)
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

        case 'artist': {
          const artist = await this._apiRequest(`/artists/${id}`)
          if (!artist)
            return {
              exception: { message: 'Artist not found.', severity: 'common' }
            }

          const topTracks = await this._apiRequest(
            `/artists/${id}/top-tracks?market=${this.market}`
          )
          if (!topTracks)
            return {
              exception: {
                message: 'Failed to get artist top tracks.',
                severity: 'common'
              }
            }

          const tracks = topTracks.tracks.map((item) =>
            this.buildTrack(item, artist.images[0]?.url)
          )
          return {
            loadType: 'artist',
            data: {
              info: { name: `${artist.name}'s Top Tracks`, selectedTrack: 0 },
              tracks
            }
          }
        }

        case 'episode':
        case 'show': {
          return {
            exception: {
              message: 'This source does not support episodes or shows.',
              severity: 'common'
            }
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

  async getTrackUrl(decodedTrack) {
    const isExplicit =
      new URL(decodedTrack.uri).searchParams.get('explicit') === 'true'

    const spotifyDuration = decodedTrack.length

    let query = `${decodedTrack.title} ${decodedTrack.author}`

    if (isExplicit) {
      if (this.allowExplicit) {
        logger(
          'info',
          'Spotify',
          `Searching for explicit version of song "${decodedTrack.title}"`
        )
        query += ' explicit lyrical'
      } else {
        logger(
          'info',
          'Spotify',
          `Searching for non explicit version of song "${decodedTrack.title}"`
        )
        query += ' clean non explicit lyrical'
      }
    } else {
      query += ' official lyrical audio'
    }

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

      let bestMatch = null
      let minDurationDiff = Number.POSITIVE_INFINITY

      for (const ytTrack of searchResult.data) {
        const ytDuration = ytTrack.info.length
        const durationDifference = Math.abs(ytDuration - spotifyDuration)
        const allowedDeviation = spotifyDuration * 0.15
        if (durationDifference > allowedDeviation) continue
        if (durationDifference < minDurationDiff) {
          minDurationDiff = durationDifference
          bestMatch = ytTrack
        }
      }

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
}
