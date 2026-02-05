import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js'

const API_BASE = 'https://api.music.yandex.net'
const USER_AGENT = 'Yandex-Music-API'
const CLIENT_HEADER = 'YandexMusicAndroid/24023621'

const URL_PATTERN =
  /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/(?<type1>artist|album|track)\/(?<id1>\d+)(?:\/(?<type2>track)\/(?<id2>\d+))?\/?(?:[?#].*)?$/i
const URL_PLAYLIST_PATTERN =
  /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/users\/(?<user>[0-9A-Za-z@.-]+)\/playlists\/(?<id>\d+)\/?(?:[?#].*)?$/i
const URL_PLAYLIST_UUID_PATTERN =
  /^(?:https?:\/\/)?music\.yandex\.(?<domain>ru|com|kz|by)\/playlists\/(?<uuid>[0-9A-Za-z.-]+)\/?(?:[?#].*)?$/i

const SEARCH_PREFIX = 'ymsearch'
const RECOMMENDATIONS_PREFIX = 'ymrec'

const ARTIST_MAX_PAGE_ITEMS = 10
const PLAYLIST_MAX_PAGE_ITEMS = 100
const ALBUM_MAX_PAGE_ITEMS = 50

export default class YandexMusicSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.yandexmusic || {}
    this.searchTerms = [SEARCH_PREFIX]
    this.recommendationTerm = [RECOMMENDATIONS_PREFIX]
    this.patterns = [URL_PATTERN, URL_PLAYLIST_PATTERN, URL_PLAYLIST_UUID_PATTERN]
    this.priority = 85

    this.accessToken = null
    this.hasToken = false
    this.artistLoadLimit = this.config.artistLoadLimit ?? 1
    this.albumLoadLimit = this.config.albumLoadLimit ?? 1
    this.playlistLoadLimit = this.config.playlistLoadLimit ?? 1
    this.allowUnavailable = this.config.allowUnavailable ?? false
    this.mirrorOnFailure = true
    this.allowExplicit = this.config.allowExplicit ?? true
  }

  async setup() {
    const cachedToken = this.nodelink.credentialManager.get(
      'yandexmusic_access_token'
    )
    this.accessToken = this.config.accessToken || cachedToken || null

    if (!this.accessToken) {
      logger(
        'warn',
        'YandexMusic',
        'Missing access token. Yandex API disabled; Song.link fallback only.'
      )
      this.hasToken = false
      return true
    }

    if (this.config.accessToken && this.config.accessToken !== cachedToken) {
      this.nodelink.credentialManager.set(
        'yandexmusic_access_token',
        this.config.accessToken,
        24 * 60 * 60 * 1000
      )
    }

    this.hasToken = true
    logger('info', 'YandexMusic', 'Source initialized with access token.')
    return true
  }

  async search(query, sourceTerm, searchType = 'track') {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    if (!this.hasToken) {
      return {
        exception: { message: 'Yandex Music token required', severity: 'common' }
      }
    }

    try {
      const data = await this._apiRequest('/search', {
        text: query,
        type: 'all',
        page: '0'
      })

      const result = data?.result
      if (!result) return { loadType: 'empty', data: {} }

      const limit = this.nodelink.options.maxSearchResults || 10

      if (searchType === 'album') {
        const albums = (result.albums?.results || [])
          .filter((item) => this.allowUnavailable || item.available)
          .slice(0, limit)
          .map((item) => this._buildAlbumSearchResult(item))
        return albums.length ? { loadType: 'search', data: albums } : { loadType: 'empty', data: {} }
      }

      if (searchType === 'artist') {
        const artists = (result.artists?.results || [])
          .filter((item) => this.allowUnavailable || item.available)
          .slice(0, limit)
          .map((item) => this._buildArtistSearchResult(item))
        return artists.length ? { loadType: 'search', data: artists } : { loadType: 'empty', data: {} }
      }

      if (searchType === 'playlist') {
        const playlists = (result.playlists?.results || [])
          .filter((item) => this.allowUnavailable || item.available)
          .slice(0, limit)
          .map((item) => this._buildPlaylistSearchResult(item))
        return playlists.length ? { loadType: 'search', data: playlists } : { loadType: 'empty', data: {} }
      }

      const tracks = this._parseTracks(result.tracks?.results || [], 'com')
        .slice(0, limit)
      return tracks.length ? { loadType: 'search', data: tracks } : { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'YandexMusic', `Search failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const cleanUrl = typeof url === 'string' ? url.split(/[?#]/)[0] : url
    if (!this.hasToken) {
      const fallback = await this._resolveWithSongLink(cleanUrl, null)
      return fallback || { loadType: 'empty', data: {} }
    }

    try {
      let match = cleanUrl.match(URL_PATTERN)
      if (match?.groups) {
        const domain = match.groups.domain
        const type1 = match.groups.type1
        if (type1 === 'album' && match.groups.type2 === 'track') {
          return await this._getTrack(match.groups.id2, domain)
        }
        if (type1 === 'album') {
          return await this._getAlbum(match.groups.id1, domain)
        }
        if (type1 === 'artist') {
          return await this._getArtist(match.groups.id1, domain)
        }
        if (type1 === 'track') return await this._getTrack(match.groups.id1, domain)
      }

      match = cleanUrl.match(URL_PLAYLIST_PATTERN)
      if (match?.groups) {
        return await this._getPlaylist(
          match.groups.user,
          match.groups.id,
          match.groups.domain
        )
      }

      match = cleanUrl.match(URL_PLAYLIST_UUID_PATTERN)
      if (match?.groups) {
        return await this._getPlaylistByUuid(
          match.groups.uuid,
          match.groups.domain
        )
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getRecommendations(query) {
    if (!this.hasToken) {
      return {
        exception: { message: 'Yandex Music token required', severity: 'common' }
      }
    }

    let trackId = query
    if (!/^\d+$/.test(trackId)) {
      const searchRes = await this.search(query, SEARCH_PREFIX, 'track')
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
        trackId = searchRes.data[0].info.identifier
      } else {
        return { loadType: 'empty', data: {} }
      }
    }

    const data = await this._apiRequest(`/tracks/${trackId}/similar`)
    const similar = data?.result?.similarTracks
    if (!Array.isArray(similar) || similar.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks = this._parseTracks(similar, 'com')
    if (!tracks.length) return { loadType: 'empty', data: {} }

    return {
      loadType: 'playlist',
      data: {
        info: { name: 'Yandex Music Recommendations', selectedTrack: 0 },
        pluginInfo: { type: 'recommendations' },
        tracks
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    if (!this.hasToken) {
      return {
        exception: { message: 'Yandex Music token required', severity: 'common' }
      }
    }

    try {
      const url = await this._getDownloadUrl(decodedTrack.identifier)
      return { url, protocol: 'https', format: 'mp3' }
    } catch (e) {
      logger('error', 'YandexMusic', `Failed to get stream URL: ${e.message}`)
      if (this.mirrorOnFailure) {
        return this._getMirrorUrl(decodedTrack, e)
      }
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(_track, url) {
    const stream = new PassThrough()
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        localAddress: this.nodelink.routePlanner?.getIP(),
        proxy: this.config.proxy
      })

      if (response.error || (response.statusCode && response.statusCode !== 200 && response.statusCode !== 206)) {
        const message = response.error?.message || `HTTP ${response.statusCode} on ${url}`
        return { exception: { message, severity: 'fault' } }
      }

      if (!response.stream) {
        return {
          exception: { message: 'No stream in response', severity: 'fault' }
        }
      }

      response.stream.on('data', (chunk) => {
        if (!stream.write(chunk)) response.stream.pause()
      })

      stream.on('drain', () => {
        if (!response.stream.destroyed) response.stream.resume()
      })

      response.stream.on('end', () => {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
        }
      })

      response.stream.on('error', (err) => {
        logger('error', 'YandexMusic', `Stream error: ${err.message}`)
        if (!stream.destroyed) stream.destroy(err)
      })

      return { stream, type: 'audio/mpeg' }
    } catch (e) {
      logger('error', 'YandexMusic', `Stream failed: ${e.message}`)
      if (!stream.destroyed) stream.destroy(e)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _getTrack(id, domain) {
    let data
    try {
      data = await this._apiRequest(`/tracks/${id}`)
    } catch (e) {
      logger('warn', 'YandexMusic', `Track lookup failed: ${e.message}`)
      const fallback = await this._resolveWithSongLink(
        `https://song.link/ya/${id}`,
        'track',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    const trackJson = data?.result?.[0]
    if (!trackJson) {
      const fallback = await this._resolveWithSongLink(
        `https://song.link/ya/${id}`,
        'track',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }
    if (trackJson.available === false) {
      if (!this.allowUnavailable) {
        return { loadType: 'empty', data: {} }
      }
    }

    const track = this._parseTrack(trackJson, domain)
    if (!track) return { loadType: 'empty', data: {} }
    const songlinkData = await this._fetchSongLinkData(id)
    if (songlinkData) {
      this._applySongLinkMetadata(track, songlinkData)
      await this._enrichFromSongLinkPlatforms(track, songlinkData)
    }
    track.encoded = encodeTrack(track.info)
    return { loadType: 'track', data: track }
  }

  async _getAlbum(id, domain) {
    const pageSize = ALBUM_MAX_PAGE_ITEMS * Math.max(this.albumLoadLimit, 1)
    let data
    try {
      data = await this._apiRequest(`/albums/${id}/with-tracks`, {
        'page-size': String(pageSize)
      })
    } catch (e) {
      logger('warn', 'YandexMusic', `Album lookup failed: ${e.message}`)
      const fallback = await this._resolveWithSongLink(
        `https://album.link/ya/${id}`,
        'album',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    const result = data?.result
    if (!result?.volumes?.length) {
      const fallback = await this._resolveWithSongLink(
        `https://album.link/ya/${id}`,
        'album',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    const tracks = []
    for (const volume of result.volumes) {
      for (const item of volume) {
        const track = this._parseTrack(item, domain)
        if (track) tracks.push(track)
      }
    }
    if (!tracks.length) {
      const fallback = await this._resolveWithSongLink(
        `https://album.link/ya/${id}`,
        'album',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    return {
      loadType: 'playlist',
      data: {
        info: { name: result.title || 'Yandex Music Album', selectedTrack: 0 },
        pluginInfo: { type: 'album' },
        tracks
      }
    }
  }

  async _getArtist(id, domain) {
    const pageSize = ARTIST_MAX_PAGE_ITEMS * Math.max(this.artistLoadLimit, 1)
    let data
    try {
      data = await this._apiRequest(`/artists/${id}/tracks`, {
        'page-size': String(pageSize)
      })
    } catch (e) {
      logger('warn', 'YandexMusic', `Artist lookup failed: ${e.message}`)
      const fallback = await this._resolveWithSongLink(
        `https://artist.link/ya/${id}`,
        'artist',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    const tracks = this._parseTracks(data?.result?.tracks || [], domain)
    if (!tracks.length) {
      const fallback = await this._resolveWithSongLink(
        `https://artist.link/ya/${id}`,
        'artist',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }

    const artistData = await this._apiRequest(`/artists/${id}`)
    const artist = artistData?.result?.artist
    const name = artist?.name || 'Unknown'

    return {
      loadType: 'playlist',
      data: {
        info: { name: `${name}'s Top Tracks`, selectedTrack: 0 },
        pluginInfo: { type: 'artist' },
        tracks
      }
    }
  }

  async _getPlaylist(user, id, domain) {
    const pageSize = PLAYLIST_MAX_PAGE_ITEMS * Math.max(this.playlistLoadLimit, 1)
    const playlistUrl = `https://music.yandex.${domain}/users/${user}/playlists/${id}`
    let data
    try {
      data = await this._apiRequest(`/users/${user}/playlists/${id}`, {
        'page-size': String(pageSize),
        'rich-tracks': 'true'
      })
    } catch (e) {
      logger('warn', 'YandexMusic', `Playlist lookup failed: ${e.message}`)
      const fallback = await this._resolveWithSongLink(
        playlistUrl,
        'playlist',
        id
      )
      return fallback || { loadType: 'empty', data: {} }
    }
    const parsed = this._parsePlaylist(data, domain, playlistUrl)
    if (parsed.loadType === 'empty') {
      const fallback = await this._resolveWithSongLink(
        playlistUrl,
        'playlist',
        id
      )
      return fallback || parsed
    }
    return parsed
  }

  async _getPlaylistByUuid(uuid, domain) {
    const pageSize = PLAYLIST_MAX_PAGE_ITEMS * Math.max(this.playlistLoadLimit, 1)
    const playlistUrl = `https://music.yandex.${domain}/playlists/${uuid}`
    let data
    try {
      data = await this._apiRequest(`/playlist/${uuid}`, {
        'page-size': String(pageSize),
        'rich-tracks': 'true'
      })
    } catch (e) {
      logger('warn', 'YandexMusic', `Playlist lookup failed: ${e.message}`)
      const fallback = await this._resolveWithSongLink(
        playlistUrl,
        'playlist',
        uuid
      )
      return fallback || { loadType: 'empty', data: {} }
    }
    const parsed = this._parsePlaylist(data, domain, playlistUrl)
    if (parsed.loadType === 'empty') {
      const fallback = await this._resolveWithSongLink(
        playlistUrl,
        'playlist',
        uuid
      )
      return fallback || parsed
    }
    return parsed
  }

  _parsePlaylist(data, domain, playlistUrl) {
    const result = data?.result
    if (!result?.tracks?.length) return { loadType: 'empty', data: {} }

    const tracks = this._parseTracks(result.tracks, domain)
    if (!tracks.length) return { loadType: 'empty', data: {} }

    const owner = result.owner || {}
    const ownerName = owner.name || owner.login || 'Unknown'
    const title =
      String(result.kind) === '3'
        ? `${ownerName}'s liked songs`
        : result.title || 'Yandex Music Playlist'

    return {
      loadType: 'playlist',
      data: {
        info: { name: title, selectedTrack: 0 },
        pluginInfo: { type: 'playlist' },
        tracks
      }
    }
  }

  _parseTracks(list, domain) {
    if (!Array.isArray(list)) return []
    const tracks = []
    for (const item of list) {
      const trackJson = item?.track || item
      const track = this._parseTrack(trackJson, domain)
      if (track) tracks.push(track)
    }
    return tracks
  }

  _parseTrack(json, domain) {
    if (!json) return null
    if (json.available === false && !this.allowUnavailable) return null
    const id = String(json.id)
    const artist = this._parseArtist(json)

    let albumName = null
    let albumUrl = null
    if (Array.isArray(json.albums) && json.albums.length > 0) {
      const album = json.albums[0]
      albumName = album.title
      albumUrl = `https://music.yandex.${domain}/album/${album.id}`
    }

    let artistUrl = null
    let artistArtworkUrl = null
    if (Array.isArray(json.artists) && json.artists.length > 0) {
      const firstArtist = json.artists[0]
      artistUrl = `https://music.yandex.${domain}/artist/${firstArtist.id}`
      artistArtworkUrl = this._parseCoverUri(firstArtist)
    }

    const info = {
      title: json.title || 'Unknown',
      author: artist,
      length: Number(json.durationMs || 0),
      identifier: id,
      isSeekable: true,
      isStream: false,
      uri: `https://music.yandex.${domain}/track/${id}`,
      artworkUrl: this._parseCoverUri(json),
      isrc: json.isrc || null,
      sourceName: 'yandexmusic',
      position: 0
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {
        albumName,
        albumUrl,
        artistUrl,
        artistArtworkUrl,
        unavailable: json.available === false
      }
    }
  }

  _parseArtist(json) {
    if (json?.major?.name === 'PODCASTS' && json.albums?.[0]?.title) {
      return json.albums[0].title
    }

    if (Array.isArray(json?.artists) && json.artists.length > 0) {
      return json.artists.map((a) => a.name).join(', ')
    }

    if (json?.matchedTrack?.artists?.length) {
      return json.matchedTrack.artists.map((a) => a.name).join(', ')
    }

    return 'Unknown'
  }

  _parseCoverUri(json) {
    if (!json) return null
    if (json.ogImage) return this._formatCoverUri(json.ogImage)
    if (json.coverUri) return this._formatCoverUri(json.coverUri)

    const cover = json.cover
    if (cover?.uri) return this._formatCoverUri(cover.uri)
    if (Array.isArray(cover?.itemsUri) && cover.itemsUri.length > 0) {
      return this._formatCoverUri(cover.itemsUri[0])
    }

    return null
  }

  _formatCoverUri(uri) {
    return uri ? `https://${uri.replace('%%', '400x400')}` : null
  }

  async _apiRequest(path, params = {}) {
    const url = new URL(`${API_BASE}${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    const { statusCode, body } = await http1makeRequest(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `OAuth ${this.accessToken}`,
        'User-Agent': USER_AGENT,
        'X-Yandex-Music-Client': CLIENT_HEADER
      },
      localAddress: this.nodelink.routePlanner?.getIP(),
      proxy: this.config.proxy
    })

    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode} on ${url}`)
    }

    return body
  }

  async _getDownloadUrl(trackId) {
    const data = await this._apiRequest(`/tracks/${trackId}/download-info`)
    const results = data?.result
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`No download info for track ${trackId}`)
    }

    const mp3 = results
      .filter((item) => item.codec === 'mp3')
      .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0]

    if (!mp3?.downloadInfoUrl) {
      throw new Error(`No MP3 download URL for track ${trackId}`)
    }

    const xmlText = await this._downloadText(mp3.downloadInfoUrl)
    const host = this._readXmlTag(xmlText, 'host')
    const path = this._readXmlTag(xmlText, 'path')
    const ts = this._readXmlTag(xmlText, 'ts')
    const s = this._readXmlTag(xmlText, 's')

    if (!host || !path || !ts || !s) {
      throw new Error(`Invalid download-info response for track ${trackId}`)
    }

    const sign = `XGRlBW9FXlekgbPrRHuSiA${path}${s}`
    const md5 = crypto.createHash('md5').update(sign, 'utf8').digest('hex')

    return `https://${host}/get-mp3/${md5}/${ts}${path}`
  }

  async _getMirrorUrl(decodedTrack, originalError) {
    try {
      const searchQuery = this._buildSearchQuery(decodedTrack)
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

      const best = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

      if (!best) {
        return {
          exception: {
            message: 'No suitable alternative stream found after filtering.',
            severity: 'fault'
          }
        }
      }

      const stream = await this.nodelink.sources.getTrackUrl(best.info)
      return { newTrack: best, ...stream }
    } catch (e) {
      logger('error', 'YandexMusic', `Mirroring failed: ${e.message}`)
      return {
        exception: {
          message: originalError?.message || e.message,
          severity: 'fault'
        }
      }
    }
  }

  _buildSearchQuery(track) {
    return `${track.title} ${track.author}`.trim()
  }

  async _fetchSongLinkData(trackId) {
    try {
      const songlinkSource = this.nodelink.sources.getSource('songlink')
      if (!songlinkSource || typeof songlinkSource.getSongLinkData !== 'function') {
        return null
      }
      const url = `https://song.link/ya/${trackId}`
      const data = await songlinkSource.getSongLinkData(url)
      if (
        !data?.entitiesByUniqueId ||
        Object.keys(data.entitiesByUniqueId).length === 0
      ) {
        return null
      }
      return data
    } catch (e) {
      logger('debug', 'YandexMusic', `Song.link fallback failed: ${e.message}`)
      return null
    }
  }

  _buildSongLinkUrl(originalUrl, typeHint, id) {
    if (typeHint === 'album' && id) return `https://album.link/ya/${id}`
    if (typeHint === 'artist' && id) return `https://artist.link/ya/${id}`
    if (typeHint === 'track' && id) return `https://song.link/ya/${id}`
    return originalUrl
  }

  async _resolveWithSongLink(originalUrl, typeHint, id) {
    try {
      const songlinkSource = this.nodelink.sources.getSource('songlink')
      if (!songlinkSource || typeof songlinkSource.getSongLinkData !== 'function') {
        return null
      }

      const songlinkUrl = this._buildSongLinkUrl(originalUrl, typeHint, id)
      const songlinkData = await songlinkSource.getSongLinkData(songlinkUrl)
      const linksByPlatform = songlinkData?.linksByPlatform
      if (!linksByPlatform) return null

      const platforms =
        typeof songlinkSource.getPlatformOrder === 'function'
          ? songlinkSource.getPlatformOrder(linksByPlatform)
          : Object.keys(linksByPlatform)

      for (const platform of platforms) {
        const link = linksByPlatform[platform]?.url
        if (!link) continue
        const sourceName =
          typeof songlinkSource.getPlatformSourceName === 'function'
            ? songlinkSource.getPlatformSourceName(platform)
            : null
        if (!this._isSourceAvailable(sourceName)) continue

        const source = this.nodelink.sources.getSource(sourceName)
        if (!source || typeof source.resolve !== 'function') continue

        const resolved = await source.resolve(link)
        if (resolved?.loadType === 'track' || resolved?.loadType === 'playlist') {
          return this._decorateSongLinkResult(
            resolved,
            songlinkData,
            originalUrl,
            sourceName
          )
        }
      }
    } catch (e) {
      logger('debug', 'YandexMusic', `Song.link resolve failed: ${e.message}`)
    }

    return null
  }

  _decorateSongLinkResult(result, songlinkData, originalUrl, mirrorSource) {
    const songlinkInfo = {
      pageUrl: songlinkData.pageUrl,
      entityUniqueId: songlinkData.entityUniqueId,
      userCountry: songlinkData.userCountry,
      linksByPlatform: songlinkData.linksByPlatform
    }

    const entity =
      songlinkData?.entitiesByUniqueId?.[songlinkData.entityUniqueId] || null

    if (result?.loadType === 'track' && result.data) {
      result.data.pluginInfo = {
        ...(result.data.pluginInfo || {}),
        songlink: songlinkInfo,
        originalUrl,
        mirrorSource
      }
    } else if (result?.loadType === 'playlist' && result.data) {
      if (entity?.title && result.data.info?.name) {
        result.data.info.name = entity.artistName
          ? `${entity.artistName} - ${entity.title}`
          : entity.title
      }
      result.data.pluginInfo = {
        ...(result.data.pluginInfo || {}),
        songlink: songlinkInfo,
        originalUrl,
        mirrorSource,
        type: entity?.type || result.data.pluginInfo?.type || 'playlist'
      }
    }

    return result
  }

  _applySongLinkMetadata(track, songlinkData) {
    const linksByPlatform = songlinkData.linksByPlatform || {}
    const entityId = songlinkData.entityUniqueId
    const entities = songlinkData.entitiesByUniqueId || {}
    const preferredPlatforms = [
      'spotify',
      'appleMusic',
      'itunes',
      'deezer',
      'tidal',
      'youtubeMusic',
      'youtube',
      'soundcloud',
      'amazonMusic',
      'amazonStore',
      'anghami',
      'boomplay',
      'napster',
      'pandora'
    ]
    let entity = null
    for (const platform of preferredPlatforms) {
      const platformEntityId = linksByPlatform[platform]?.entityUniqueId
      if (platformEntityId && entities[platformEntityId]) {
        entity = entities[platformEntityId]
        break
      }
    }
    if (!entity) {
      entity = entities[entityId]
    }
    if (!entity) {
      entity = Object.values(entities)[0]
    }

    if (entity) {
      if (!track.info.title && entity.title) track.info.title = entity.title
      if (!track.info.author && entity.artistName) {
        track.info.author = entity.artistName
      }
      if (entity.duration && (!track.info.length || track.info.length <= 0)) {
        track.info.length = Math.round(entity.duration * 1000)
      }
      if (
        entity.thumbnailUrl &&
        (!track.info.artworkUrl || track.info.artworkUrl.includes('yandex.net'))
      ) {
        track.info.artworkUrl = entity.thumbnailUrl
      }
      if (!track.info.isrc && entity.isrc) track.info.isrc = entity.isrc
    }

    if (Object.keys(linksByPlatform).length > 0) {
      track.pluginInfo = track.pluginInfo || {}
      track.pluginInfo.songlink = {
        pageUrl: songlinkData.pageUrl,
        entityUniqueId: songlinkData.entityUniqueId,
        userCountry: songlinkData.userCountry,
        linksByPlatform
      }
    }
  }

  async _enrichFromSongLinkPlatforms(track, songlinkData) {
    const linksByPlatform = songlinkData?.linksByPlatform
    if (!linksByPlatform) return

    const needsLength = !track.info.length || track.info.length <= 0
    const needsArtwork =
      !track.info.artworkUrl || track.info.artworkUrl.includes('yandex.net')
    const needsIsrc = !track.info.isrc
    if (!needsLength && !needsArtwork && !needsIsrc) return

    const songlinkSource = this.nodelink.sources.getSource('songlink')
    if (!songlinkSource) return
    const platforms =
      typeof songlinkSource.getPlatformOrder === 'function'
        ? songlinkSource.getPlatformOrder(linksByPlatform)
        : Object.keys(linksByPlatform)

    for (const platform of platforms) {
      const link = linksByPlatform[platform]?.url
      if (!link) continue
      const sourceName =
        typeof songlinkSource.getPlatformSourceName === 'function'
          ? songlinkSource.getPlatformSourceName(platform)
          : null
      if (!this._isSourceAvailable(sourceName)) continue
      const source = this.nodelink.sources.getSource(sourceName)
      if (!source || typeof source.resolve !== 'function') continue
      try {
        const resolved = await source.resolve(link)
        const candidate = this._extractTrackFromResult(resolved)
        if (!candidate?.info) continue
        this._applyExternalMetadata(track, candidate.info)

        const doneLength = track.info.length && track.info.length > 0
        const doneArtwork = track.info.artworkUrl
        const doneIsrc = track.info.isrc
        if (doneLength || doneArtwork || doneIsrc) break
      } catch (e) {
        logger(
          'debug',
          'YandexMusic',
          `Song.link metadata resolve failed: ${e.message}`
        )
      }
    }
  }

  _extractTrackFromResult(result) {
    if (!result?.loadType) return null
    if (result.loadType === 'track') return result.data
    const tracks = result.data?.tracks || result.data
    if (Array.isArray(tracks) && tracks.length > 0) {
      return tracks[0]
    }
    return null
  }

  _applyExternalMetadata(track, info) {
    if (!track.info.title && info.title) track.info.title = info.title
    if (!track.info.author && info.author) track.info.author = info.author
    if (!track.info.length || track.info.length <= 0) {
      if (info.length) track.info.length = info.length
    }
    if (
      !track.info.artworkUrl ||
      track.info.artworkUrl.includes('yandex.net')
    ) {
      if (info.artworkUrl) track.info.artworkUrl = info.artworkUrl
    }
    if (!track.info.isrc && info.isrc) track.info.isrc = info.isrc
  }

  _isSourceAvailable(sourceName) {
    if (!sourceName) return false
    const sourceConfig = this.nodelink.options.sources?.[sourceName]
    if (!sourceConfig?.enabled) return false
    return !!this.nodelink.sources.getSource(sourceName)
  }

  async _downloadText(url) {
    const { statusCode, body } = await http1makeRequest(url, {
      method: 'GET',
      headers: { Authorization: `OAuth ${this.accessToken}` },
      localAddress: this.nodelink.routePlanner?.getIP()
    })
    if (statusCode !== 200) {
      throw new Error(`HTTP ${statusCode} on ${url}`)
    }
    return typeof body === 'string' ? body : String(body)
  }

  _readXmlTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))
    return match ? match[1] : null
  }

  _buildAlbumSearchResult(item) {
    const info = {
      title: item.title || 'Unknown Album',
      author: this._parseArtist(item),
      length: 0,
      identifier: String(item.id),
      isSeekable: true,
      isStream: false,
      uri: `https://music.yandex.com/album/${item.id}`,
      artworkUrl: this._parseCoverUri(item),
      isrc: null,
      sourceName: 'yandexmusic',
      position: 0
    }
    return { encoded: encodeTrack(info), info, pluginInfo: { type: 'album' } }
  }

  _buildArtistSearchResult(item) {
    const info = {
      title: item.name || 'Unknown Artist',
      author: 'Yandex Music',
      length: 0,
      identifier: String(item.id),
      isSeekable: false,
      isStream: false,
      uri: `https://music.yandex.com/artist/${item.id}`,
      artworkUrl: this._parseCoverUri(item),
      isrc: null,
      sourceName: 'yandexmusic',
      position: 0
    }
    return { encoded: encodeTrack(info), info, pluginInfo: { type: 'artist' } }
  }

  _buildPlaylistSearchResult(item) {
    const owner = item.owner || {}
    const ownerName = owner.name || owner.login || 'Unknown'
    const info = {
      title: item.title || 'Yandex Music Playlist',
      author: ownerName,
      length: 0,
      identifier: String(item.kind),
      isSeekable: true,
      isStream: false,
      uri: `https://music.yandex.com/users/${owner.login}/playlists/${item.kind}`,
      artworkUrl: this._parseCoverUri(item),
      isrc: null,
      sourceName: 'yandexmusic',
      position: 0
    }
    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: { type: 'playlist' }
    }
  }
}
