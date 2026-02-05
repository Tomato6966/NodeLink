import crypto from 'node:crypto'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

const API_URL = 'https://www.qobuz.com/api.json/0.2'
const WEB_PLAYER_BASE_URL = 'https://play.qobuz.com'

export default class QobuzSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['qbsearch']
    this.recommendationTerm = ['qbrec']
    this.patterns = [
      /https?:\/\/(?:www\.|play\.|open\.)?qobuz\.com\/(?:(?:[a-z]{2}-[a-z]{2}\/)?(track|album|playlist|artist)\/(?:.+?\/)?([a-zA-Z0-9]+)|(playlist)\/(\d+))/
    ]
    this.priority = 90

    this.appId = null
    this.appSecret = null
    this.userToken = null
    this.initialized = false
  }

  async setup() {
    this.userToken = this.config.sources.qobuz?.userToken || null

    const cachedAppId = this.nodelink.credentialManager.get('qobuz_app_id')
    const cachedAppSecret = this.nodelink.credentialManager.get('qobuz_app_secret')
    const cachedToken = this.nodelink.credentialManager.get('qobuz_user_token')

    if (cachedAppId && cachedAppSecret && cachedToken === this.userToken) {
      this.appId = cachedAppId
      this.appSecret = cachedAppSecret
      this.initialized = true
      logger('info', 'Qobuz', `Loaded credentials from cache (UserToken: ${!!this.userToken})`)
      return true
    }

    try {
      const bundleJsContent = await this._fetchBundleJs()
      if (!bundleJsContent) {
        logger('error', 'Qobuz', 'Failed to fetch bundle.js content.')
        return false
      }

      this.appId = this._extractAppId(bundleJsContent)
      this.appSecret = this._extractAppSecret(bundleJsContent)

      if (!this.appId || !this.appSecret) {
        logger('error', 'Qobuz', 'Failed to extract appId or appSecret.')
        return false
      }

      this.nodelink.credentialManager.set('qobuz_app_id', this.appId, 24 * 60 * 60 * 1000)
      this.nodelink.credentialManager.set('qobuz_app_secret', this.appSecret, 24 * 60 * 60 * 1000)
      this.nodelink.credentialManager.set('qobuz_user_token', this.userToken, 24 * 60 * 60 * 1000)

      this.initialized = true
      logger('info', 'Qobuz', `Initialized with appId: ${this.appId} (UserToken: ${!!this.userToken})`)
      return true
    } catch (e) {
      logger('error', 'Qobuz', `Failed to initialize: ${e.message}`)
      return false
    }
  }

  async _fetchBundleJs() {
    try {
      const { body } = await http1makeRequest(`${WEB_PLAYER_BASE_URL}/login`)
      const bundleMatch = body.match(/<script src="(\/resources\/\d+\.\d+\.\d+-[a-z]\d{3}\/bundle\.js)"/) 
      if (!bundleMatch) return null

      const { body: bundleJs } = await http1makeRequest(`${WEB_PLAYER_BASE_URL}${bundleMatch[1]}`)
      return bundleJs
    } catch (e) {
      logger('error', 'Qobuz', `Error fetching bundle.js: ${e.message}`)
      return null
    }
  }

  _extractAppId(content) {
    const match = content.match(/production:\{api:\{appId:"(.*?)"/) 
    return match ? match[1] : null
  }

  _extractAppSecret(content) {
    const seedMatch = content.match(/\):[a-z]\.initialSeed\("(.*?)",window\.utimezone\.(.*?)\)/)
    if (!seedMatch) return null

    const seed = seedMatch[1]
    const timezone = seedMatch[2].charAt(0).toUpperCase() + seedMatch[2].slice(1).toLowerCase()

    const infoExtrasRegex = new RegExp(`timezones:\\[.*?name:.*?/${timezone}",info:"(?<info>.*?)",extras:"(?<extras>.*?)"`)
    const infoExtrasMatch = content.match(infoExtrasRegex)
    if (!infoExtrasMatch) return null

    const encoded = (seed + infoExtrasMatch.groups.info + infoExtrasMatch.groups.extras).slice(0, -44)
    return Buffer.from(encoded, 'base64').toString()
  }

  async _apiRequest(path, params = {}, options = {}) {
    const url = new URL(`${API_URL}${path}`)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.append(key, value)
    }

    try {
      const { body, statusCode } = await http1makeRequest(url.toString(), {
        method: options.method || 'GET',
        headers: {
          'x-app-id': this.appId,
          'x-user-auth-token': this.userToken || '',
          ...options.headers
        },
        body: options.body,
        disableBodyCompression: options.disableBodyCompression ?? false
      })

      if (statusCode !== 200) {
        logger('debug', 'Qobuz', `API Error (${statusCode}) on ${path}: ${JSON.stringify(body)}`)
        return null
      }

      return body
    } catch (e) {
      logger('error', 'Qobuz', `Request failed on ${path}: ${e.message}`)
      return null
    }
  }

  async search(query, sourceTerm) {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    const data = await this._apiRequest('/catalog/search', {
      query,
      limit: this.config.maxSearchResults || 10,
      type: 'tracks'
    })

    if (!data?.tracks?.items) return { loadType: 'empty', data: {} }

    const tracks = data.tracks.items.map((item) => this._buildTrack(item))
    return { loadType: 'search', data: tracks }
  }

  async getRecommendations(id) {
    try {
      const trackData = await this._apiRequest('/track/get', { track_id: id })
      if (!trackData) return { loadType: 'empty', data: {} }

      const artistId = trackData.performer?.id
      if (!artistId) return { loadType: 'empty', data: {} }

      const payload = {
        limit: 20,
        listened_tracks_ids: [Number(id)],
        track_to_analyse: [
          {
            track_id: Number(id),
            artist_id: Number(artistId)
          }
        ]
      }

      const data = await this._apiRequest('/dynamic/suggest', {}, {
        method: 'POST',
        body: payload,
        disableBodyCompression: true
      })

      if (!data?.tracks?.items) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = data.tracks.items.map((item) => this._buildTrack(item))
      return {
        loadType: 'playlist',
        data: {
          info: { name: 'Qobuz Recommendations', selectedTrack: 0 },
          pluginInfo: { type: 'recommendations' },
          tracks
        }
      }
    } catch (e) {
      logger('error', 'Qobuz', `Error fetching recommendations: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    let [, type, id] = match
    if (!type) {
      type = match[3]
      id = match[4]
    }

    switch (type) {
      case 'track':
        return await this._resolveTrack(id)
      case 'album':
        return await this._resolveAlbum(id)
      case 'playlist':
        return await this._resolvePlaylist(id)
      case 'artist':
        return await this._resolveArtist(id)
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async _resolveTrack(id) {
    let data = await this._apiRequest('/track/get', { track_id: id })
    
    if (!data) {
      const search = await this._apiRequest('/catalog/search', { query: id, type: 'tracks', limit: 1 })
      data = search?.tracks?.items?.find(item => String(item.id) === String(id))
    }

    if (!data) return { loadType: 'empty', data: {} }

    return { loadType: 'track', data: this._buildTrack(data) }
  }

  async _resolveAlbum(id) {
    const max = this.config.maxAlbumPlaylistLength || 100
    let data = await this._apiRequest('/album/get', { album_id: id, limit: Math.min(max, 50) })
    
    if (!data) {
      const search = await this._apiRequest('/catalog/search', { query: id, type: 'albums', limit: 1 })
      const album = search?.albums?.items?.find(item => String(item.id) === String(id) || item.qobuz_id === Number(id))
      if (album) {
         data = await this._apiRequest('/album/get', { album_id: album.id, limit: Math.min(max, 50) })
      }
    }

    if (!data || !data.tracks) return { loadType: 'empty', data: {} }

    const allItems = await this._fetchRemainingTracks('/album/get', { album_id: data.id }, data.tracks, max)

    const tracks = allItems.map((item) => {
      item.album = { title: data.title, image: data.image, id: data.id }
      return this._buildTrack(item)
    })

    return {
      loadType: 'playlist',
      data: {
        info: { name: data.title, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _resolvePlaylist(id) {
    const max = this.config.maxAlbumPlaylistLength || 100
    const data = await this._apiRequest('/playlist/get', { 
      playlist_id: id, 
      extra: 'tracks',
      limit: Math.min(max, 50) 
    })

    if (!data || !data.tracks) return { loadType: 'empty', data: {} }

    const allItems = await this._fetchRemainingTracks('/playlist/get', { playlist_id: id, extra: 'tracks' }, data.tracks, max)

    const tracks = allItems.map((item) => this._buildTrack(item))
    return {
      loadType: 'playlist',
      data: {
        info: { name: data.name, selectedTrack: 0 },
        tracks
      }
    }
  }

  async _fetchRemainingTracks(path, params, initialTracks, max) {
    const items = [...initialTracks.items]
    const total = Math.min(initialTracks.total, max)
    let offset = initialTracks.items.length

    while (items.length < total) {
      const limit = Math.min(50, total - items.length)
      const data = await this._apiRequest(path, { ...params, limit, offset })
      
      if (!data?.tracks?.items?.length) break
      
      items.push(...data.tracks.items)
      offset += data.tracks.items.length
      
      if (data.tracks.items.length < limit) break
    }

    return items.slice(0, max)
  }

  async _resolveArtist(id) {
    const max = this.config.maxAlbumPlaylistLength || 100
    const data = await this._apiRequest('/artist/get', { 
      artist_id: id, 
      extra: 'tracks',
      limit: Math.min(max, 50)
    })

    if (!data || !data.tracks) return { loadType: 'empty', data: {} }

    const allItems = await this._fetchRemainingTracks('/artist/get', { artist_id: id, extra: 'tracks' }, data.tracks, max)

    const tracks = allItems.map((item) => this._buildTrack(item))
    return {
      loadType: 'playlist',
      data: {
        info: { name: `${data.name}'s Top Tracks`, selectedTrack: 0 },
        tracks
      }
    }
  }

  _buildTrack(item) {
    const trackInfo = {
      identifier: String(item.id),
      isSeekable: true,
      author: item.artist?.name || item.performer?.name || 'Unknown Artist',
      length: (item.duration || 0) * 1000,
      isStream: false,
      position: 0,
      title: item.title,
      uri: `https://open.qobuz.com/track/${item.id}`,
      artworkUrl: item.album?.image?.large || item.album?.image?.small || null,
      isrc: item.isrc || null,
      sourceName: 'qobuz'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async getTrackUrl(decodedTrack) {
    const formatId = this.config.sources.qobuz?.formatId || '5'
    
    if (this.userToken) {
      try {
        const unixTs = Math.floor(Date.now() / 1000)
        const sigData = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${decodedTrack.identifier}${unixTs}${this.appSecret}`
        const requestSig = crypto.createHash('md5').update(sigData).digest('hex')

        const data = await this._apiRequest('/track/getFileUrl', {
          request_ts: unixTs,
          request_sig: requestSig,
          track_id: decodedTrack.identifier,
          format_id: formatId,
          intent: 'stream'
        })

        if (data?.url && (!data.sample || data.sample === false || data.sample === 'false')) {
          return { url: data.url }
        }
        
        logger('debug', 'Qobuz', `Direct stream not available (sample: ${data?.sample}), falling back to mirror.`)
      } catch (e) {
        logger('error', 'Qobuz', `Direct stream request failed: ${e.message}`)
      }
    }

    return this._getMirrorUrl(decodedTrack)
  }

  async _getMirrorUrl(decodedTrack) {
    const query = `${decodedTrack.title} ${decodedTrack.author}`
    try {
      let result = null

      if (decodedTrack.isrc) {
        result = await this.nodelink.sources.search('youtube', `"${decodedTrack.isrc}"`, 'ytmsearch')
      }

      if (!result || result.loadType !== 'search' || !result.data.length) {
        result = await this.nodelink.sources.searchWithDefault(query)
      }

      if (result.loadType !== 'search' || !result.data.length) {
        return { exception: { message: 'No mirror found for this track.', severity: 'common' } }
      }

      const best = getBestMatch(result.data, decodedTrack, { 
        allowExplicit: this.config.sources.qobuz?.allowExplicit ?? true 
      })

      if (!best) return { exception: { message: 'No suitable match found.', severity: 'common' } }

      const stream = await this.nodelink.sources.getTrackUrl(best.info)
      return { newTrack: best, ...stream }
    } catch (e) {
      logger('error', 'Qobuz', `Mirroring failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _buildMirrorQuery(track, isExplicit) {
    let query = `${track.title} ${track.author}`
    if (isExplicit && !(this.config.sources.qobuz?.allowExplicit ?? true)) {
       query += ' clean version'
    }
    return query
  }
}
