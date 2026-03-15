/**
 * Now uses hifi api for direct streaming (if available )
 * credits: https://github.com/binimum/hifi-api/
 */

import path from 'node:path'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../utils.ts'

const API_BASE = 'https://api.tidal.com/v1/'
const CACHE_VALIDITY_DAYS = 7
const TIDAL_ASSET_URL = 'https://tidal.com/assets/index-CJ0DsMmf.js'

const _functions = {
  extractSecondClientId(text) {
    const re = /clientId\s*[:=]\s*"([^"]+)"/g
    let match,
      count = 0
    while ((match = re.exec(text))) {
      if (++count === 2) return match[1]
    }
    return null
  }
}

export default class TidalSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources.tidal
    this.searchTerms = ['tdsearch']
    this.recommendationTerm = ['tdrec']
    this.patterns = [
      /^https?:\/\/(?:(?:listen|www)\.)?tidal\.com\/(?:browse\/)?(?<type>album|track|playlist|mix|artist)\/(?<id>[a-zA-Z0-9-]+)(?:\/[a-zA-Z0-9/_-]*)?(?:\?.*)?$/
    ]
    this.priority = 90
    this.token = this.config?.token
    this.countryCode = this.config?.countryCode || 'US'
    this.playlistLoadLimit = this.config?.playlistLoadLimit ?? 2
    this.playlistPageLoadConcurrency =
      this.config?.playlistPageLoadConcurrency ?? 5
    this.tokenCachePath = path.join(process.cwd(), '.cache', 'tidal_token.json')
    this.hifiApis = (this.config?.hifiApis ?? []).map((u) =>
      u.replace(/\/$/, '')
    )
    this.hifiQualities = this.config?.hifiQualities ?? [
      'HI_RES_LOSSLESS',
      'LOSSLESS',
      'HIGH',
      'LOW'
    ]
  }

  async setup() {
    if (this.token && this.token !== 'token_here') return true

    const cachedToken = this.nodelink.credentialManager.get('tidal_token')
    if (cachedToken) {
      this.token = cachedToken
      logger('info', 'Tidal', 'Loaded valid token from CredentialManager.')
      return true
    }

    try {
      const res = await fetch(TIDAL_ASSET_URL)
      if (!res.ok) throw new Error(`Status ${res.status}`)

      const token = _functions.extractSecondClientId(await res.text())

      if (token) {
        this.token = token
        logger('info', 'Tidal', 'Fetched new token.')
        this.nodelink.credentialManager.set(
          'tidal_token',
          token,
          CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000
        )
      } else {
        logger('warn', 'Tidal', 'No clientId found in remote asset')
      }
    } catch (err) {
      logger('warn', 'Tidal', `Token fetch failed: ${err.message}`)
    }

    return true
  }

  async _getJson(endpoint, params = {}) {
    const url = new URL(`${API_BASE}${endpoint}`)
    params.countryCode = this.countryCode
    for (const key in params) {
      url.searchParams.append(key, params[key])
    }
    const finalUrl = url.toString()

    const { body, error, statusCode } = await http1makeRequest(finalUrl, {
      headers: {
        'x-tidal-token': this.token,
        'User-Agent': 'TIDAL/3704 CFNetwork/1220.1 Darwin/20.3.0'
      }
    })

    if (error || statusCode !== 200) {
      throw new Error(
        `Failed to fetch from Tidal API: ${error?.message || `Status ${statusCode}`}`
      )
    }

    return body
  }

  async search(query, sourceTerm) {
    if (this.recommendationTerm.includes(sourceTerm)) {
      return this.getRecommendations(query)
    }

    try {
      const limit = this.nodelink.options.maxSearchResults || 10
      const data = await this._getJson('search', {
        query,
        limit,
        types: 'TRACKS'
      })

      if (!data || !data.tracks || data.tracks.items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = data.tracks.items.map((item) => this._parseTrack(item))
      return { loadType: 'search', data: tracks }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) {
      return { loadType: 'empty', data: {} }
    }
    let { type, id } = match.groups

    const nestedTrack = url.match(
      /\/album\/[a-zA-Z0-9-]+\/track\/(?<trackId>[a-zA-Z0-9-]+)/
    )
    if (nestedTrack) {
      type = 'track'
      id = nestedTrack.groups.trackId
    }

    try {
      switch (type) {
        case 'track': {
          const data = await this._getJson(`tracks/${id}`)
          if (!data) return { loadType: 'empty', data: {} }
          return { loadType: 'track', data: this._parseTrack(data) }
        }
        case 'album': {
          const albumData = await this._getJson(`albums/${id}`)
          const tracksData = await this._getJson(`albums/${id}/tracks`, {
            limit: 100
          })
          if (!tracksData || tracksData.items.length === 0)
            return { loadType: 'empty', data: {} }

          const tracks = tracksData.items.map((item) => this._parseTrack(item))
          return {
            loadType: 'playlist',
            data: { info: { name: albumData.title, selectedTrack: 0 }, tracks }
          }
        }
        case 'mix':
          return this.getMix(id)
        case 'playlist': {
          const playlistData = await this._getJson(`playlists/${id}`)
          const totalTracks = playlistData.numberOfTracks
          if (!totalTracks) return { loadType: 'empty', data: {} }

          const firstPageData = await this._getJson(`playlists/${id}/tracks`, {
            limit: 50,
            offset: 0
          })
          if (
            !firstPageData ||
            !firstPageData.items ||
            firstPageData.items.length === 0
          ) {
            return { loadType: 'empty', data: {} }
          }

          const allItems = [...firstPageData.items]
          const limit = 50

          let pagesToFetch = Math.ceil(totalTracks / limit)
          if (this.playlistLoadLimit > 0) {
            pagesToFetch = Math.min(pagesToFetch, this.playlistLoadLimit)
          }

          const promises = []
          for (let i = 1; i < pagesToFetch; i++) {
            const offset = i * limit
            promises.push(
              this._getJson(`playlists/${id}/tracks`, { limit, offset })
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
                  'Tidal',
                  `Failed to fetch a batch of playlist pages: ${e.message}`
                )
              }
            }
          }

          const tracks = allItems
            .map((item) => this._parseTrack(item.item || item))
            .filter(Boolean)

          logger(
            'info',
            'Tidal',
            `Loaded ${tracks.length} of ${totalTracks} tracks from playlist "${playlistData.title}".`
          )

          return {
            loadType: 'playlist',
            data: {
              info: { name: playlistData.title, selectedTrack: 0 },
              tracks
            }
          }
        }
        case 'artist': {
          if (!this.hifiApis.length) {
            logger(
              'warn',
              'Tidal',
              `No hifi APIs configured, cannot load artist ${id}`
            )
            return { loadType: 'empty', data: {} }
          }

          const baseUrl = this.hifiApis[0]
          logger('debug', 'Tidal', `Fetching artist data via hifi for: ${id}`)

          const [infoRes, tracksRes] = await Promise.all([
            http1makeRequest(`${baseUrl}/artist/?id=${id}`, {}),
            http1makeRequest(`${baseUrl}/artist/?f=${id}&skip_tracks=true`, {})
          ])

          if (
            tracksRes.error ||
            tracksRes.statusCode !== 200 ||
            !tracksRes.body?.tracks?.length
          ) {
            logger(
              'warn',
              'Tidal',
              `hifi artist tracks fetch failed for ${id}: ${tracksRes.error?.message ?? tracksRes.statusCode}`
            )
            return { loadType: 'empty', data: {} }
          }

          const name = infoRes.body?.artist?.name ?? `Artist ${id}`
          const tracks = tracksRes.body.tracks
            .map((item) => this._parseTrack(item))
            .filter(Boolean)
          logger(
            'debug',
            'Tidal',
            `Loaded ${tracks.length} tracks for artist "${name}"`
          )

          return {
            loadType: 'playlist',
            data: { info: { name, selectedTrack: 0 }, tracks }
          }
        }
      }
      return { loadType: 'empty', data: {} }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async getRecommendations(query) {
    let trackId = query
    if (!/^[0-9]+$/.test(query)) {
      const searchRes = await this.search(query, 'tdsearch')
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
        trackId = searchRes.data[0].info.identifier
      } else {
        return { loadType: 'empty', data: {} }
      }
    }

    try {
      const data = await this._getJson(`tracks/${trackId}`)
      if (!data?.mixes?.TRACK_MIX) return { loadType: 'empty', data: {} }

      return this.getMix(data.mixes.TRACK_MIX)
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getMix(mixId) {
    try {
      const data = await this._getJson(`mixes/${mixId}/items`, { limit: 100 })
      if (!data?.items?.length) return { loadType: 'empty', data: {} }

      const tracks = data.items
        .map((item) => this._parseTrack(item.item || item))
        .filter(Boolean)
      return {
        loadType: 'playlist',
        data: {
          info: { name: `Mix: ${mixId}`, selectedTrack: 0 },
          pluginInfo: { type: 'recommendations' },
          tracks
        }
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _parseTrack(item) {
    if (!item || !item.id) return null
    const trackInfo = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.artists.map((a) => a.name).join(', '),
      length: item.duration * 1000,
      isStream: false,
      position: 0,
      title: item.title,
      uri: item.url,
      artworkUrl: `https://resources.tidal.com/images/${item.album.cover.replace(/-/g, '/')}/1280x1280.jpg`,
      isrc: item.isrc || null,
      sourceName: 'tidal'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async _getHifiStreamUrl(trackId) {
    if (!this.hifiApis.length) {
      logger('warn', 'Tidal', 'No hifi APIs configured, skipping direct stream')
      return null
    }

    for (const baseUrl of this.hifiApis) {
      for (const quality of this.hifiQualities) {
        const url = `${baseUrl}/track/?id=${trackId}&quality=${quality}`
        logger('debug', 'Tidal', `Trying hifi: ${url}`)
        try {
          const { body, error, statusCode } = await http1makeRequest(url, {})
          if (error || statusCode !== 200 || !body) {
            logger(
              'debug',
              'Tidal',
              `  ✗ ${quality} @ ${baseUrl} → ${error?.message ?? statusCode}`
            )
            continue
          }

          const rawManifest = body?.data?.manifest
          if (!rawManifest) {
            logger(
              'debug',
              'Tidal',
              `  ✗ ${quality} @ ${baseUrl} → no manifest field`
            )
            continue
          }

          const manifest = JSON.parse(
            Buffer.from(rawManifest, 'base64').toString('utf8')
          )
          const streamUrl = manifest?.urls?.[0]
          if (!streamUrl) {
            logger(
              'debug',
              'Tidal',
              `  ✗ ${quality} @ ${baseUrl} → no URL in manifest`
            )
            continue
          }

          const mimeType = manifest.mimeType ?? ''
          const format = mimeType.includes('flac') ? 'flac' : 'mp4'

          logger(
            'debug',
            'Tidal',
            `  ✓ Direct stream: quality=${quality} format=${format} codec=${manifest.codecs} api=${baseUrl}`
          )
          return { url: streamUrl, quality, format }
        } catch (e) {
          logger('debug', 'Tidal', `  ✗ ${quality} @ ${baseUrl} → ${e.message}`)
        }
      }
    }

    logger(
      'warn',
      'Tidal',
      `All hifi APIs exhausted for track ${trackId}, will mirror`
    )
    return null
  }

  async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
    try {
      logger(
        'debug',
        'Tidal',
        `Attempting direct hifi for: ${decodedTrack.title} [${decodedTrack.identifier}]`
      )
      const direct = await this._getHifiStreamUrl(decodedTrack.identifier)

      if (direct) {
        return { url: direct.url, protocol: 'https', format: direct.format }
      }

      logger(
        'debug',
        'Tidal',
        `Falling back to YouTube mirror for: ${decodedTrack.title}`
      )
      const query = `${decodedTrack.title} ${decodedTrack.author}`

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
        )
          searchResult = null
      }

      if (!searchResult) {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          query,
          'ytmsearch'
        )
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
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

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        bestMatch.info,
        itag,
        forceRefresh
      )
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger(
        'error',
        'Tidal',
        `getTrackUrl failed for "${decodedTrack.title}": ${e.message}`
      )
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      const { stream, error, statusCode } = await makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (error || (statusCode !== 200 && statusCode !== 206)) {
        const msg = error?.message ?? `Status ${statusCode}`
        logger(
          'error',
          'Tidal',
          `Stream fetch failed for ${decodedTrack.title}: ${msg}`
        )
        return {
          exception: { message: msg, severity: 'fault', cause: 'Upstream' }
        }
      }

      logger('debug', 'Tidal', `Streaming ${decodedTrack.title} directly`)
      return { stream }
    } catch (e) {
      logger(
        'error',
        'Tidal',
        `loadStream error for ${decodedTrack.title}: ${e.message}`
      )
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}
