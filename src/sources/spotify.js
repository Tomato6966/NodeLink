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

    this.accessToken = null
    this.clientId = null
    this.clientSecret = null
    this.tokenInitialized = false
  }

  async setup() {
    if (this.tokenInitialized) return true

    try {
      this.clientId = this.config.sources.spotify?.clientId
      this.clientSecret = this.config.sources.spotify?.clientSecret

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
      logger('info', 'Spotify', 'Tokens initialized successfully')
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
      if (!success) {
        throw new Error('Failed to initialize Spotify for API request.')
      }
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
      uri: item.external_urls.spotify,
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
        `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=US`
      )

      if (!data || data.error) {
        return {
          loadType: 'error',
          data: {
            message: data?.error?.message || 'Search failed on Spotify.',
            severity: 'common'
          }
        }
      }

      if (!data.tracks || data.tracks.items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = data.tracks.items.map((item) => this.buildTrack(item))

      return { loadType: 'search', data: tracks }
    } catch (e) {
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
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
              loadType: 'error',
              data: { message: 'Track not found.', severity: 'common' }
            }
          return { loadType: 'track', data: this.buildTrack(data) }
        }
        case 'album': {
          const data = await this._apiRequest(`/albums/${id}`)
          if (!data)
            return {
              loadType: 'error',
              data: { message: 'Album not found.', severity: 'common' }
            }

          const tracks = data.tracks.items.map((item) =>
            this.buildTrack(item, data.images[0]?.url)
          )
          return {
            loadType: 'album',
            data: { info: { name: data.name, selectedTrack: 0 }, tracks }
          }
        }
        case 'playlist': {
          const data = await this._apiRequest(`/playlists/${id}`)
          if (!data)
            return {
              loadType: 'error',
              data: { message: 'Playlist not found.', severity: 'common' }
            }

          const tracks = data.tracks.items.map((item) =>
            this.buildTrack(item.track)
          )
          return {
            loadType: 'playlist',
            data: { info: { name: data.name, selectedTrack: 0 }, tracks }
          }
        }
        case 'artist': {
          const artist = await this._apiRequest(`/artists/${id}`)
          if (!artist)
            return {
              loadType: 'error',
              data: { message: 'Artist not found.', severity: 'common' }
            }

          const topTracks = await this._apiRequest(
            `/artists/${id}/top-tracks?market=US`
          )
          if (!topTracks)
            return {
              loadType: 'error',
              data: {
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
              info: { name: `${artist.name}\'s Top Tracks`, selectedTrack: 0 },
              tracks
            }
          }
        }
        case 'episode':
        case 'show': {
          return {
            loadType: 'error',
            data: {
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
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    const spotifyTitle = decodedTrack.title.toLowerCase();
    const spotifyAuthor = decodedTrack.author.toLowerCase();
    const spotifyDuration = decodedTrack.length;

    const query = `${decodedTrack.title} ${decodedTrack.author} official audio`;

    try {
      const searchResult = await this.nodelink.sources.searchWithDefault(query);

      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        return { exception: { message: 'No alternative stream found via default search.', severity: 'fault' } };
      }

      let bestMatch = null;
      let minDurationDiff = Infinity;

      for (const ytTrack of searchResult.data) {
        const ytTitle = ytTrack.info.title.toLowerCase();
        const ytDuration = ytTrack.info.length;

        const durationDifference = Math.abs(ytDuration - spotifyDuration);
        const allowedDeviation = spotifyDuration * 0.15;

        if (durationDifference > allowedDeviation) {
          continue;
        }

        if (durationDifference < minDurationDiff) {
          minDurationDiff = durationDifference;
          bestMatch = ytTrack;
        }
      }

      if (!bestMatch) {
        return { exception: { message: 'No suitable alternative stream found after filtering.', severity: 'fault' } };
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info);
      return { newTrack: bestMatch, ...streamInfo };

    } catch (e) {
      logger('warn', 'Spotify', `Search for "${query}" failed: ${e.message}`);
      return { exception: { message: e.message, severity: 'fault' } };
    }
  }
}
