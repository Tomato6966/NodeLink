/*
* Credits: https://github.com/southctrl; adapted for NodeLink
*/

import { encodeTrack, http1makeRequest, logger } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.js'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: '*/*',
  Origin: 'https://gaana.com',
  Referer: 'https://gaana.com/'
}

export default class GaanaSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.gaana || {}
    this.searchTerms = ['gaanasearch']
    this.patterns = [
      /^@?(?:https?:\/\/)?(?:www\.)?gaana\.com\/(?<type>song|album|playlist|artist)\/(?<seokey>[\w-]+)(?:[?#].*)?$/
    ]
    this.priority = 70
    this.baseUrl = null
    this.maxSearchResults = nodelink.options.maxSearchResults || 10
    const maxAlbumPlaylistLength = nodelink.options.maxAlbumPlaylistLength || 100
    this.playlistLoadLimit = this.config.playlistLoadLimit ?? maxAlbumPlaylistLength
    this.albumLoadLimit = this.config.albumLoadLimit ?? maxAlbumPlaylistLength
    this.artistLoadLimit = this.config.artistLoadLimit ?? maxAlbumPlaylistLength
    this.streamQuality = this.config.streamQuality || 'high'
  }

  async setup() {
    if (this.config.enabled === false) return false

    if (!this.config.apiUrl) {
      logger('warn', 'Gaana', 'Missing apiUrl for Gaana source. Disable or configure sources.gaana.apiUrl.')
      return false
    }

    this.baseUrl = this.config.apiUrl.endsWith('/') ? this.config.apiUrl.slice(0, -1) : this.config.apiUrl

    logger('info', 'Sources', 'Loaded Gaana source.')
    return true
  }

  async search(query, sourceTerm, searchType = 'track') {
    try {
      const endpointMap = {
        track: 'songs',
        album: 'albums',
        playlist: 'playlists',
        artist: 'artists'
      }

      const endpoint = endpointMap[searchType] || 'songs'
      const url = `/api/search/${endpoint}?q=${encodeURIComponent(query)}&limit=${this.maxSearchResults}`

      const data = await this.getJson(url)
      if (!data) return { loadType: 'empty', data: {} }

      if (searchType === 'track') {
        const tracks = data.map((item) => this.mapTrack(item)).filter(Boolean)
        return tracks.length ? { loadType: 'search', data: tracks } : { loadType: 'empty', data: {} }
      }

      const results = data.map((item) => this.mapCollectionResult(item, searchType)).filter(Boolean)
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
    if (!type || !seokey) return { loadType: 'empty', data: {} }

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

  async getTrackUrl(decodedTrack) {
    try {
      let trackId = decodedTrack.identifier

      if (!/^\d+$/.test(String(trackId))) {
        const trackData = await this.getJson(`/api/songs/${encodeURIComponent(trackId)}`)
        if (!trackData?.track_id) {
          return { exception: { message: 'Track metadata not found for stream.', severity: 'common' } }
        }
        trackId = trackData.track_id
      }

      const streamData = await this.getJson(
        `/api/stream/${encodeURIComponent(trackId)}?quality=${encodeURIComponent(this.streamQuality)}`
      )

      if (!streamData) {
        return { exception: { message: 'Stream URL not found.', severity: 'common' } }
      }

      const hlsUrl = streamData.hlsUrl || streamData.hls_url || null
      const url = hlsUrl || streamData.url
      if (!url) {
        return { exception: { message: 'No playable stream URL.', severity: 'common' } }
      }

      const segments = Array.isArray(streamData.segments)
        ? streamData.segments.map((seg) => seg.url || seg).filter(Boolean)
        : []

      const isHls = Boolean(hlsUrl)
      return {
        url,
        protocol: isHls ? 'hls' : 'https',
        format: isHls ? 'mpegts' : streamData.format || 'mp4',
        additionalData: isHls
          ? {}
          : {
              initUrl: streamData.initUrl || streamData.init_url || null,
              segments
            }
      }
    } catch (e) {
      logger('error', 'Gaana', `Stream resolve error: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    if (protocol === 'hls') {
      const stream = new HLSHandler(url, {
        type: 'mpegts',
        localAddress: this.nodelink.routePlanner?.getIP(),
        startTime: additionalData?.startTime || 0
      })
      return { stream, type: 'mpegts' }
    }

    if (additionalData?.segments?.length) {
      const stream = new PassThrough()
      this.streamSegments(stream, additionalData.initUrl, additionalData.segments)
      return { stream, type: 'mp4' }
    }

    const { stream, error, statusCode } = await http1makeRequest(url, { method: 'GET', streamOnly: true, headers: BASE_HEADERS })
    if (error || statusCode !== 200 || !stream) {
      throw new Error(error?.message || `Stream status ${statusCode}`)
    }
    return { stream, type: 'mp4' }
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
        headers: BASE_HEADERS
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

  mapTrack(track) {
    const title = track?.title || track?.name
    if (!title) return null

    const duration = Number(track?.duration || 0) * 1000
    if (!duration) return null

    const author = this.formatArtists(track?.artists) || 'unknown'
    const identifier = track?.track_id ? String(track.track_id) : String(track?.seokey || '')
    if (!identifier) return null

    const seokey = track?.seokey || null
    const uri = track?.song_url || (seokey ? `https://gaana.com/song/${seokey}` : null)

    const info = {
      identifier,
      isSeekable: true,
      author,
      length: duration,
      isStream: false,
      position: 0,
      title,
      uri,
      artworkUrl: track?.artworkUrl || track?.artwork || null,
      isrc: track?.isrc || null,
      sourceName: 'gaana'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: {} }
  }

  mapCollectionResult(item, type) {
    const title = item?.title || item?.name || item?.playlist_name || item?.album || null
    if (!title) return null

    const author =
      this.formatArtists(item?.artists) || item?.author || item?.artist || 'Gaana'

    const seokey = item?.seokey || item?.playlist_id || item?.artist_id || ''
    const url =
      item?.album_url ||
      item?.playlist_url ||
      item?.artist_url ||
      (seokey ? `https://gaana.com/${type}/${seokey}` : null)

    const info = {
      identifier: String(seokey || title),
      isSeekable: true,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: item?.artworkUrl || item?.artwork || null,
      isrc: null,
      sourceName: 'gaana'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: { type } }
  }

  async getSong(seokey) {
    const data = await this.getJson(`/api/songs/${encodeURIComponent(seokey)}`)
    if (!data) return { loadType: 'empty', data: {} }

    const track = this.mapTrack(data)
    return track ? { loadType: 'track', data: track } : { loadType: 'empty', data: {} }
  }

  async getAlbum(seokey) {
    const data = await this.getJson(`/api/albums/${encodeURIComponent(seokey)}`)
    if (!data) return { loadType: 'empty', data: {} }
    return this.buildPlaylist(data, 'album')
  }

  async getPlaylist(seokey) {
    const data = await this.getJson(`/api/playlists/${encodeURIComponent(seokey)}`)
    if (!data) return { loadType: 'empty', data: {} }

    const playlist = data.playlist || data
    return this.buildPlaylist(playlist, 'playlist')
  }

  async getArtist(seokey) {
    const data = await this.getJson(`/api/artists/${encodeURIComponent(seokey)}`)
    if (!data) return { loadType: 'empty', data: {} }
    return this.buildPlaylist(data, 'artist')
  }

  buildPlaylist(data, type) {
    const name = data?.title || data?.name || data?.playlist_name || 'Gaana'
    const tracksArray = data?.tracks || data?.top_tracks || data?.songs || []
    const tracks = tracksArray
      .map((item) => this.mapTrack(item))
      .filter(Boolean)
      .slice(0, this.getLoadLimit(type))

    const infoName = type === 'artist' ? `${name}'s Top Tracks` : name

    return {
      loadType: 'playlist',
      data: {
        info: { name: infoName, selectedTrack: 0 },
        pluginInfo: { type },
        tracks
      }
    }
  }

  getLoadLimit(type) {
    if (type === 'album') return this.albumLoadLimit
    if (type === 'artist') return this.artistLoadLimit
    return this.playlistLoadLimit
  }

  async getJson(path) {
    let finalPath = path.startsWith('/') ? path : `/${path}`
    if (this.baseUrl.endsWith('/api') && finalPath.startsWith('/api')) {
      finalPath = finalPath.slice(4)
    }

    const { body, statusCode, error } = await http1makeRequest(`${this.baseUrl}${finalPath}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: 'https://gaana.com/'
      },
      disableBodyCompression: true
    })

    if (error || statusCode !== 200 || !body) return null

    if (typeof body === 'object' && body.success !== undefined) {
      if (!body.success) return null
      return body.data || body
    }

    return body
  }

  formatArtists(artists) {
    if (!artists) return null
    if (Array.isArray(artists)) return artists.map((a) => a?.name || a).filter(Boolean).join(', ')
    return String(artists)
  }
}
