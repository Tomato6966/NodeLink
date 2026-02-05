import { encodeTrack, http1makeRequest, logger, getBestMatch } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.js'
import PlaylistParser from '../playback/hls/PlaylistParser.js'
import { PassThrough } from 'node:stream'
import { createDecipheriv } from 'node:crypto'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const API_URL = 'https://gaana.com/apiv2'
const STREAM_URL_API = 'https://gaana.com/api/stream-url'
const CRYPTO_KEY = Buffer.from('gy1t#b@jl(b$wtme', 'utf8')
const CRYPTO_IV = Buffer.from('xC4dmVJAq14BfntX', 'utf8')
const HLS_BASE_URL = 'https://vodhlsgaana-ebw.akamaized.net/'

export default class GaanaSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.gaana || {}
    this.searchTerms = ['gnsearch', 'gaanasearch']
    this.patterns = [
      /^@?(?:https?:\/\/)?(?:www\.)?gaana\.com\/(?<type>song|album|playlist|artist)\/(?<seokey>[\w-]+)(?:[?#].*)?$/
    ]
    this.priority = 70
    this.maxSearchResults = nodelink.options.maxSearchResults || 10
    const maxAlbumPlaylistLength = nodelink.options.maxAlbumPlaylistLength || 100
    this.playlistLoadLimit = this.config.playlistLoadLimit ?? maxAlbumPlaylistLength
    this.albumLoadLimit = this.config.albumLoadLimit ?? maxAlbumPlaylistLength
    this.artistLoadLimit = this.config.artistLoadLimit ?? maxAlbumPlaylistLength
    this.streamQuality = this.config.streamQuality || 'high'
  }

  async setup() {
    if (this.config.enabled === false) return false
    logger('info', 'Sources', 'Loaded Gaana source.')
    return true
  }

  _getHeaders(query = '') {
    return {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://gaana.com',
      'Referer': `https://gaana.com/${query}`
    }
  }

  async getJson(params, query = '') {
    const url = `${API_URL}?${new URLSearchParams(params).toString()}`
    const { body, statusCode, error } = await http1makeRequest(url, {
      method: 'POST',
      headers: this._getHeaders(query),
      disableBodyCompression: true
    })

    if (error || statusCode !== 200 || !body) return null
    try {
      return typeof body === 'object' ? body : JSON.parse(body)
    } catch {
      return null
    }
  }

  async getTracks(identifiers) {
    if (!identifiers || identifiers.length === 0) return []
    const tracks = await Promise.all(
      identifiers.map(async (id) => {
        const trackResult = await this.getSong(id)
        return trackResult.loadType === 'track' ? trackResult.data : null
      })
    )
    return tracks.filter(Boolean)
  }

  async search(query, sourceTerm, searchType = 'track') {
    try {
      const params = {
        country: 'IN',
        page: 0,
        type: 'search',
        keyword: query
      }

      if (searchType === 'track') params.secType = 'track'
      else if (searchType === 'album') params.secType = 'album'
      else if (searchType === 'artist') params.secType = 'artist'
      else if (searchType === 'playlist') params.secType = 'playlist'

      const data = await this.getJson(params, `search/${encodeURIComponent(query)}`)
      if (!data || !data.gr) return { loadType: 'empty', data: {} }

      const group = data.gr.find((g) => g.ty === (searchType === 'track' ? 'Track' : searchType.charAt(0).toUpperCase() + searchType.slice(1)))
      if (!group || !group.gd) return { loadType: 'empty', data: {} }

      const items = group.gd.slice(0, this.maxSearchResults)

      if (searchType === 'track') {
        const trackIdentifiers = items.map((item) => item.seo || item.id).filter(Boolean)
        const tracks = await this.getTracks(trackIdentifiers)
        return tracks.length ? { loadType: 'search', data: tracks } : { loadType: 'empty', data: {} }
      }

      const results = items.map((item) => this.mapCollectionResult(item, searchType)).filter(Boolean)
      return results.length ? { loadType: 'search', data: results } : { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Gaana', `Search error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match?.groups) return { loadType: 'empty', data: {} }

    const { type, seokey } = match.groups

    try {
      if (type === 'song') return await this.getSong(seokey)
      if (type === 'album') return await this.getAlbum(seokey)
      if (type === 'playlist') return await this.getPlaylist(seokey)
      if (type === 'artist') return await this.getArtist(seokey)
      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Gaana', `Resolve error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getSong(seokey) {
    const data = await this.getJson({ type: 'songDetail', seokey }, `song/${seokey}`)
    if (!data || !data.tracks || !data.tracks[0]) return { loadType: 'empty', data: {} }

    const track = this.mapTrack(data.tracks[0])
    return track ? { loadType: 'track', data: track } : { loadType: 'empty', data: {} }
  }

  async getAlbum(seokey) {
    const data = await this.getJson({ type: 'albumDetail', seokey }, `album/${seokey}`)
    if (!data || !data.tracks || data.tracks.length === 0) return { loadType: 'empty', data: {} }

    const album = data.album || {}
    return this.buildPlaylist(album.title || 'Unknown Album', data.tracks, 'album', `https://gaana.com/album/${seokey}`, album.atw, album.artist?.[0]?.name)
  }

  async getPlaylist(seokey) {
    const data = await this.getJson({ type: 'playlistDetail', seokey }, `playlist/${seokey}`)

    if (!data || !data.tracks || data.tracks.length === 0) return { loadType: 'empty', data: {} }

    const playlist = data.playlist || {}
    return this.buildPlaylist(playlist.title || 'Unknown Playlist', data.tracks, 'playlist', `https://gaana.com/playlist/${seokey}`, playlist.atw)
  }

  async getArtist(seokey) {
    const detail = await this.getJson({ type: 'artistDetail', seokey }, `artist/${seokey}`)
    if (!detail || !detail.artist || !detail.artist[0]) return { loadType: 'empty', data: {} }

    const artistToken = detail.artist[0].artist_id
    const tracksData = await this.getJson({
      type: 'artistTrackList',
      id: artistToken,
      language: '',
      order: 0,
      page: 0,
      sortBy: 'popularity'
    }, `artist/${seokey}`)

    if (!tracksData || (!tracksData.tracks && !tracksData.entities)) return { loadType: 'empty', data: {} }

    const tracksArray = tracksData.tracks || tracksData.entities || []
    return this.buildPlaylist(detail.artist[0].name || 'Unknown Artist', tracksArray, 'artist', `https://gaana.com/artist/${seokey}`, detail.artist[0].artwork_bio)
  }

  buildPlaylist(name, tracksArray, type, url, artwork, author) {
    const tracks = tracksArray
      .map((item) => (item.track_id || item.track_title ? this.mapTrack(item) : this.mapEntityTrack(item)))
      .filter(Boolean)
      .slice(0, this.getLoadLimit(type))

    const infoName = type === 'artist' ? `${name}'s Top Tracks` : name

    return {
      loadType: 'playlist',
      data: {
        info: { name: infoName, selectedTrack: 0 },
        pluginInfo: { type, url, artwork, author },
        tracks
      }
    }
  }

  mapTrack(track) {
    const title = track.track_title || track.name
    if (!title) return null

    const duration = (Number(track.duration) || 0) * 1000
    const author = Array.isArray(track.artist) ? track.artist.map(a => a.name).join(', ') : (track.artist?.name || 'Unknown Artist')
    const identifier = String(track.track_id || track.seokey)
    const uri = track.seokey ? `https://gaana.com/song/${track.seokey}` : null

    const info = {
      identifier,
      isSeekable: true,
      author,
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl: track.artwork_large || track.atw || null,
      isrc: track.isrc || null,
      sourceName: 'gaana'
    }

    return {
      encoded: encodeTrack(info), info, pluginInfo: {
        trackId: track.track_id,
        albumName: track.album_title,
        albumUrl: track.albumseokey ? `https://gaana.com/album/${track.albumseokey}` : null
      }
    }
  }

  mapEntityTrack(json) {
    const getEntityValue = (key) => json.entity_info?.find(e => e.key === key)?.value

    const title = json.name
    const duration = (Number(getEntityValue('duration')) || 0) * 1000
    const artists = getEntityValue('artist')?.map(a => a.name).join(', ') || ''
    const identifier = String(json.entity_id)
    const uri = `https://gaana.com/song/${json.seokey}`

    const info = {
      identifier,
      isSeekable: true,
      author: artists,
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl: json.atw || null,
      isrc: getEntityValue('isrc') || null,
      sourceName: 'gaana'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: {} }
  }

  mapCollectionResult(item, type) {
    const title = item.ti || item.name || 'Unknown'
    const seokey = item.seo || ''
    const uri = `https://gaana.com/${type}/${seokey}`

    const info = {
      identifier: seokey,
      isSeekable: true,
      author: item.sti || 'Gaana',
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl: item.aw || item.atw || null,
      isrc: null,
      sourceName: 'gaana'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: { type } }
  }

  getLoadLimit(type) {
    if (type === 'album') return this.albumLoadLimit
    if (type === 'artist') return this.artistLoadLimit
    return this.playlistLoadLimit
  }

  async getTrackUrl(decodedTrack) {
    try {
      const trackId = decodedTrack.pluginInfo?.trackId || decodedTrack.identifier
      if (trackId && /^\d+$/.test(String(trackId))) {
        const streamInfo = await this.fetchDirectStream(String(trackId))
        if (streamInfo) return streamInfo
      }
    } catch (e) {
      logger('debug', 'Gaana', `Direct stream fetch failed for ${decodedTrack.title}: ${e.message}`)
    }

    logger('warn', 'Gaana', `Direct playback for ${decodedTrack.title} failed. Falling back to YouTube matching.`)

    const searchResult = await this.nodelink.sources.searchWithDefault(`${decodedTrack.title} ${decodedTrack.author}`)
    const bestMatch = getBestMatch(searchResult.data, decodedTrack)

    if (!bestMatch) return { exception: { message: 'No suitable alternative found on YouTube.', severity: 'fault' } }

    const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
    return { newTrack: bestMatch, ...streamInfo }
  }

  async fetchDirectStream(trackId) {
    const quality = this.config.streamQuality || 'high'
    const params = new URLSearchParams({
      quality,
      track_id: trackId,
      stream_format: 'mp4'
    })

    const { body: data, error, statusCode } = await http1makeRequest(STREAM_URL_API, {
      method: 'POST',
      headers: {
        ...this._getHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    })

    if (error || statusCode !== 200 || data?.api_status !== 'success' || !data?.data?.stream_path) return null

    const hlsUrl = this.decryptStreamPath(data.data.stream_path)
    if (!hlsUrl) return null

    try {
      const manifest = await this.parseHlsManifest(hlsUrl)
      if (!manifest.segments.length) return null

      const firstSegment = manifest.segments[0].url
      let format = 'mp4'
      if (firstSegment.includes('.m4s')) format = 'fmp4'
      else if (firstSegment.includes('.mp4')) format = 'mp4'
      else if (firstSegment.includes('.ts')) format = 'mpegts'
      else if (firstSegment.includes('.aac')) format = 'aac'

      return {
        url: hlsUrl,
        protocol: 'hls',
        format: format === 'mpegts' ? 'mpegts' : 'mp4',
        additionalData: {
          initUrl: manifest.segments[0]?.map?.uri,
          segments: manifest.segments,
          format
        }
      }
    } catch (e) {
      logger('debug', 'Gaana', `Manifest parsing failed: ${e.message}. Using HLS protocol as fallback.`)
      return {
        url: hlsUrl,
        protocol: 'hls',
        format: 'mpegts'
      }
    }
  }

  decryptStreamPath(encryptedData) {
    try {
      const offset = parseInt(encryptedData[0], 10)
      if (isNaN(offset)) return ''

      const ciphertextB64 = encryptedData.substring(offset + 16)
      const ciphertext = Buffer.from(ciphertextB64 + '==', 'base64')

      const decipher = createDecipheriv('aes-128-cbc', CRYPTO_KEY, CRYPTO_IV)
      decipher.setAutoPadding(false)

      let decrypted = decipher.update(ciphertext)
      decrypted = Buffer.concat([decrypted, decipher.final()])

      let rawText = decrypted.toString('utf8').replace(/\0/g, '').trim()
      rawText = rawText.split('').filter(c => {
        const code = c.charCodeAt(0)
        return code >= 32 && code <= 126
      }).join('')

      if (rawText.includes('/hls/')) {
        const pathStart = rawText.indexOf('hls/')
        return HLS_BASE_URL + rawText.substring(pathStart)
      }
      return ''
    } catch (e) {
      return ''
    }
  }

  async parseHlsManifest(url) {
    const { body: text } = await http1makeRequest(url, { headers: this._getHeaders() })
    if (!text) throw new Error('Empty manifest')

    let manifest = PlaylistParser.parse(text, url)
    if (manifest.isMaster) {
      const bestVariant = manifest.variants[0]
      const { body: variantText } = await http1makeRequest(bestVariant.url, { headers: this._getHeaders() })
      manifest = PlaylistParser.parse(variantText, bestVariant.url)
    }

    return manifest
  }

  async loadStream(track, url, protocol, additionalData) {
    if (protocol === 'hls') {
      const stream = new HLSHandler(url, {
        type: 'mpegts',
        localAddress: this.nodelink.routePlanner?.getIP(),
        startTime: additionalData?.startTime || 0,
        headers: this._getHeaders()
      })
      return { stream, type: 'mpegts' }
    }

    if (additionalData?.segments?.length) {
      const stream = new PassThrough()
      let segments = additionalData.segments

      if (additionalData.startTime > 0) {
        let elapsed = 0
        const startIndex = segments.findIndex(s => {
          const duration = (s.duration || 0) * 1000
          if (elapsed + duration > additionalData.startTime) return true
          elapsed += duration
          return false
        })
        if (startIndex !== -1) segments = segments.slice(startIndex)
      }

      this.streamSegments(stream, additionalData.initUrl, segments.map(s => s.url || s))

      let type = 'mp4'
      if (additionalData.format === 'ts' || additionalData.format === 'mpegts') type = 'mpegts'
      else if (additionalData.format === 'aac') type = 'aac'

      return { stream, type }
    }

    const { stream, error, statusCode } = await http1makeRequest(url, { method: 'GET', streamOnly: true, headers: this._getHeaders() })
    if (error || statusCode !== 200 || !stream) {
      throw new Error(error?.message || `Stream status ${statusCode}`)
    }

    let type = 'mp4'
    if (url.includes('.ts')) type = 'mpegts'
    else if (url.includes('.aac')) type = 'aac'

    return { stream, type }
  }

  async streamSegments(outputStream, initUrl, segments) {
    const queue = []
    if (initUrl) queue.push(initUrl)
    queue.push(...segments)

    try {
      for (const segmentUrl of queue) {
        if (outputStream.destroyed) break
        await this.streamUrlChunk(outputStream, segmentUrl)
      }
    } catch (e) {
      if (!outputStream.destroyed) outputStream.emit('error', e)
    } finally {
      if (!outputStream.destroyed) {
        outputStream.emit('finishBuffering')
        outputStream.end()
      }
    }
  }

  async streamUrlChunk(outputStream, url) {
    try {
      const { stream, statusCode, error } = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: this._getHeaders()
      })

      if (error || statusCode !== 200 || !stream) {
        logger('warn', 'Gaana', `Segment fetch failed: ${error?.message || statusCode}`)
        return false
      }

      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
          if (!outputStream.destroyed) outputStream.write(chunk)
        })
        stream.on('end', resolve)
        stream.on('error', reject)
      })

      return true
    } catch (e) {
      logger('warn', 'Gaana', `Segment stream error: ${e.message}`)
      return false
    }
  }
}