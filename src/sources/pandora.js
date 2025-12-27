import { encodeTrack, http1makeRequest, logger, makeRequest, getBestMatch } from '../utils.js'

export default class PandoraSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['pdsearch']
    this.patterns = [
      /^https?:\/\/(?:www\.)?pandora\.com\/(?:playlist|station|podcast|artist)\/.+/
    ]
    this.priority = 80
    this.csrfTokenConfig = this.config.sources?.pandora?.csrfToken || null
    this.csrfToken = null
    this.authToken = null
    this.setupPromise = null
  }

  async setup() {
    if (this.authToken) return true
    if (this.setupPromise) return this.setupPromise

    this.setupPromise = (async () => {
      try {
        const cachedAuth = this.nodelink.credentialManager.get('pandora_auth_token')
        const cachedCsrf = this.nodelink.credentialManager.get('pandora_csrf_token')

        if (cachedAuth && cachedCsrf) {
          this.authToken = cachedAuth
          this.csrfToken = cachedCsrf
          logger('info', 'Pandora', 'Loaded Pandora credentials from CredentialManager.')
          return true
        }

        logger('debug', 'Pandora', 'Setting Pandora auth and CSRF token.')

        let csrfTokenValue = this.csrfTokenConfig
        const remoteUrl = this.config.sources?.pandora?.remoteTokenUrl

        if (remoteUrl) {
          logger('info', 'Pandora', `Fetching tokens from remote provider: ${remoteUrl}`)
          try {
            const { body, error, statusCode } = await makeRequest(remoteUrl, { method: 'GET' })
            if (!error && statusCode === 200 && body.success && body.authToken && body.csrfToken) {
              this.authToken = body.authToken
              this.csrfToken = {
                raw: `csrftoken=${body.csrfToken};Path=/;Domain=.pandora.com;Secure`,
                parsed: body.csrfToken
              }

              const cacheTtlMs = (body.expires_in_seconds || 3600) * 1000
              this.nodelink.credentialManager.set('pandora_auth_token', this.authToken, cacheTtlMs)
              this.nodelink.credentialManager.set('pandora_csrf_token', this.csrfToken, cacheTtlMs)

              logger('info', 'Pandora', 'Successfully initialized with remote tokens (bypass active).')
              return true
            }
            logger('warn', 'Pandora', `Remote provider failed (Status: ${statusCode}). Falling back to local login.`)
          } catch (e) {
            logger('warn', 'Pandora', `Exception during remote token fetch: ${e.message}. Falling back to local login.`)
          }
        }

        if (csrfTokenValue) {
          this.csrfToken = {
            raw: `csrftoken=${csrfTokenValue};Path=/;Domain=.pandora.com;Secure`,
            parsed: csrfTokenValue
          }
        } else {
          const pandoraRequest = await makeRequest('https://www.pandora.com', {
            method: 'HEAD'
          })

          if (pandoraRequest.error) {
            logger('error', 'Pandora', 'Failed to set CSRF token from Pandora.')
            return false
          }

          const cookies = pandoraRequest.headers['set-cookie']
          const csrfCookie = cookies ? cookies.find((cookie) => cookie.startsWith('csrftoken=')) : null

          if (!csrfCookie) {
            logger('error', 'Pandora', 'Failed to find CSRF token cookie.')
            return false
          }

          const csrfMatch = /csrftoken=([a-f0-9]{16})/.exec(csrfCookie)
          if (!csrfMatch) {
            logger('error', 'Pandora', 'Failed to parse CSRF token.')
            return false
          }

          this.csrfToken = {
            raw: csrfCookie.split(';')[0],
            parsed: csrfMatch[1]
          }
        }

        const tokenRequest = await makeRequest(
          'https://www.pandora.com/api/v1/auth/anonymousLogin',
          {
            headers: {
              Cookie: this.csrfToken.raw,
              'Content-Type': 'application/json',
              Accept: '*/*',
              'X-CsrfToken': this.csrfToken.parsed
            },
            method: 'POST'
          }
        )

        if (tokenRequest.error || tokenRequest.body.errorCode === 0) {
          logger('error', 'Pandora', 'Failed to set auth token from Pandora.')
          return false
        }

        this.authToken = tokenRequest.body.authToken

        this.nodelink.credentialManager.set('pandora_auth_token', this.authToken, 24 * 60 * 60 * 1000)
        this.nodelink.credentialManager.set('pandora_csrf_token', this.csrfToken, 24 * 60 * 60 * 1000)

        logger('info', 'Pandora', 'Successfully set Pandora auth and CSRF token.')
        return true
      } catch (e) {
        logger('error', 'Pandora', `Setup failed: ${e.message}`)
        return false
      } finally {
        this.setupPromise = null
      }
    })()

    return this.setupPromise
  }

  async search(query) {
    const authError = await this._ensureAuth()
    if (authError) return authError

    logger('debug', 'Pandora', `Searching for: ${query}`)

    const body = {
      query,
      types: ['TR'],
      listener: null,
      start: 0,
      count: this.config.maxSearchResults || 10,
      annotate: true,
      searchTime: 0,
      annotationRecipe: 'CLASS_OF_2019'
    }

    const { body: data, error } = await makeRequest(
      'https://www.pandora.com/api/v3/sod/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*'
        },
        body,
        disableBodyCompression: true
      }
    )

    if (error) {
      return this._buildException(error)
    }

    if (!data.results || data.results.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks = []
    const annotationKeys = Object.keys(data.annotations)

    for (const key of annotationKeys) {
      if (data.annotations[key].type === 'TR') {
        const item = data.annotations[key]
        tracks.push(this.buildTrack(item))
      }
    }

    return { loadType: 'search', data: tracks }
  }

  async resolve(url) {
    const authError = await this._ensureAuth()
    if (authError) return authError

    const typeMatch = /^(https:\/\/www\.pandora\.com\/)((playlist)|(station)|(podcast)|(artist))\/.+/.exec(url)

    if (!typeMatch) {
      return { loadType: 'empty', data: {} }
    }

    const type = typeMatch[2]
    const lastPart = url.split('/').pop()

    logger('debug', 'Pandora', `Resolving ${type} with ID: ${lastPart}`)

    switch (type) {
      case 'artist':
        return this._resolveArtist(lastPart)
      case 'playlist':
        return this._resolvePlaylist(lastPart)
      case 'station':
        return this._resolveStation(lastPart)
      case 'podcast':
        return this._resolvePodcast(lastPart)
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async _ensureAuth() {
    if (!this.authToken) {
      await this.setup()
    }

    if (!this.authToken) {
      return {
        exception: {
          message: 'Pandora source is not available.',
          severity: 'common',
          cause: 'Auth Failed'
        }
      }
    }

    return null
  }

  _buildException(error, data) {
    return {
      exception: {
        message: error?.message || data?.message || 'Unknown error',
        severity: 'common'
      }
    }
  }

  _getHeaders() {
    return {
      Cookie: this.csrfToken.raw,
      'X-CsrfToken': this.csrfToken.parsed,
      'X-AuthToken': this.authToken,
      'Content-Type': 'application/json'
    }
  }

  _buildArtworkUrl(artwork) {
    if (!artwork) return null
    return artwork.startsWith('http')
      ? artwork
      : `https://content-images.p-cdn.com/${artwork}`
  }

  _buildUri(shareableUrlPath) {
    if (!shareableUrlPath) return ''
    return shareableUrlPath.startsWith('http')
      ? shareableUrlPath
      : `https://www.pandora.com${shareableUrlPath}`
  }

  _limitArray(arr, limit) {
    return arr.length > limit ? arr.slice(0, limit) : arr
  }

  async _resolveArtist(id) {
    const { body: trackData, error } = await http1makeRequest(
      'https://www.pandora.com/api/v4/catalog/annotateObjectsSimple',
      {
        body: { pandoraIds: [id] },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || trackData.message) {
      return this._buildException(error, trackData)
    }

    const keys = Object.keys(trackData)
    if (keys.length === 0) return { loadType: 'empty', data: {} }

    const item = trackData[keys[0]]

    if (item.type === 'TR') {
      const track = this.buildTrack(item)
      return { loadType: 'track', data: track }
    } else if (item.type === 'AL') {
      return this._resolveAlbumDetails(item.pandoraId, item.name)
    } else if (item.type === 'AR') {
      return this._resolveArtistDetails(item.pandoraId)
    }

    return { loadType: 'empty', data: {} }
  }

  async _resolveAlbumDetails(id, name) {
    const { body: data, error } = await http1makeRequest(
      'https://www.pandora.com/api/v4/catalog/getDetails',
      {
        body: { pandoraId: id },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || data.errors) {
      return this._buildException(error, { message: 'Unknown album error' })
    }

    const trackKeys = this._limitArray(
      Object.keys(data.annotations),
      this.config.maxAlbumPlaylistLength
    )
    const tracks = trackKeys.map(key => this.buildTrack(data.annotations[key]))

    return {
      loadType: 'playlist',
      data: {
        info: { name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveArtistDetails(id) {
    const { body: data, error } = await http1makeRequest(
      'https://www.pandora.com/api/v1/graphql/graphql',
      {
        body: {
          operationName: 'GetArtistDetailsWithCuratorsWeb',
          query: `query GetArtistDetailsWithCuratorsWeb($pandoraId: String!) {
            entity(id: $pandoraId) {
              ... on Artist {
                name
                topTracksWithCollaborations {
                  ...TrackFragment
                  __typename
                }
                __typename
              }
            }
          }
          fragment ArtFragment on Art {
            artId
            dominantColor
            artUrl: url(size: WIDTH_500)
          }
          fragment TrackFragment on Track {
            pandoraId: id
            type
            name
            duration
            shareableUrlPath: urlPath
            artistName: artist {
              name
              __typename
            }
            icon: art {
              ...ArtFragment
              __typename
            }
          }
          `,
          variables: { pandoraId: id }
        },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || data.errors) {
      return this._buildException(error, { message: 'Unknown artist error' })
    }

    const topTracks = data.data?.entity?.topTracksWithCollaborations || []
    const items = this._limitArray(topTracks, this.config.maxAlbumPlaylistLength)

    const tracks = items.map(item => this.buildTrack({
      name: item.name,
      artistName: item.artistName?.name,
      shareableUrlPath: item.shareableUrlPath,
      icon: item.icon,
      pandoraId: item.pandoraId,
      duration: item.duration
    }))

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: `${data.data.entity.name}'s Top Tracks`,
          selectedTrack: 0
        },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    const body = {
      request: {
        pandoraId: id,
        playlistVersion: 0,
        offset: 0,
        limit: this.config.maxAlbumPlaylistLength,
        annotationLimit: this.config.maxAlbumPlaylistLength,
        allowedTypes: ['TR', 'AM'],
        bypassPrivacyRules: true
      }
    }

    const { body: data, error } = await makeRequest(
      'https://www.pandora.com/api/v7/playlists/getTracks',
      {
        method: 'POST',
        headers: this._getHeaders(),
        body,
        disableBodyCompression: true
      }
    )

    if (error) {
      return this._buildException(error)
    }

    const keys = Object.keys(data.annotations).filter(key => key.includes('TR:'))
    const tracks = keys.map(key => this.buildTrack(data.annotations[key]))

    return {
      loadType: 'playlist',
      data: {
        info: { name: data.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolveStation(id) {
    const { body: stationData, error } = await http1makeRequest(
      'https://www.pandora.com/api/v1/station/getStationDetails',
      {
        body: { stationId: id },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || stationData.message) {
      return this._buildException(error, stationData)
    }

    const tracks = await this._fetchStationTracks(id, stationData)

    return {
      loadType: 'playlist',
      data: {
        info: { name: stationData.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _fetchStationTracks(id, stationData) {
    const tracks = []

    try {
      const { body: playlistData } = await http1makeRequest(
        'https://www.pandora.com/api/v1/playlist/getPlaylist',
        {
          body: { stationId: id },
          headers: this._getHeaders(),
          method: 'POST',
          disableBodyCompression: true
        }
      )

      if (playlistData && Array.isArray(playlistData.items)) {
        for (const item of playlistData.items) {
          if (!item.songName) continue

          tracks.push(this.buildTrack({
            name: item.songName,
            artistName: item.artistName,
            shareableUrlPath: item.songDetailUrl,
            icon: { artUrl: item.albumArtUrl },
            pandoraId: item.songId,
            duration: item.trackLength
          }))
        }
      }
    } catch (e) {
      logger('debug', 'Pandora', `Failed to fetch station playlist: ${e.message}`)
    }

    if (tracks.length === 0) {
      const seeds = this._limitArray(
        stationData.seeds || [],
        this.config.maxAlbumPlaylistLength
      )

      for (const seed of seeds) {
        if (!seed.song) continue
        tracks.push(this.buildTrack({
          name: seed.song.songTitle,
          artistName: seed.song.artistSummary,
          shareableUrlPath: seed.song.songDetailUrl,
          icon: {
            artUrl: seed.art?.[seed.art.length - 1]?.url
          },
          pandoraId: seed.song.songId
        }))
      }
    }

    return tracks
  }

  async _resolvePodcast(id) {
    const { body: podcastData, error } = await http1makeRequest(
      'https://www.pandora.com/api/v1/aesop/getDetails',
      {
        body: { catalogVersion: 4, pandoraId: id },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || podcastData.message) {
      return this._buildException(error, podcastData)
    }

    const details = podcastData.details
    const type = details.podcastProgramDetails
      ? details.podcastProgramDetails.type
      : details.podcastEpisodeDetails.type

    if (type === 'PE') {
      const epId = details.podcastEpisodeDetails.pandoraId
      const ep = details.annotations[epId]
      const track = this.buildTrack(ep)
      return { loadType: 'track', data: track }
    } else if (type === 'PC') {
      return this._resolvePodcastEpisodes(id)
    }

    return { loadType: 'empty', data: {} }
  }

  async _resolvePodcastEpisodes(id) {
    const { body: allEpisodesIdsData, error } = await http1makeRequest(
      'https://www.pandora.com/api/v1/aesop/getAllEpisodesByPodcastProgram',
      {
        body: { catalogVersion: 4, pandoraId: id },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (error || allEpisodesIdsData.message) {
      return this._buildException(error, allEpisodesIdsData)
    }

    const allEpisodesIds = this._limitArray(
      allEpisodesIdsData.episodes.episodesWithLabel.flatMap(yearInfo => yearInfo.episodes),
      this.config.maxAlbumPlaylistLength
    )

    const { body: allEpisodesData, error: epError } = await http1makeRequest(
      'https://www.pandora.com/api/v1/aesop/annotateObjects',
      {
        body: { catalogVersion: 4, pandoraIds: allEpisodesIds },
        headers: this._getHeaders(),
        method: 'POST',
        disableBodyCompression: true
      }
    )

    if (epError || allEpisodesData.message) {
      return this._buildException(epError, allEpisodesData)
    }

    const episodes = Object.keys(allEpisodesData.annotations)
    const tracks = episodes.map(epKey => this.buildTrack(allEpisodesData.annotations[epKey]))

    const programId = Object.keys(allEpisodesData.annotations).find(
      key => allEpisodesData.annotations[key].type === 'PC'
    )
    const programName = programId
      ? allEpisodesData.annotations[programId].name
      : 'Podcast'

    return {
      loadType: 'playlist',
      data: {
        info: { name: programName, selectedTrack: 0 },
        tracks
      }
    }
  }

  buildTrack(item) {
    const artwork = this._buildArtworkUrl(item.icon?.artUrl)
    const uri = this._buildUri(item.shareableUrlPath)
    const duration = item.duration || item.trackLength || item.length || 0

    const trackInfo = {
      identifier: item.pandoraId || item.id || 'unknown',
      isSeekable: true,
      author: item.artistName || item.programName || 'Unknown Artist',
      length: duration * 1000,
      isStream: false,
      position: 0,
      title: item.name || 'Unknown Title',
      uri,
      artworkUrl: artwork,
      isrc: item.isrc || null,
      sourceName: 'pandora'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async getTrackUrl(decodedTrack) {
    const query = `${decodedTrack.title} ${decodedTrack.author}`

    try {
      let searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch')
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
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
      logger('error', 'Pandora', `Failed to mirror track: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}