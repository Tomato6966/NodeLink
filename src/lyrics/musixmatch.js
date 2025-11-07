import { readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { logger, http1makeRequest } from '../utils.js'

const APP_ID = 'web-desktop-app-v1.0'
const TOKEN_TTL = 55000
const TOKEN_PERSIST_INTERVAL = 5000
const CACHE_TTL = 180000 // 3 minutes
const MAX_CACHE_SIZE = 100

const ENDPOINTS = Object.freeze({
  TOKEN: 'https://apic-desktop.musixmatch.com/ws/1.1/token.get',
  SEARCH: 'https://apic-desktop.musixmatch.com/ws/1.1/track.search',
  LYRICS: 'https://apic-desktop.musixmatch.com/ws/1.1/track.lyrics.get',
  SUBTITLES: 'https://apic-desktop.musixmatch.com/ws/1.1/track.subtitle.get'
})

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]

const FEAT_PATTERN =
  /\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\s+[^\)\]]+[\)\]]/gi

const SEPARATORS = [' - ', ' – ', ' — ']

const _guid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

const _buildUrl = (base, params) => {
  const url = new URL(base)
  Object.entries(params).forEach(
    ([k, v]) => v !== undefined && url.searchParams.set(k, String(v))
  )
  return url.toString()
}

const _clean = (text, removeFeat = false) => {
  let result = text
  for (const pattern of CLEAN_PATTERNS) result = result.replace(pattern, '')
  if (removeFeat) result = result.replace(FEAT_PATTERN, '')
  return result.trim()
}

const _parse = (query) => {
  const cleaned = _clean(query, true)
  for (const sep of SEPARATORS) {
    const idx = cleaned.indexOf(sep)
    if (idx > 0 && idx < cleaned.length - sep.length) {
      const artist = cleaned.slice(0, idx).trim()
      const title = cleaned.slice(idx + sep.length).trim()
      if (artist && title) return { artist, title }
    }
  }
  return { artist: null, title: _clean(query, true) }
}

export default class MusixmatchLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.guid = _guid()
    this.useManualToken = false
    this.tokenData = null
    this.tokenPromise = null
    this.lastTokenPersist = 0
    this.cookies = new Map()
    this.cache = new Map()
    this.cacheCleanup = null
    this.tokenFile = path.join(os.tmpdir(), 'mxm_token.json')
  }

  async setup() {
    const signatureSecret =
      this.nodelink.options.lyrics?.musixmatch?.signatureSecret
    this.useManualToken = !!signatureSecret

    logger(
      'info',
      'Lyrics',
      `Musixmatch using ${this.useManualToken ? 'signature' : 'automatic token'} authentication`
    )

    if (!this.useManualToken) {
      this.tokenData = await this._readToken()
      if (this.tokenData) logger('info', 'Lyrics', 'Loaded existing token')
    }

    // Start cache cleanup interval
    this._startCacheCleanup()

    return true
  }

  destroy() {
    if (this.cacheCleanup) {
      clearInterval(this.cacheCleanup)
      this.cacheCleanup = null
    }
    this.cache.clear()
    this.cookies.clear()
  }

  _startCacheCleanup() {
    this.cacheCleanup = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.expires <= now) this.cache.delete(key)
      }
    }, 60000) // Cleanup every minute
    this.cacheCleanup.unref()
  }

  _signUrl(url) {
    const secret = this.nodelink.options.lyrics?.musixmatch?.signatureSecret
    if (!secret) throw new Error('Musixmatch signatureSecret not configured')

    const dt = new Date()
    const timestamp = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`
    const signature = crypto
      .createHmac('sha1', secret)
      .update(url + timestamp)
      .digest('base64')

    return `${url}&signature=${encodeURIComponent(signature)}&signature_protocol=sha1`
  }

  _parseCookies(headers) {
    if (!headers) return
    const list = Array.isArray(headers) ? headers : [headers]
    list.forEach((h) => {
      const parts = h.split(';')[0].split('=')
      if (parts.length === 2) this.cookies.set(parts[0].trim(), parts[1].trim())
    })
  }

  _getCookies() {
    return this.cookies.size === 0
      ? ''
      : Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ')
  }

  async _readToken() {
    try {
      const data = await readFile(this.tokenFile, 'utf-8')
      const parsed = JSON.parse(data)
      if (
        parsed?.value &&
        typeof parsed.expires === 'number' &&
        parsed.expires > Date.now()
      ) {
        return parsed
      }
    } catch {}
    return null
  }

  async _saveToken(token, expires) {
    try {
      await writeFile(
        this.tokenFile,
        JSON.stringify({ value: token, expires }),
        'utf-8'
      )
    } catch {}
  }

  async _fetchToken() {
    const url = _buildUrl(ENDPOINTS.TOKEN, { app_id: APP_ID })
    const { statusCode, headers, body } = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'en',
        cookie:
          'AWSELB=unknown; x-mxm-user-id=undefined; x-mxm-token-guid=undefined; mxm-encrypted-token=',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
      }
    })

    this._parseCookies(headers['set-cookie'])

    if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`)

    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    const token = parsed?.message?.body?.user_token

    if (!token) {
      const hint = parsed?.message?.header?.hint
      throw new Error(hint || `No token in response`)
    }

    return token
  }

  async _resetToken(hard = false) {
    this.tokenData = null
    this.tokenPromise = null
    if (hard) {
      this.cookies.clear()
      try {
        await unlink(this.tokenFile)
      } catch {}
    }
  }

  async _getToken(force = false) {
    const now = Date.now()

    if (!force && this.tokenData && now < this.tokenData.expires) {
      this.tokenData.expires = now + TOKEN_TTL
      if (now - this.lastTokenPersist > TOKEN_PERSIST_INTERVAL) {
        this.lastTokenPersist = now
        this._saveToken(this.tokenData.value, this.tokenData.expires).catch(
          () => {}
        )
      }
      return this.tokenData.value
    }

    if (!this.tokenData && !force) {
      this.tokenData = await this._readToken()
      if (this.tokenData && now < this.tokenData.expires)
        return this.tokenData.value
    }

    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = this._acquireToken()
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  async _acquireToken() {
    try {
      const token = await this._fetchToken()
      const expires = Date.now() + TOKEN_TTL
      this.tokenData = { value: token, expires }
      await this._saveToken(token, expires)
      return token
    } catch (err) {
      const isCaptcha = err.message?.toLowerCase().includes('captcha')
      const isAuth =
        err.message?.includes('401') || err.message?.includes('403')

      if (isCaptcha || isAuth) {
        this.cookies.clear()
        const token = await this._fetchToken()
        const expires = Date.now() + TOKEN_TTL
        this.tokenData = { value: token, expires }
        await this._saveToken(token, expires)
        return token
      }

      throw err
    }
  }

  async _request(endpoint, params) {
    const token = this.useManualToken ? null : await this._getToken()
    let url = _buildUrl(endpoint, {
      ...params,
      app_id: APP_ID,
      ...(token ? { usertoken: token } : {}),
      guid: this.guid
    })

    if (this.useManualToken) url = this._signUrl(url)

    const { statusCode, headers, body } = await http1makeRequest(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        cookie: this._getCookies()
      }
    })

    if (!this.useManualToken) this._parseCookies(headers['set-cookie'])

    const parsed = typeof body === 'string' ? JSON.parse(body) : body
    const apiStatus = parsed?.message?.header?.status_code
    const apiHint = parsed?.message?.header?.hint

    if (
      statusCode === 401 ||
      statusCode === 403 ||
      apiStatus === 401 ||
      apiStatus === 403
    ) {
      if (!this.useManualToken) {
        const isCaptcha = apiHint?.toLowerCase().includes('captcha')
        await this._resetToken(isCaptcha)
        const newToken = await this._getToken(true)
        const retryUrl = _buildUrl(endpoint, {
          ...params,
          app_id: APP_ID,
          usertoken: newToken,
          guid: this.guid
        })

        const {
          statusCode: retryStatus,
          headers: retryHeaders,
          body: retryBody
        } = await http1makeRequest(retryUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            cookie: this._getCookies()
          }
        })

        this._parseCookies(retryHeaders['set-cookie'])
        const retryParsed =
          typeof retryBody === 'string' ? JSON.parse(retryBody) : retryBody

        if (
          retryStatus !== 200 ||
          retryParsed?.message?.header?.status_code !== 200
        )
          return null

        return retryParsed.message.body
      }
      return null
    }

    return statusCode === 200 && apiStatus === 200 ? parsed.message.body : null
  }

  async _search(artist, title) {
    const params = {}
    if (artist) params.q_artist = artist
    if (title) params.q_track = title

    const body = await this._request(ENDPOINTS.SEARCH, {
      ...params,
      page_size: '3',
      page: '1',
      s_track_rating: 'desc'
    })
    if (!body?.track_list) return null

    const tracks = body.track_list.map((item) => {
      const track = item.track
      const tTitle = track.track_name.toLowerCase()
      const tArtist = track.artist_name.toLowerCase()
      const sTitle = (title || '').toLowerCase()
      const sArtist = (artist || '').toLowerCase()

      let score = track.track_rating / 10

      if (tTitle === sTitle) score += 100
      else if (tTitle.includes(sTitle)) score += 50
      else if (sTitle.includes(tTitle)) score += 30

      if (artist) {
        if (tArtist === sArtist) score += 100
        else if (tArtist.includes(sArtist)) score += 50
        else if (sArtist.includes(tArtist)) score += 30
      }

      return { track, score }
    })

    tracks.sort((a, b) => b.score - a.score)
    return tracks[0]?.track || null
  }

  async _getLyrics(trackId) {
    const body = await this._request(ENDPOINTS.LYRICS, { track_id: trackId })
    return body?.lyrics?.lyrics_body || null
  }

  async _getSubtitles(trackId) {
    const body = await this._request(ENDPOINTS.SUBTITLES, {
      track_id: trackId,
      subtitle_format: 'mxm'
    })
    const subBody = body?.subtitle?.subtitle_body
    if (!subBody) return null

    try {
      const parsed = JSON.parse(subBody)
      const arr = Array.isArray(parsed) ? parsed : []
      if (arr.length === 0) return null

      return arr.map((item) => ({
        text: String(item?.text ?? ''),
        time: Math.round((item?.time?.total || 0) * 1000),
        duration: Math.round((item?.time?.duration || 0) * 1000)
      }))
    } catch {
      return null
    }
  }

  _format(lyrics, subtitles, track) {
    if (subtitles?.length > 0) {
      return {
        synced: true,
        lines: subtitles,
        name: track?.track_name || 'Unknown'
      }
    }

    if (lyrics) {
      const lines = lyrics
        .split('\n')
        .map((line) => {
          const trimmed = line.trim()
          return trimmed ? { text: trimmed, time: 0, duration: 0 } : null
        })
        .filter(Boolean)

      return {
        synced: false,
        lines,
        name: track?.track_name || 'Unknown'
      }
    }

    return null
  }

  _cacheKey(artist, title) {
    return `${(artist || '').toLowerCase().trim()}|${title.toLowerCase().trim()}`
  }

  _getCache(key) {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (entry.expires > Date.now()) return entry.value
    this.cache.delete(key)
    return undefined
  }

  _setCache(key, value) {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(key, { value, expires: Date.now() + CACHE_TTL })
  }

  async getLyrics(trackInfo) {
    try {
      const parsed = _parse(trackInfo.title)
      const cleanAuthor = _clean(trackInfo.author, false)
      const artist = parsed.artist || cleanAuthor
      const title = parsed.artist ? parsed.title : _clean(trackInfo.title, true)

      // Check cache
      const cacheKey = this._cacheKey(artist, title)
      const cached = this._getCache(cacheKey)
      if (cached !== undefined) {
        logger('debug', 'Lyrics', 'Cache hit')
        return cached
      }

      logger('info', 'Lyrics', `Searching: "${title}" by "${artist}"`)

      let track = artist && title ? await this._search(artist, title) : null
      if (!track && title) track = await this._search(null, title)

      if (!track) {
        const result = { loadType: 'empty', data: {} }
        this._setCache(cacheKey, result)
        return result
      }

      logger(
        'info',
        'Lyrics',
        `Found: "${track.track_name}" by ${track.artist_name}`
      )

      const [subtitles, lyrics] = await Promise.allSettled([
        this._getSubtitles(track.track_id),
        this._getLyrics(track.track_id)
      ])

      const subs = subtitles.status === 'fulfilled' ? subtitles.value : null
      const lyr = lyrics.status === 'fulfilled' ? lyrics.value : null
      const formatted = this._format(lyr, subs, track)

      if (!formatted || formatted.lines.length === 0) {
        const result = { loadType: 'empty', data: {} }
        this._setCache(cacheKey, result)
        return result
      }

      logger(
        'info',
        'Lyrics',
        `Success: ${formatted.lines.length} lines (synced: ${formatted.synced})`
      )

      const result = {
        loadType: 'lyrics',
        data: {
          name: formatted.name,
          synced: formatted.synced,
          lines: formatted.lines
        }
      }

      this._setCache(cacheKey, result)
      return result
    } catch (e) {
      logger('error', 'Lyrics', `Failed: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
