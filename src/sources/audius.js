import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const AUDIUS_API_BASE = 'https://discoveryprovider.audius.co'
const TRACK_URL_PATTERN =
  /^https?:\/\/(?:www\.)?audius\.co\/([^/]+)\/([^/?#]+)(?:\?.*)?$/i
const PLAYLIST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?audius\.co\/([^/]+)\/playlist\/([^/?#]+)(?:\?.*)?$/i
const ALBUM_URL_PATTERN =
  /^https?:\/\/(?:www\.)?audius\.co\/([^/]+)\/album\/([^/?#]+)(?:\?.*)?$/i
const USER_URL_PATTERN =
  /^https?:\/\/(?:www\.)?audius\.co\/([^/?#]+)(?:\?.*)?$/i

const ARTWORK_SIZES = ['480x480', '1000x1000', '150x150']

export default class AudiusSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['ausearch']
    this.patterns = [
      TRACK_URL_PATTERN,
      PLAYLIST_URL_PATTERN,
      ALBUM_URL_PATTERN,
      USER_URL_PATTERN
    ]
    this.priority = 90
    this.appName = null
    this.apiKey = null
    this.apiSecret = null
    this.playlistLoadLimit = 100
    this.albumLoadLimit = 100
  }

  async setup() {
    try {
      const audiusConfig = this.config.sources.audius || {}

      this.appName = audiusConfig.appName
      this.apiKey = audiusConfig.apiKey
      this.apiSecret = audiusConfig.apiSecret
      this.playlistLoadLimit = audiusConfig.playlistLoadLimit ?? 100
      this.albumLoadLimit = audiusConfig.albumLoadLimit ?? 100

      logger('info', 'Audius', 'Source initialized successfully')
      return true
    } catch (e) {
      logger('error', 'Audius', `Error initializing Audius: ${e.message}`)
      return false
    }
  }

  async _apiRequest(endpoint) {
    try {
      const url = endpoint.startsWith('http')
        ? endpoint
        : `${AUDIUS_API_BASE}${endpoint}`
      const urlObj = new URL(url)

      if (this.appName) urlObj.searchParams.set('app_name', this.appName)
      if (this.apiKey) urlObj.searchParams.set('apiKey', this.apiKey)

      const { body, statusCode } = await http1makeRequest(urlObj.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Nodelink'
        }
      })

      if (statusCode !== 200) {
        logger('error', 'Audius', `API error: ${statusCode}`)
        return null
      }

      return body?.data || body
    } catch (e) {
      logger('error', 'Audius', `Error in Audius apiRequest: ${e.message}`)
      return null
    }
  }

  _getArtworkUrl(artwork) {
    if (!artwork) return null

    if (typeof artwork === 'string' && artwork.trim()) {
      return artwork.startsWith('/') ? `https://audius.co${artwork}` : artwork
    }

    if (typeof artwork === 'object') {
      for (const size of ARTWORK_SIZES) {
        if (artwork[size]) {
          const url = artwork[size]
          return url.startsWith('/') ? `https://audius.co${url}` : url
        }
      }
    }

    return null
  }

  _buildTrack(trackData) {
    if (!trackData?.id || !trackData?.title) return null

    const trackInfo = {
      identifier: trackData.id,
      isSeekable: true,
      author: trackData.user?.name || 'Unknown',
      length: (trackData.duration || 0) * 1000,
      isStream: false,
      position: 0,
      title: trackData.title,
      uri: trackData.permalink
        ? `https://audius.co${trackData.permalink}`
        : `https://audius.co/track/${trackData.id}`,
      artworkUrl: this._getArtworkUrl(trackData.artwork),
      isrc: null,
      sourceName: 'audius'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  _normalizeData(data) {
    return Array.isArray(data) ? data : [data]
  }

  _createEmptyResponse() {
    return { loadType: 'empty', data: {} }
  }

  _createExceptionResponse(message, severity = 'fault') {
    return { exception: { message, severity } }
  }

  async search(query, sourceTerm, searchType = 'track') {
    try {
      const limit = this.config.maxSearchResults || 10
      const endpoint = `/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}`
      const data = await this._apiRequest(endpoint)

      if (!data || (Array.isArray(data) && data.length === 0)) {
        return this._createEmptyResponse()
      }

      const tracks = this._normalizeData(data)
        .map((item) => this._buildTrack(item))
        .filter(Boolean)

      if (tracks.length === 0) {
        return this._createEmptyResponse()
      }

      return { loadType: 'search', data: tracks }
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async resolve(url) {
    try {
      const resolvers = [
        {
          pattern: PLAYLIST_URL_PATTERN,
          method: this._resolvePlaylist.bind(this)
        },
        { pattern: ALBUM_URL_PATTERN, method: this._resolveAlbum.bind(this) },
        { pattern: TRACK_URL_PATTERN, method: this._resolveTrack.bind(this) },
        { pattern: USER_URL_PATTERN, method: this._resolveArtist.bind(this) }
      ]

      for (const { pattern, method } of resolvers) {
        const match = pattern.exec(url)
        if (match) {
          const params = match.slice(1).map(decodeURIComponent)
          return await method(...params)
        }
      }

      return this._createEmptyResponse()
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async _resolveTrack(artist, trackSlug) {
    try {
      const searchEndpoint = `/v1/tracks/search?query=${encodeURIComponent(`${artist} ${trackSlug}`)}&limit=10`
      const data = await this._apiRequest(searchEndpoint)

      if (!data || (Array.isArray(data) && data.length === 0)) {
        return this._createExceptionResponse('Track not found.', 'common')
      }

      const items = this._normalizeData(data)
      const expectedPath = `/${artist}/${trackSlug}`.toLowerCase()

      for (const item of items) {
        const permalink = item.permalink
        if (permalink && item.user?.handle) {
          const lowerPermalink = permalink.toLowerCase()
          if (
            lowerPermalink === expectedPath ||
            lowerPermalink.endsWith(`/${trackSlug.toLowerCase()}`)
          ) {
            const track = this._buildTrack(item)
            return track
              ? { loadType: 'track', data: track }
              : this._createEmptyResponse()
          }
        }
      }

      const track = this._buildTrack(items[0])
      return track
        ? { loadType: 'track', data: track }
        : this._createEmptyResponse()
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async _resolvePlaylist(artist, playlistSlug) {
    try {
      const playlistData = await this._findPlaylistBySlug(artist, playlistSlug)
      if (!playlistData?.id) {
        return this._createExceptionResponse('Playlist not found.', 'common')
      }

      const tracks = await this._loadPlaylistTracks(
        playlistData.id,
        this.playlistLoadLimit
      )
      if (tracks.length === 0) {
        return this._createExceptionResponse(
          'Playlist has no valid tracks.',
          'common'
        )
      }

      logger(
        'info',
        'Audius',
        `Loaded ${tracks.length} tracks from playlist "${playlistData.playlist_name || 'Unknown'}".`
      )

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: playlistData.playlist_name || 'Audius Playlist',
            selectedTrack: 0
          },
          pluginInfo: {
            type: 'playlist',
            url: `https://audius.co/${artist}/playlist/${playlistSlug}`,
            artworkUrl: this._getArtworkUrl(playlistData.artwork),
            author: playlistData.user?.name
          },
          tracks
        }
      }
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async _resolveAlbum(artist, albumSlug) {
    try {
      const albumData = await this._findAlbumBySlug(artist, albumSlug)
      if (!albumData?.id) {
        return this._createExceptionResponse('Album not found.', 'common')
      }

      const tracks = await this._loadPlaylistTracks(
        albumData.id,
        this.albumLoadLimit
      )
      if (tracks.length === 0) {
        return this._createExceptionResponse(
          'Album has no valid tracks.',
          'common'
        )
      }

      logger(
        'info',
        'Audius',
        `Loaded ${tracks.length} tracks from album "${albumData.playlist_name || 'Unknown'}".`
      )

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: albumData.playlist_name || 'Audius Album',
            selectedTrack: 0
          },
          pluginInfo: {
            type: 'album',
            url: `https://audius.co/${artist}/album/${albumSlug}`,
            artworkUrl: this._getArtworkUrl(albumData.artwork),
            author: albumData.user?.name
          },
          tracks
        }
      }
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async _resolveArtist(artist) {
    try {
      const userSearchEndpoint = `/v1/users/search?query=${encodeURIComponent(artist)}&limit=1`
      const userData = await this._apiRequest(userSearchEndpoint)

      if (!userData || (Array.isArray(userData) && userData.length === 0)) {
        return this._createExceptionResponse('Artist not found.', 'common')
      }

      const user = Array.isArray(userData) ? userData[0] : userData
      if (!user.id) {
        return this._createExceptionResponse('Artist not found.', 'common')
      }

      const tracksEndpoint = `/v1/users/${user.id}/tracks?limit=50`
      const tracksData = await this._apiRequest(tracksEndpoint)

      if (
        !tracksData ||
        (Array.isArray(tracksData) && tracksData.length === 0)
      ) {
        return this._createExceptionResponse('Artist has no tracks.', 'common')
      }

      const tracks = this._normalizeData(tracksData)
        .map((item) => this._buildTrack(item))
        .filter(Boolean)

      if (tracks.length === 0) {
        return this._createExceptionResponse(
          'Artist has no valid tracks.',
          'common'
        )
      }

      logger(
        'info',
        'Audius',
        `Loaded ${tracks.length} tracks from artist "${user.name || artist}".`
      )

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: `${user.name || artist}'s Tracks`,
            selectedTrack: 0
          },
          pluginInfo: {
            type: 'artist',
            url: `https://audius.co/${artist}`,
            artworkUrl: this._getArtworkUrl(user.profile_picture),
            author: user.name
          },
          tracks
        }
      }
    } catch (e) {
      return this._createExceptionResponse(e.message)
    }
  }

  async _findPlaylistBySlug(artist, playlistSlug) {
    const searchEndpoint = `/v1/playlists/search?query=${encodeURIComponent(`${artist} ${playlistSlug}`)}&limit=10`
    const searchData = await this._apiRequest(searchEndpoint)

    if (!searchData || (Array.isArray(searchData) && searchData.length === 0)) {
      return null
    }

    const playlists = this._normalizeData(searchData)
    const slugLower = playlistSlug.toLowerCase()

    for (const playlist of playlists) {
      if (playlist.permalink?.toLowerCase().includes(slugLower)) {
        return playlist
      }
    }

    return playlists[0] || null
  }

  async _findAlbumBySlug(artist, albumSlug) {
    const searchEndpoint = `/v1/playlists/search?query=${encodeURIComponent(`${artist} ${albumSlug}`)}&limit=10`
    const searchData = await this._apiRequest(searchEndpoint)

    if (!searchData || (Array.isArray(searchData) && searchData.length === 0)) {
      return null
    }

    const playlists = this._normalizeData(searchData)
    const slugLower = albumSlug.toLowerCase()

    for (const playlist of playlists) {
      if (
        playlist.is_album &&
        playlist.permalink?.toLowerCase().includes(slugLower)
      ) {
        return playlist
      }
    }

    for (const playlist of playlists) {
      if (playlist.permalink?.toLowerCase().includes(slugLower)) {
        return playlist
      }
    }

    return null
  }

  async _loadPlaylistTracks(playlistId, limit) {
    const tracksEndpoint = `/v1/playlists/${playlistId}/tracks?limit=${limit}`
    const tracksData = await this._apiRequest(tracksEndpoint)

    if (!tracksData || (Array.isArray(tracksData) && tracksData.length === 0)) {
      return []
    }

    return this._normalizeData(tracksData)
      .map((item) => this._buildTrack(item))
      .filter(Boolean)
  }

  async getTrackUrl(decodedTrack, itag) {
    try {
      logger(
        'debug',
        'Audius',
        `Getting track URL for track ID: ${decodedTrack.identifier}`
      )

      if (!decodedTrack.identifier) {
        logger('error', 'Audius', 'No track identifier provided')
        return {
          exception: {
            message: 'No track identifier provided',
            severity: 'fault',
            cause: 'MISSING_IDENTIFIER'
          }
        }
      }

      const streamUrl = this._getStreamUrl(decodedTrack.identifier)

      if (!streamUrl) {
        logger(
          'error',
          'Audius',
          `Failed to get stream URL for track ${decodedTrack.identifier}`
        )
        return {
          exception: {
            message: 'Failed to get stream URL for Audius track.',
            severity: 'fault',
            cause: 'Unknown'
          }
        }
      }

      logger(
        'info',
        'Audius',
        `Successfully got stream URL for track ${decodedTrack.identifier}`
      )

      return {
        url: streamUrl,
        protocol: 'http',
        format: 'mp3',
        additionalData: {}
      }
    } catch (e) {
      logger('error', 'Audius', `Error in getTrackUrl: ${e.message}`)
      return {
        exception: {
          message: e.message || 'Unknown error getting track URL',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
  }

  _getStreamUrl(trackId) {
    try {
      const url = new URL(`${AUDIUS_API_BASE}/v1/tracks/${trackId}/stream`)

      if (this.appName) url.searchParams.set('app_name', this.appName)
      if (this.apiKey) url.searchParams.set('apiKey', this.apiKey)

      const streamUrl = url.toString()
      logger(
        'debug',
        'Audius',
        `Built stream URL for track ${trackId}: ${streamUrl}`
      )

      return streamUrl
    } catch (e) {
      logger('error', 'Audius', `Error building stream URL: ${e.message}`)
      return null
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    try {
      logger('debug', 'Audius', `Loading stream from URL: ${url}`)

      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error) throw response.error

      const contentType = response.headers?.['content-type'] || 'audio/mpeg'
      const httpStream = response.stream

      httpStream.on('end', () => {
        logger(
          'debug',
          'Audius',
          `Stream ended for ${url}, emitting finishBuffering.`
        )
        httpStream.emit('finishBuffering')
      })

      httpStream.on('error', (err) => {
        logger('error', 'Audius', `Stream error: ${err.message}`)
      })

      return {
        stream: httpStream,
        type: contentType
      }
    } catch (e) {
      logger('error', 'Audius', `Error loading stream: ${e.message}`)
      return {
        exception: {
          message: e.message,
          severity: 'fault',
          cause: 'STREAM_ERROR'
        }
      }
    }
  }
}
