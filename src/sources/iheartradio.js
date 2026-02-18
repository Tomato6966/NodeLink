/*
* Credits: https://github.com/southctrl
* I added IheartRadio source and ihsearch:query search terms for radio terms.
*/

import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const IHEART_API_V2 = 'https://us.api.iheart.com/api/v2'
const IHEART_API_V1 = 'https://api2.iheart.com/api/v1'

const IHEART_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://www.iheart.com',
  Referer: 'https://www.iheart.com/'
}

const IHEART_PATTERN =
  /https?:\/\/(?:www\.)?iheart\.com\/live\/(?:[a-zA-Z0-9-]+-)?(\d+)\/?$/

export default class IheartradioSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [IHEART_PATTERN]
    this.searchTerms = ['ihsearch', 'iheartradio']
    this.recommendationTerm = []
    this.priority = 60
    this.maxSearchResults = nodelink.options.maxSearchResults || 10
  }

  async setup() {
    logger('info', 'Sources', 'Loaded iHeartRadio source.')
    return true
  }

  async _request(url) {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: IHEART_HEADERS
      })

      if (statusCode !== 200) {
        logger('warn', 'iHeart', `HTTP ${statusCode} for ${url}`)
        return null
      }

      return body
    } catch (e) {
      logger('error', 'iHeart', `Request failed for ${url}: ${e.message}`)
      return null
    }
  }

  async _resolvePls(plsUrl) {
    try {
      const { body, statusCode } = await http1makeRequest(plsUrl, {
        headers: { 'User-Agent': IHEART_HEADERS['User-Agent'] }
      })

      if (statusCode !== 200 || !body) return plsUrl

      const text = typeof body === 'string' ? body : body.toString()
      const match = text.match(/^File\d+=(.+)$/m)
      return match ? match[1].trim() : plsUrl
    } catch {
      return plsUrl
    }
  }

  async _getStreamUrl(stationId) {
    try {
      const data = await this._request(
        `${IHEART_API_V2}/content/liveStations/${stationId}`
      )

      if (!data) return null

      const station = data.hits?.[0] || data.station || data
      const streams = station.streams || {}

      const streamUrl =
        streams.shoutcast_stream ||
        streams.secure_mp3_pls_stream ||
        streams.hls_stream ||
        streams.mp3_pls_stream ||
        streams.secure_hls_stream ||
        streams.pivot_hls_stream ||
        Object.values(streams).find(Boolean) ||
        null

      if (!streamUrl) {
        logger('warn', 'iHeart', `No stream URL found for station ${stationId}`)
        return null
      }

      if (typeof streamUrl === 'string' && streamUrl.endsWith('.pls')) {
        return this._resolvePls(streamUrl)
      }

      return streamUrl
    } catch (e) {
      logger('error', 'iHeart', `_getStreamUrl failed for ${stationId}: ${e.message}`)
      return null
    }
  }

  _buildTrack(station) {
    if (!station) return null

    const id = String(station.id || station.stationId || '')
    if (!id) return null

    const name =
      station.name ||
      station.callLetters ||
      station.stationName ||
      `iHeart Station ${id}`

    const artworkUrl =
      station.logo ||
      station.newThumbnailUrl ||
      station.profileImage ||
      station.imageUrl ||
      null

    const city = station.markets?.[0]?.cityName || station.city || null

    const info = {
      identifier: id,
      isSeekable: false,
      author: city || 'iHeartRadio',
      length: 0,
      isStream: true,
      position: 0,
      title: name,
      uri: `https://www.iheart.com/live/${id}/`,
      artworkUrl,
      isrc: null,
      sourceName: 'iheartradio'
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {
        description: station.description || null,
        genre:
          station.genres?.[0]?.name ||
          station.genre?.name ||
          station.genreName ||
          null,
        frequency: station.freq || station.frequency || null,
        band: station.band || null,
        city,
        state: station.stateAbbreviation || null,
        website: station.website || null
      }
    }
  }

  async search(query, _sourceTerm) {
    try {
      const encoded = encodeURIComponent(query)

      const data = await this._request(
        `${IHEART_API_V1}/catalog/searchAll` +
          `?keywords=${encoded}` +
          `&bestMatch=True` +
          `&queryStation=True` +
          `&queryArtist=False` +
          `&queryTrack=False` +
          `&queryTalkShow=True` +
          `&startIndex=0` +
          `&maxRows=${this.maxSearchResults}` +
          `&queryFeaturedStation=True` +
          `&queryBundle=False` +
          `&queryTalkTheme=False` +
          `&amp_version=4.11.0`
      )

      if (!data) return { loadType: 'empty', data: {} }

      const stations = data.stations || data.results?.stations?.hits || []

      if (stations.length === 0) return { loadType: 'empty', data: {} }

      const tracks = stations
        .map((hit) => this._buildTrack(hit.station || hit))
        .filter(Boolean)
        .slice(0, this.maxSearchResults)

      return { loadType: 'search', data: tracks }
    } catch (e) {
      logger('error', 'iHeart', `Search failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const match = url.match(IHEART_PATTERN)
      if (!match) return { loadType: 'empty', data: {} }

      return this._resolveById(match[1])
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _resolveById(stationId) {
    const data = await this._request(
      `${IHEART_API_V2}/content/liveStations/${stationId}`
    )

    if (!data) {
      return {
        exception: {
          message: `iHeart station ${stationId} not found.`,
          severity: 'common'
        }
      }
    }

    const station = data.hits?.[0] || data.station || data
    const track = this._buildTrack(station)

    if (!track) {
      return {
        exception: {
          message: 'Failed to build track from station data.',
          severity: 'fault'
        }
      }
    }

    logger(
      'info',
      'iHeart',
      `Resolved station ${stationId}: ${track.info.title}`
    )
    return { loadType: 'track', data: track }
  }

  async getTrackUrl(decodedTrack) {
    try {
      const streamUrl = await this._getStreamUrl(decodedTrack.identifier)

      if (!streamUrl) {
        return {
          exception: {
            message: `Could not resolve stream URL for iHeart station ${decodedTrack.identifier}.`,
            severity: 'fault'
          }
        }
      }

      const httpTrackInfo = {
        ...decodedTrack,
        uri: streamUrl,
        sourceName: 'http'
      }
      return this.nodelink.sources.getTrackUrl(httpTrackInfo)
    } catch (e) {
      logger('error', 'iHeart', `getTrackUrl failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(decodedTrack, url) {
    try {
      const streamUrl =
        url || (await this._getStreamUrl(decodedTrack.identifier))

      if (!streamUrl) {
        throw new Error(
          `Could not resolve stream URL for iHeart station ${decodedTrack.identifier}.`
        )
      }

      const httpSource = this.nodelink.sources.getSource('http')
      if (!httpSource) {
        throw new Error('http source not available for stream delegation')
      }

      const httpTrackInfo = {
        ...decodedTrack,
        uri: streamUrl,
        sourceName: 'http'
      }
      return httpSource.loadStream(httpTrackInfo, streamUrl)
    } catch (e) {
      logger('error', 'iHeart', `loadStream failed: ${e.message}`)
      throw e
    }
  }
}
