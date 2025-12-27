import { encodeTrack, http1makeRequest, logger, getBestMatch } from '../utils.js'
import fs from 'node:fs/promises'
import path from 'node:path'

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
    this.patterns = [
      /^https?:\/\/(?:(?:listen|www)\.)?tidal\.com\/(?:browse\/)?(?<type>album|track|playlist|mix)\/(?<id>[a-zA-Z0-9\-]+)/
    ]
    this.priority = 90
    this.token = this.config?.token
    this.countryCode = this.config?.countryCode || 'US'
    this.playlistLoadLimit = this.config?.playlistLoadLimit ?? 2
    this.playlistPageLoadConcurrency =
      this.config?.playlistPageLoadConcurrency ?? 5
    this.tokenCachePath = path.join(process.cwd(), '.cache', 'tidal_token.json')
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
        this.nodelink.credentialManager.set('tidal_token', token, CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
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

  async search(query) {
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

    const { type, id } = match.groups

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
      }
      return { loadType: 'empty', data: {} }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
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

  async getTrackUrl(decodedTrack) {
    const query = `${decodedTrack.title} ${decodedTrack.author}`

    try {
      let searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch')
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
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

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger('error', 'Tidal', `Failed to mirror track: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    throw new Error(
      'Tidal source uses mirroring and does not load streams directly.'
    )
  }
}