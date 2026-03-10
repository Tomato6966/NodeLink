/*
 * Made by: https://github.com/southctrl
 * I've added support for ncsearch!
 */

import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

const NETEASE_TRACK_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/song\?id=(\d+)/
const NETEASE_ALBUM_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/album\?id=(\d+)/
const NETEASE_PLAYLIST_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/playlist\?id=(\d+)/
const NETEASE_ARTIST_PATTERN =
  /^https?:\/\/(?:www\.)?music\.163\.com\/?#?\/artist\?id=(\d+)/

const BASE_API = 'https://music.163.com/api'
const STREAM_URL = 'https://music.163.com/song/media/outer/url?id='

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity'
}

export default class NeteaseSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.netease || {}
    this.patterns = [
      NETEASE_TRACK_PATTERN,
      NETEASE_ALBUM_PATTERN,
      NETEASE_PLAYLIST_PATTERN,
      NETEASE_ARTIST_PATTERN
    ]
    this.priority = 45
    this.searchTerms = ['ncsearch']
    this.maxSearchResults = nodelink.options.maxSearchResults || 10
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Netease Cloud Music source.')
    return true
  }

  isLinkMatch(link) {
    return (
      NETEASE_TRACK_PATTERN.test(link) ||
      NETEASE_ALBUM_PATTERN.test(link) ||
      NETEASE_PLAYLIST_PATTERN.test(link) ||
      NETEASE_ARTIST_PATTERN.test(link)
    )
  }

  async search(query, _sourceTerm, searchType = 'track') {
    try {
      const typeMap = {
        track: 1,
        album: 10,
        artist: 100,
        playlist: 1000
      }
      const type = typeMap[searchType] ?? 1

      const url =
        `${BASE_API}/search/get?s=${encodeURIComponent(query)}` +
        `&type=${type}&limit=${this.maxSearchResults}&offset=0`

      const { body, statusCode, error } = await http1makeRequest(url, {
        method: 'GET',
        headers: HEADERS
      })

      if (error || statusCode !== 200 || !body) {
        return {
          exception: {
            message: `Netease search failed: ${error?.message || statusCode}`,
            severity: 'fault'
          }
        }
      }

      const results = this._mapSearchResults(body, searchType)
      return results.length
        ? { loadType: 'search', data: results }
        : { loadType: 'empty', data: {} }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const trackMatch = url.match(NETEASE_TRACK_PATTERN)
      if (trackMatch) {
        return await this._resolveTrack(trackMatch[1], url)
      }

      const albumMatch = url.match(NETEASE_ALBUM_PATTERN)
      if (albumMatch) {
        return await this._resolveAlbum(albumMatch[1], url)
      }

      const playlistMatch = url.match(NETEASE_PLAYLIST_PATTERN)
      if (playlistMatch) {
        return await this._resolvePlaylist(playlistMatch[1], url)
      }

      const artistMatch = url.match(NETEASE_ARTIST_PATTERN)
      if (artistMatch) {
        return await this._resolveArtist(artistMatch[1], url)
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Netease', `Exception during resolve: ${e.message}`, e)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _resolveTrack(id, originalUrl) {
    const { body, statusCode, error } = await http1makeRequest(
      `${BASE_API}/song/detail/?id=${id}&ids=[${id}]`,
      { method: 'GET', headers: HEADERS }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Failed to fetch Netease track: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const songs = body?.songs || []
    if (!songs.length) return { loadType: 'empty', data: {} }

    const song = songs[0]
    const track = this._buildTrackResult(song, originalUrl)

    logger(
      'info',
      'Netease',
      `Resolved track: ${song.name} by ${this._getArtists(song)}`
    )
    return { loadType: 'track', data: track }
  }

  async _resolveAlbum(id, originalUrl) {
    const { body, statusCode, error } = await http1makeRequest(
      `${BASE_API}/album?id=${id}`,
      { method: 'GET', headers: HEADERS }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Failed to fetch Netease album: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const album = body?.album
    const songs = body?.songs || []
    if (!songs.length) return { loadType: 'empty', data: {} }

    const tracks = songs.map((song) =>
      this._buildTrackResult(song, originalUrl)
    )
    const name = album?.name || 'Unknown Album'
    const artist = album?.artist?.name || 'Unknown Artist'

    logger(
      'info',
      'Netease',
      `Resolved album: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name: `${name} — ${artist}`, selectedTrack: 0 },
        pluginInfo: {},
        tracks
      }
    }
  }

  async _resolvePlaylist(id, originalUrl) {
    const { body, statusCode, error } = await http1makeRequest(
      `${BASE_API}/playlist/detail?id=${id}`,
      { method: 'GET', headers: HEADERS }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Failed to fetch Netease playlist: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const playlist = body?.result || body?.playlist
    const songs = playlist?.tracks || []
    if (!songs.length) return { loadType: 'empty', data: {} }

    const tracks = songs.map((song) =>
      this._buildTrackResult(song, originalUrl)
    )
    const name = playlist?.name || 'Unknown Playlist'

    logger(
      'info',
      'Netease',
      `Resolved playlist: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name, selectedTrack: 0 },
        pluginInfo: {},
        tracks
      }
    }
  }

  async _resolveArtist(id, originalUrl) {
    const { body, statusCode, error } = await http1makeRequest(
      `${BASE_API}/artist/top?id=${id}&limit=${this.maxSearchResults}&offset=0&total=false`,
      { method: 'GET', headers: HEADERS }
    )

    if (error || statusCode !== 200 || !body) {
      return {
        exception: {
          message: `Failed to fetch Netease artist: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }

    const artist = body?.artist
    const songs = body?.hotSongs || []
    if (!songs.length) return { loadType: 'empty', data: {} }

    const tracks = songs.map((song) =>
      this._buildTrackResult(song, originalUrl)
    )
    const name = artist?.name || 'Unknown Artist'

    logger(
      'info',
      'Netease',
      `Resolved artist top tracks: ${name} with ${tracks.length} tracks`
    )
    return {
      loadType: 'playlist',
      data: {
        info: { name: `${name} — Top Tracks`, selectedTrack: 0 },
        pluginInfo: {},
        tracks
      }
    }
  }

  _mapSearchResults(body, searchType) {
    const result = body?.result || {}

    if (searchType === 'album') {
      const albums = result?.albums || []
      return albums.map((album) =>
        this._buildCollectionResult(
          album.name,
          album.artist?.name || 'Unknown',
          `https://music.163.com/#/album?id=${album.id}`,
          'album'
        )
      )
    }

    if (searchType === 'artist') {
      const artists = result?.artists || []
      return artists.map((artist) =>
        this._buildCollectionResult(
          artist.name,
          'Netease',
          `https://music.163.com/#/artist?id=${artist.id}`,
          'artist'
        )
      )
    }

    if (searchType === 'playlist') {
      const playlists = result?.playlists || []
      return playlists.map((pl) =>
        this._buildCollectionResult(
          pl.name,
          pl.creator?.nickname || 'Unknown',
          `https://music.163.com/#/playlist?id=${pl.id}`,
          'playlist'
        )
      )
    }

    // Default: tracks
    const songs = result?.songs || []
    return songs.map((song) =>
      this._buildTrackResult(song, `https://music.163.com/#/song?id=${song.id}`)
    )
  }

  _buildTrackResult(song, uri) {
    const artist = this._getArtists(song)
    const duration = song.duration || song.dt || 0
    const artworkUrl = song.album?.picUrl || song.al?.picUrl || null

    const info = {
      identifier: String(song.id),
      isSeekable: true,
      author: artist,
      length: duration,
      isStream: false,
      position: 0,
      title: song.name,
      uri: uri || `https://music.163.com/#/song?id=${song.id}`,
      artworkUrl,
      isrc: null,
      sourceName: 'netease'
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: { neteaseId: String(song.id) }
    }
  }

  _buildCollectionResult(title, author, url, type) {
    const info = {
      identifier: url,
      isSeekable: false,
      author,
      length: 0,
      isStream: false,
      position: 0,
      title,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'netease'
    }

    return { encoded: encodeTrack(info), info, pluginInfo: { type } }
  }

  _getArtists(song) {
    // Netease can have multiple artists in an array, so we join them with commas
    const list = song.artists || song.ar || []
    if (list.length) return list.map((a) => a.name).join(', ')
    return song.artist?.name || 'Unknown'
  }

  async getTrackUrl(decodedTrack) {
    try {
      const neteaseId =
        decodedTrack?.pluginInfo?.neteaseId || decodedTrack?.identifier

      if (neteaseId && /^\d+$/.test(neteaseId)) {
        // Netease provides direct MP3 URLs for tracks, so we can return that immediately
        const streamUrl = `${STREAM_URL}${neteaseId}.mp3`
        logger('info', 'Netease', `Returning stream URL for id ${neteaseId}`)
        return { url: streamUrl, protocol: 'https' }
      }

      // If we don't have a valid Netease ID, we can attempt to find a matching track on YouTube as a fallback
      const query = `${decodedTrack.title} ${decodedTrack.author}`.trim()
      let searchResult = await this.nodelink.sources.search(
        'youtube',
        query,
        'ytmsearch'
      )

      if (searchResult.loadType !== 'search' || !searchResult.data?.length) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (searchResult.loadType !== 'search' || !searchResult.data?.length) {
        return {
          exception: {
            message: 'No matching track found on fallback source.',
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
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    return this.nodelink.sources.loadStream(
      track,
      url,
      protocol,
      additionalData
    )
  }
}
