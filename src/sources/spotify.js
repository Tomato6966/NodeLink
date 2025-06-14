import crypto from 'node:crypto'
import { encodeTrack, logger, http1makeRequest } from '../utils.js'

export default class SpotifySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['spsearch']
    this.patterns = [
      /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-zA-Z]{2}\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/
    ]

    this.accessToken = null
    this.clientToken = null
  }

  static TOTP_SECRET = new Uint8Array([
    53, 53, 48, 55, 49, 52, 53, 56, 53, 51, 52, 56, 55, 52, 57, 57, 53, 57, 50, 50, 52, 56, 54, 51,
    48, 51, 50, 57, 51, 52, 55
  ])

  async setup() {
    const [totp, ts] = this._generateTotp()
    const params = new URLSearchParams({
      reason: 'init',
      productType: 'web-player',
      totp,
      totpVer: '5',
      ts: ts.toString()
    })

    const { body: tokenData } = await http1makeRequest(
      `https://open.spotify.com/api/token?${params}`,
      {
        headers: {
          accept: 'application/json'
        },
        disableBodyCompression: true
      }
    )
    if (!tokenData || !tokenData?.accessToken || !tokenData?.clientId) {
      logger('error', 'spotify', 'Failed to fetch access token: Invalid response')
      return false
    }

    if (tokenData?.error) {
      logger('error', 'spotify', `Failed to fetch access token: ${tokenData.error.message}`)
      return false
    }
    const { body: clientTokenData } = await http1makeRequest(
      'https://clienttoken.spotify.com/v1/clienttoken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', accept: 'application/json' },
        body: {
          client_data: {
            client_version: '1.2.9.2269',
            client_id: tokenData.clientId,
            js_sdk_data: {
              device_type: 'computer'
            }
          }
        },
        disableBodyCompression: true
      }
    )
    if (
      !clientTokenData ||
      !clientTokenData?.granted_token ||
      !clientTokenData?.granted_token?.token
    ) {
      logger('error', 'spotify', 'Failed to fetch client token: Invalid response')
      return false
    }
    if (clientTokenData.response_type !== 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
      logger('error', 'spotify', `Failed to fetch client token: ${JSON.stringify(clientTokenData)}`)
      return false
    }

    this.accessToken = tokenData.accessToken
    this.clientToken = clientTokenData.granted_token.token

    return true
  }

  async search(query) {
    try {
      const limit = this.config.maxSearchResults || 10
      const { body } = await this._apiRequest(
        `/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&market=US`
      )

      if (body.error) {
        return { loadType: 'error', data: { message: body.error.message, severity: 'common' } }
      }

      if (!body.tracks || body.tracks.items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = body.tracks.items.map(item => this.buildTrack(item))

      return { loadType: 'search', data: tracks }
    } catch (e) {
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const match = url.match(this.patterns[0])
      if (!match) return { loadType: 'empty', data: {} }

      const [, type, id] = match

      switch (type) {
        case 'track': {
          const { body } = await this._apiRequest(`/tracks/${id}`)
          return { loadType: 'track', data: this.buildTrack(body) }
        }
        case 'album': {
          const { body } = await this._apiRequest(`/albums/${id}`)
          const tracks = body.tracks.items.map(item => this.buildTrack(item, body.images[0]?.url))
          return {
            loadType: 'playlist',
            data: { info: { name: body.name, selectedTrack: 0 }, tracks }
          }
        }
        case 'playlist': {
          const { body } = await this._apiRequest(`/playlists/${id}`)
          const tracks = body.tracks.items.map(item => this.buildTrack(item.track))
          return {
            loadType: 'playlist',
            data: { info: { name: body.name, selectedTrack: 0 }, tracks }
          }
        }
        case 'artist': {
          const { body: artist } = await this._apiRequest(`/artists/${id}`)
          const { body: topTracks } = await this._apiRequest(`/artists/${id}/top-tracks?market=US`)
          const tracks = topTracks.tracks.map(item => this.buildTrack(item, artist.images[0]?.url))
          return {
            loadType: 'playlist',
            data: { info: { name: `${artist.name}'s Top Tracks`, selectedTrack: 0 }, tracks }
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
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  buildTrack(item, artworkUrl = null) {
    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: item.artists?.map(a => a.name).join(', ') || 'Unknown',
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

  async getTrackUrl(decodedTrack) {
    const query = `${decodedTrack.title} - ${decodedTrack.author}`

    try {
      const searchResult = await this.nodelink.sources.searchWithDefault(query)
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        throw new Error('No alternative stream found via default search.')
      }

      const newTrack = searchResult.data[0]
      const streamInfo = await this.nodelink.sources.getTrackUrl(newTrack.info)
      return { newTrack: newTrack, ...streamInfo }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _apiRequest(endpoint) {
    if (!this.accessToken) {
      const success = await this.setup()
      if (!success) throw new Error('Failed to initialize Spotify for API request.')
    }

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json'
    }

    let { body, statusCode } = await http1makeRequest(`https://api.spotify.com/v1${endpoint}`, {
      headers
    })

    if (statusCode === 401) {
      const success = await this.setup()
      if (!success) throw new Error('Failed to re-initialize Spotify after 401.')

      headers.Authorization = `Bearer ${this.accessToken}`
      const res = await http1makeRequest(`https://api.spotify.com/v1${endpoint}`, { headers })
      body = res.body
    }

    return { body }
  }

  _generateTotp() {
    const counter = Math.floor(Date.now() / 30000)
    const buf = Buffer.alloc(8)
    buf.writeBigInt64BE(BigInt(counter))
    const hmac = crypto.createHmac('sha1', SpotifySource.TOTP_SECRET).update(buf).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const bin =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    const totp = (bin % 1e6).toString().padStart(6, '0')
    return [totp, counter * 30000]
  }
}
