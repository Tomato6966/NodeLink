import { http1makeRequest, logger, encodeTrack , getBestMatch} from '../utils.js'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'

const audiomackPatterns = [
  /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/song\/[^/]+(?:\?.*)?$/i,
  /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/album\/[^/]+(?:\?.*)?$/i,
  /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+\/playlist\/[^/]+(?:\?.*)?$/i,
  /https?:\/\/(?:www\.)?audiomack\.com\/[^/]+(?:\/)?(?:\?.*)?$/i,
  /https?:\/\/(?:www\.)?audiomack\.com\/search(?:\?.*)?$/i
]

const API_BASE = 'https://api.audiomack.com/v1'
const CONSUMER_KEY = 'audiomack-web'
const CONSUMER_SECRET = 'bd8a07e9f23fbe9d808646b730f89b8e'

const STRICT_URI_RE = /[!'()*]/g
function strictEncodeURIComponent(str) {
  return encodeURIComponent(String(str)).replace(
    STRICT_URI_RE,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

function buildParamString(params) {
  return Object.keys(params)
    .sort()
    .map(
      (k) =>
        `${strictEncodeURIComponent(k)}=${strictEncodeURIComponent(params[k])}`
    )
    .join('&')
}

function parseJsonBody(body) {
  if (!body) return null
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function normalizeApiResult(json) {
  if (!json) return null
  let data = json.results ?? json.result ?? json
  if (Array.isArray(data)) data = data[0]
  return data || null
}

function getUrlExtension(u) {
  if (!u || typeof u !== 'string') return ''
  try {
    const p = new URL(u).pathname
    const i = p.lastIndexOf('.')
    return i === -1 ? '' : p.slice(i + 1).toLowerCase()
  } catch {
    const base = u.split('?')[0]
    const i = base.lastIndexOf('.')
    return i === -1 ? '' : base.slice(i + 1).toLowerCase()
  }
}

function guessFormatFromUrl(u) {
  const ext = getUrlExtension(u)
  if (
    ext === 'mp3' ||
    ext === 'm4a' ||
    ext === 'mp4' ||
    ext === 'aac' ||
    ext === 'ogg' ||
    ext === 'wav' ||
    ext === 'flac' ||
    ext === 'webm' ||
    ext === 'flv'
  )
    return ext === 'mp4' ? 'm4a' : ext
  return 'm4a'
}

function coerceStreamType(typeOrFormat, url) {
  const t = typeOrFormat ? String(typeOrFormat).toLowerCase() : ''
  if (t) {
    if (t.includes('/')) return t
    if (t === 'mp3' || t === 'mpeg') return 'audio/mpeg'
    if (t === 'm4a' || t === 'mp4') return 'audio/mp4'
    if (t === 'aac') return 'audio/aac'
    if (t === 'ogg') return 'audio/ogg'
    if (t === 'wav') return 'audio/wav'
    if (t === 'flac') return 'audio/flac'
    if (t === 'webm') return 'video/webm'
    if (t === 'flv') return 'video/x-flv'
    return t
  }

  const ext = guessFormatFromUrl(url)
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'ogg') return 'audio/ogg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'flac') return 'audio/flac'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'flv') return 'video/x-flv'
  return 'audio/mp4'
}

export default class AudioMackSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['admsearch', 'audiomack']
    this.patterns = audiomackPatterns
    this.priority = 40
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Audiomack source (official public API).')
    return true
  }

  async makeSignedRequest(method, url, additionalParams = {}) {
    const params = {
      ...additionalParams,
      oauth_consumer_key: CONSUMER_KEY,
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000),
      oauth_version: '1.0'
    }

    const paramString = buildParamString(params)
    const signature = this.generateSignature(
      method,
      url,
      params,
      CONSUMER_SECRET,
      paramString
    )
    const signedUrl = `${url}?${paramString}&oauth_signature=${strictEncodeURIComponent(signature)}`
    return http1makeRequest(signedUrl, { method })
  }

  async search(query, _sourceTerm) {
    logger('debug', 'Sources', `Searching Audiomack for: "${query}"`)

    try {
      const url = `${API_BASE}/search`
      const { body, error } = await this.makeSignedRequest('GET', url, {
        q: query,
        limit: '20',
        show: 'music',
        sort: 'popular',
        page: '1',
        section: '/search'
      })

      if (error || !body) {
        logger(
          'error',
          'Sources',
          `[Audiomack] API search failed: ${error?.message}`
        )
        return {
          exception: {
            message: error?.message || 'Failed to fetch search results.',
            severity: 'common'
          }
        }
      }

      const json = parseJsonBody(body)
      if (!json) {
        logger(
          'error',
          'Sources',
          '[Audiomack] Invalid JSON in search response.'
        )
        return { loadType: 'empty', data: {} }
      }

      if (Array.isArray(json.results)) {
        const tracks = json.results
          .filter((item) => item?.type === 'song')
          .map((track) => this.buildTrack(track))

        logger('debug', 'Sources', `[Audiomack] Found ${tracks.length} tracks.`)
        if (!tracks.length) return { loadType: 'empty', data: {} }
        return { loadType: 'search', data: tracks }
      }

      logger('debug', 'Sources', '[Audiomack] No results found in response.')
      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Sources', `[Audiomack] search error: ${e.message}`)
      return { exception: { message: 'Failed to search.', severity: 'common' } }
    }
  }

  async resolve(queryUrl) {
    const url = new URL(queryUrl)
    const pathParts = url.pathname.slice(1).split('/')

    const artistSlug = pathParts[0]
    const songSlug = pathParts.length > 2 ? pathParts.slice(2).join('/') : null

    if (!songSlug) {
      return {
        exception: {
          message: 'Only single song URLs are currently supported.',
          severity: 'common'
        }
      }
    }

    const apiUrl = `${API_BASE}/music/song/${artistSlug}/${songSlug}`

    try {
      const { body, error } = await this.makeSignedRequest('GET', apiUrl, {
        section: url.pathname
      })

      if (error || !body) {
        return {
          exception: {
            message:
              error?.message ||
              'Failed to fetch track details from Audiomack API.',
            severity: 'common'
          }
        }
      }

      const json = parseJsonBody(body)
      const song = normalizeApiResult(json)

      if (!song?.id) {
        return {
          exception: {
            message: 'Track not found or invalid response.',
            severity: 'common'
          }
        }
      }

      return { loadType: 'track', data: this.buildTrack(song, queryUrl) }
    } catch (e) {
      return {
        exception: {
          message: 'Failed to resolve track: ' + e.message,
          severity: 'common'
        }
      }
    }
  }

  async getTrackUrl(track) {
    if (!track.identifier) {
      return {
        exception: {
          message: 'Track identifier (numeric ID) missing',
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }

    const playUrl = `${API_BASE}/music/play/${track.identifier}`

    try {
      let section = '/search'
      if (track.uri) {
        try {
          section = new URL(track.uri).pathname
        } catch {}
      }

      const { body, error } = await this.makeSignedRequest('GET', playUrl, {
        environment: 'desktop-web',
        hq: 'true',
        section
      })

      if (error || !body) {
        throw new Error(
          error?.message || 'Failed to get playback URL from Audiomack API'
        )
      }

      const json = parseJsonBody(body)
      const data = normalizeApiResult(json)
      if (!data) {
        throw new Error('Invalid response from Audiomack API')
      }

      const streamUrl =
        data.signedUrl ||
        data.signed_url ||
        data.url ||
        data.streamUrl ||
        data.stream_url

      if (!streamUrl) {
        throw new Error('Invalid or missing streaming URL in response')
      }

      const format = guessFormatFromUrl(streamUrl)
      return { url: streamUrl, protocol: 'https', format }
    } catch (e) {
      logger(
        'warn',
        'Audiomack',
        `Direct stream failed for ${track.title}: ${e.message}. Falling back to YouTube.`
      )
    }

    const searchResult = await this.nodelink.sources.searchWithDefault(
      `${track.title} ${track.author}`
    )

    const bestMatch = getBestMatch(searchResult.data, track)
    if (!bestMatch)
      return {
        exception: {
          message: 'No suitable alternative found.',
          severity: 'fault'
        }
      }

    const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
    return { newTrack: bestMatch, ...streamInfo }
  }

  async loadStream(decodedTrack, url, _protocol, additionalData) {
    try {
      const res = await http1makeRequest(url, {
        method: 'GET',
        headers: additionalData?.headers || {},
        streamOnly: true
      })

      if (res.error || !res.stream)
        throw res.error || new Error('Failed to get stream')

      const out = new PassThrough()
      const src = res.stream

      src.pipe(out)

      src.once('error', (err) => out.destroy(err))
      out.once('close', () => src.destroy())
      out.once('error', () => src.destroy())
      out.once('end', () => out.emit('finishBuffering'))

      const streamType = coerceStreamType(
        additionalData?.type || additionalData?.format || decodedTrack?.format,
        url
      )

      return { stream: out, type: streamType }
    } catch (err) {
      return { exception: { message: err.message, severity: 'common' } }
    }
  }

  generateSignature(
    method,
    url,
    params,
    secret,
    paramString = buildParamString(params)
  ) {
    const signatureBase = `${method.toUpperCase()}&${strictEncodeURIComponent(url)}&${strictEncodeURIComponent(paramString)}`
    const signingKey = `${strictEncodeURIComponent(secret)}&`
    return crypto
      .createHmac('sha1', signingKey)
      .update(signatureBase)
      .digest('base64')
  }

  buildTrack(item, queryUrl = null) {
    const id = item.id
    const title = item.title || 'Unknown Title'
    const author = item.artist || item.uploader?.name || 'Unknown Artist'
    const duration = item.duration ? parseInt(item.duration, 10) * 1000 : 0
    const artwork = item.image || item.image_base || null

    let uri = queryUrl
    if (!uri) {
      const uploaderSlug =
        item.uploader?.url_slug ||
        item.uploader_url_slug ||
        item.artist_slug ||
        'unknown'
      const songSlug = item.url_slug || item.slug || ''
      uri = `https://audiomack.com/${uploaderSlug}/song/${songSlug}`
    }

    const trackInfo = {
      identifier: String(id),
      title,
      author,
      length: duration,
      sourceName: 'audiomack',
      artworkUrl: artwork,
      uri,
      isStream: false,
      isSeekable: true,
      position: 0,
      isrc: item.isrc || null
    }

    return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: {} }
  }
}
