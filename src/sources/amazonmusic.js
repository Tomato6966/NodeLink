import crypto from 'node:crypto'
import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; NodeLinkBot/0.1; +https://nodelink.js.org/)'
const SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'

const FALLBACK_DEVICE_ID = '13580682033287541'
const FALLBACK_SESSION_ID = '142-4001091-4160417'
const CONFIG_TTL_MS = 60_000

const parseJson = (v) => {
  if (!v || typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const extractTrackAsinParam = (u) => {
  if (!u) return null
  const k = 'trackAsin='
  const i = u.indexOf(k)
  if (i === -1) return null

  const s = i + k.length

  let e = u.indexOf('&', s)
  const e2 = u.indexOf('%26', s)
  if (e === -1 || (e2 !== -1 && e2 < e)) e = e2
  const h = u.indexOf('#', s)
  if (e === -1 || (h !== -1 && h < e)) e = h
  if (e === -1) e = u.length

  const id = u.slice(s, e)
  return id || null
}

const extractIdentifier = (deeplink) => {
  if (!deeplink) return null
  const asin = extractTrackAsinParam(deeplink)
  if (asin) return asin

  let end = deeplink.length
  const q = deeplink.indexOf('?')
  if (q !== -1 && q < end) end = q
  const h = deeplink.indexOf('#')
  if (h !== -1 && h < end) end = h

  const cut = deeplink.lastIndexOf('/', end - 1)
  const id = deeplink.slice(cut + 1, end)
  return id || null
}

const parseColonDurationToMs = (s) => {
  if (!s) return 0
  const parts = String(s).split(':')
  let sec = 0
  for (let i = 0; i < parts.length; i++) {
    const n = Number.parseInt(parts[i], 10)
    if (!Number.isFinite(n)) return 0
    sec = sec * 60 + n
  }
  return sec * 1000
}

function parseISO8601Duration(duration) {
  if (!duration) return 0
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const hours = Number.parseInt(match[1] || '0', 10)
  const minutes = Number.parseInt(match[2] || '0', 10)
  const seconds = Number.parseInt(match[3] || '0', 10)
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

function parseTimeStringToMs(s) {
  if (!s) return 0
  s = String(s).toUpperCase()

  let total = 0
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c < 48 || c > 57) continue

    let n = 0
    do {
      n = n * 10 + (c - 48)
      c = s.charCodeAt(++i)
    } while (i < s.length && c >= 48 && c <= 57)

    while (i < s.length && s.charCodeAt(i) === 32) i++

    if (s.startsWith('HOUR', i)) total += n * 3600
    else if (s.startsWith('MINUTE', i)) total += n * 60
    else if (s.startsWith('SECOND', i)) total += n
  }
  return total * 1000
}

export default class AmazonMusicSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['amazonmusic', 'azsearch']
    this.patterns = [
      /https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)/i,
      /https?:\/\/(?:www\.)?amazon\.[a-z.]+\/dp\/([a-z0-9]+)/i
    ]
    this.priority = 100

    this._configCache = null
    this._configPromise = null
  }

  async setup() {
    return true
  }

  async _getAmazonConfig() {
    const now = Date.now()
    if (this._configCache && now - this._configCache.t < CONFIG_TTL_MS)
      return this._configCache.v
    if (this._configPromise) return this._configPromise

    this._configPromise = (async () => {
      const res = await http1makeRequest(
        'https://music.amazon.com/config.json',
        {
          headers: { 'User-Agent': SEARCH_USER_AGENT }
        }
      )
      if (res.statusCode !== 200) return null

      const cfg = parseJson(res.body) || res.body
      if (!cfg?.csrf?.token) return null

      const deviceId =
        cfg.deviceId && !cfg.deviceId.startsWith('000')
          ? cfg.deviceId
          : FALLBACK_DEVICE_ID
      const sessionId =
        cfg.sessionId && !cfg.sessionId.startsWith('000')
          ? cfg.sessionId
          : FALLBACK_SESSION_ID

      const v = {
        accessToken: cfg.accessToken || '',
        csrf: cfg.csrf,
        deviceId,
        sessionId
      }
      this._configCache = { t: Date.now(), v }
      return v
    })()

    try {
      return await this._configPromise
    } finally {
      this._configPromise = null
    }
  }

  _buildCsrfHeader(csrf) {
    return JSON.stringify({
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: csrf.token,
      timestamp: csrf.ts,
      rndNonce: csrf.rnd
    })
  }

  async resolve(url) {
    try {
      const match = url.match(this.patterns[0]) || url.match(this.patterns[1])
      if (!match) return { loadType: 'empty', data: {} }

      let [, type, id] = match
      if (!id) {
        id = type
        type = 'track'
      }

      const trackAsin = extractTrackAsinParam(url)
      if (trackAsin) return await this._resolveTrack(url, trackAsin)

      if (type === 'track' || type === 'dp')
        return await this._resolveTrack(url, id)
      if (type === 'album') return await this._resolveAlbum(url, id)
      if (type === 'playlist') return await this._resolvePlaylist(url, id)
      if (type === 'artist') return await this._resolveArtist(url, id)

      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'AmazonMusic', `Resolution failed: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _fetchTrackDurationFromAPI(trackId) {
    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) return 0

      const now = Date.now()
      const headersObj = {
        'x-amzn-authentication': JSON.stringify({
          interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement',
          accessToken: cfg.accessToken
        }),
        'x-amzn-device-model': 'WEBPLAYER',
        'x-amzn-device-width': '1920',
        'x-amzn-device-family': 'WebPlayer',
        'x-amzn-device-id': cfg.deviceId,
        'x-amzn-user-agent': SEARCH_USER_AGENT,
        'x-amzn-session-id': cfg.sessionId,
        'x-amzn-device-height': '1080',
        'x-amzn-request-id': crypto.randomUUID(),
        'x-amzn-device-language': 'en_US',
        'x-amzn-currency-of-preference': 'USD',
        'x-amzn-os-version': '1.0',
        'x-amzn-application-version': '1.0.9172.0',
        'x-amzn-device-time-zone': 'America/Sao_Paulo',
        'x-amzn-timestamp': String(now),
        'x-amzn-csrf': this._buildCsrfHeader(cfg.csrf),
        'x-amzn-music-domain': 'music.amazon.com',
        'x-amzn-referer': '',
        'x-amzn-affiliate-tags': '',
        'x-amzn-ref-marker': '',
        'x-amzn-page-url': `https://music.amazon.com/tracks/${trackId}`,
        'x-amzn-weblab-id-overrides': '',
        'x-amzn-video-player-token': '',
        'x-amzn-feature-flags': 'hd-supported,uhd-supported',
        'x-amzn-has-profile-id': '',
        'x-amzn-age-band': ''
      }

      const payloadStr = JSON.stringify({
        id: trackId,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify(headersObj)
      })

      const response = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/cosmicTrack/displayCatalogTrack',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            'User-Agent': SEARCH_USER_AGENT,
            'Content-Type': 'text/plain;charset=UTF-8',
            'Content-Length': String(Buffer.byteLength(payloadStr)),
            Origin: 'https://music.amazon.com',
            Referer: 'https://music.amazon.com/'
          }
        }
      )

      if (response.statusCode !== 200) return 0
      const data = parseJson(response.body) || response.body
      const t = data?.methods?.[0]?.template?.headerTertiaryText
      if (!t) return 0

      const duration = parseTimeStringToMs(t)
      return duration > 0 ? duration : 0
    } catch (e) {
      logger(
        'warn',
        'AmazonMusic',
        `Failed to fetch duration for ${trackId}: ${e.message}`
      )
      return 0
    }
  }

  async _resolveTrack(url, id) {
    const data = await this._fetchJsonLd(url, id)
    if (data?.loadType === 'track') {
      if (data.data.info.length === 0) {
        const duration = await this._fetchTrackDurationFromAPI(id)
        data.data.info.length = duration
        data.data.encoded = encodeTrack(data.data.info)
      }
      return data
    }
    return await this._fallbackToOdesli(url, id)
  }

  async _resolveAlbum(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  async _resolvePlaylist(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  async _resolveArtist(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data
    return await this._fallbackToOdesli(url, id)
  }

  async _fetchJsonLd(url, targetId) {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': BOT_USER_AGENT }
      })
      if (statusCode !== 200) return null

      const headerArtist = body
        .match(/<music-detail-header[^>]*primary-text="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&')

      const headerImage = body.match(
        /<music-detail-header[^>]*image-src="([^"]+)"/
      )?.[1]
      const ogImageMatch = body.match(
        /<meta property="og:image" content="([^"]+)"/
      )
      const artworkUrl = headerImage || (ogImageMatch ? ogImageMatch[1] : null)

      const jsonLdMatches = body.matchAll(
        /<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
      )
      let collection = null
      let trackData = null

      for (const match of jsonLdMatches) {
        try {
          const content = match[1]
            .replaceAll('&quot;', '"')
            .replaceAll('&amp;', '&')
          const parsed = JSON.parse(content)
          const data = Array.isArray(parsed) ? parsed[0] : parsed
          if (
            data['@type'] === 'MusicAlbum' ||
            data['@type'] === 'MusicGroup' ||
            data['@type'] === 'Playlist'
          ) {
            collection = data
          } else if (data['@type'] === 'MusicRecording') {
            trackData = data
          }
        } catch {}
      }

      const tracks = []
      let collectionName = headerArtist || 'Unknown Artist'
      let collectionImage = artworkUrl

      if (collection) {
        const artistName =
          collection.byArtist?.name ||
          (Array.isArray(collection.byArtist)
            ? collection.byArtist[0]?.name
            : null) ||
          collection.author?.name
        if (artistName) collectionName = artistName
        if (collection.image) collectionImage = collection.image
      }

      if (collection?.track) {
        for (const t of collection.track) {
          const id =
            t.url?.split('/').pop() ||
            t['@id']?.split('/').pop() ||
            `am-${Buffer.from(t.name).toString('hex')}`
          tracks.push({
            identifier: id,
            isSeekable: true,
            author: t.byArtist?.name || t.author?.name || collectionName,
            length: parseISO8601Duration(t.duration),
            isStream: false,
            position: 0,
            title: t.name,
            uri: t.url || url,
            artworkUrl: collectionImage,
            isrc: t.isrcCode || null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length === 0) {
        const rowMatches = body.matchAll(
          /<(music-image-row|music-text-row)[^>]*primary-text="([^"]+)"[^>]*primary-href="([^"]+)"(?:[^>]*secondary-text-1="([^"]+)")?[^>]*duration="([^"]+)"(?:[^>]*image-src="([^"]+)")?/g
        )
        for (const m of rowMatches) {
          const tTitle = m[2].replaceAll('&amp;', '&')
          const tHref = m[3]
          const tArtist = (m[4] || collectionName).replaceAll('&amp;', '&')
          const tDuration = m[5]
          const tImage = m[6] || collectionImage
          const tId =
            extractIdentifier(tHref) ||
            `am-${Buffer.from(tTitle).toString('hex')}`

          tracks.push({
            identifier: tId,
            isSeekable: true,
            author: tArtist,
            length: tDuration?.includes(':')
              ? parseColonDurationToMs(tDuration)
              : 0,
            isStream: false,
            position: 0,
            title: tTitle,
            uri: `https://music.amazon.com.br/tracks/${tId}`,
            artworkUrl: tImage,
            isrc: null,
            sourceName: 'amazonmusic'
          })
        }

        if (tracks.length === 0 && !headerArtist) {
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/)
          if (titleMatch)
            collectionName =
              titleMatch[1]
                .split(' no Amazon')[0]
                .split(' de ')
                .pop()
                ?.split(' no ')[0] || collectionName
        }
      }

      if (tracks.length > 0) {
        if (targetId) {
          const selected = tracks.find(
            (t) => t.identifier === targetId || t.uri.includes(targetId)
          )
          if (selected) {
            return {
              loadType: 'track',
              data: { encoded: encodeTrack(selected), info: selected }
            }
          }
        }

        if (url.includes('/tracks/') && !targetId) {
          return {
            loadType: 'track',
            data: { encoded: encodeTrack(tracks[0]), info: tracks[0] }
          }
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: collectionName, selectedTrack: 0 },
            tracks: tracks.map((t) => ({ encoded: encodeTrack(t), info: t }))
          }
        }
      }

      if (trackData) {
        const artist =
          trackData.byArtist?.name || trackData.author?.name || 'Unknown Artist'
        let trackImage = trackData.image || artworkUrl
        if (!trackImage) {
          const headerImageMatch = body.match(
            /<music-detail-header[^>]*image-src="([^"]+)"/
          )
          if (headerImageMatch) trackImage = headerImageMatch[1]
        }
        return this._buildTrackResult(
          trackData.name,
          artist,
          url,
          trackImage,
          trackData.id || trackData.isrcCode || url.split('/').pop(),
          parseISO8601Duration(trackData.duration),
          trackData.isrcCode
        )
      }
    } catch {}
    return null
  }

  async _fallbackToOdesli(url, targetId) {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0])}`
      const { body, statusCode } = await http1makeRequest(apiUrl)
      if (statusCode === 200 && body?.entitiesByUniqueId) {
        let entity = body.entitiesByUniqueId[body.entityUniqueId]
        if (targetId && (!entity || !entity.id.includes(targetId))) {
          const found = Object.values(body.entitiesByUniqueId).find((e) =>
            e.id.includes(targetId)
          )
          if (found) entity = found
        }
        if (entity)
          return this._buildTrackResult(
            entity.title,
            entity.artistName,
            url,
            entity.thumbnailUrl,
            entity.id,
            0,
            entity.isrc
          )
      }
    } catch {}
    return { loadType: 'empty', data: {} }
  }

  _buildTrackResult(title, author, url, image, id, length = 0, isrc = null) {
    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: author?.trim() || 'Unknown Artist',
      length,
      isStream: false,
      position: 0,
      title: title?.trim() || 'Unknown Track',
      uri: url,
      artworkUrl: image || null,
      isrc,
      sourceName: 'amazonmusic'
    }
    return {
      loadType: 'track',
      data: { encoded: encodeTrack(trackInfo), info: trackInfo }
    }
  }

  async search(query, _sourceTerm) {
    const headersUA = { 'User-Agent': SEARCH_USER_AGENT }

    const decodeAmp = (v) =>
      typeof v === 'string' ? v.replaceAll('&amp;', '&') : v

    const getText = (v, fallback) => {
      if (v == null) return fallback
      if (typeof v === 'object') return decodeAmp(v.text ?? fallback)
      return decodeAmp(v) || fallback
    }

    try {
      const cfg = await this._getAmazonConfig()
      if (!cfg) throw new Error('Failed to retrieve CSRF token from config')

      const now = Date.now()
      const qEnc = encodeURIComponent(query)

      const searchPayload = {
        filter: '{"IsLibrary":["false"]}',
        keyword: JSON.stringify({
          interface:
            'Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchKeywordClientInformation',
          keyword: ''
        }),
        suggestedKeyword: query,
        userHash: '{"level":"LIBRARY_MEMBER"}',
        headers: JSON.stringify({
          'x-amzn-authentication': JSON.stringify({
            interface: 'ClientAuthenticationInterface.v1_0.ClientTokenElement',
            accessToken: cfg.accessToken
          }),
          'x-amzn-device-model': 'WEBPLAYER',
          'x-amzn-device-width': '1920',
          'x-amzn-device-height': '1080',
          'x-amzn-device-family': 'WebPlayer',
          'x-amzn-device-id': cfg.deviceId,
          'x-amzn-user-agent': SEARCH_USER_AGENT,
          'x-amzn-session-id': cfg.sessionId,
          'x-amzn-request-id': crypto.randomUUID(),
          'x-amzn-device-language': 'en_US',
          'x-amzn-currency-of-preference': 'USD',
          'x-amzn-os-version': '1.0',
          'x-amzn-application-version': '1.0.9172.0',
          'x-amzn-device-time-zone': 'America/New_York',
          'x-amzn-timestamp': String(now),
          'x-amzn-csrf': this._buildCsrfHeader(cfg.csrf),
          'x-amzn-music-domain': 'music.amazon.com',
          'x-amzn-page-url': `https://music.amazon.com/search/${qEnc}?filter=IsLibrary%7Cfalse&sc=none`,
          'x-amzn-feature-flags': 'hd-supported,uhd-supported'
        })
      }

      const payloadStr = JSON.stringify(searchPayload)

      const searchRes = await http1makeRequest(
        'https://na.mesk.skill.music.a2z.com/api/showSearch',
        {
          method: 'POST',
          body: payloadStr,
          disableBodyCompression: true,
          headers: {
            ...headersUA,
            'Content-Type': 'text/plain;charset=UTF-8',
            'Content-Length': String(Buffer.byteLength(payloadStr)),
            'x-amzn-csrf': cfg.csrf.token,
            Origin: 'https://music.amazon.com',
            Referer: 'https://music.amazon.com/'
          }
        }
      )

      if (searchRes.statusCode !== 200) {
        logger(
          'error',
          'AmazonMusic',
          `Search API returned ${searchRes.statusCode}`
        )
        return { loadType: 'empty', data: {} }
      }

      const data = parseJson(searchRes.body) || searchRes.body
      if (!data) return { loadType: 'empty', data: {} }

      const widgets = data?.methods?.[0]?.template?.widgets
      if (!Array.isArray(widgets) || widgets.length === 0)
        return { loadType: 'empty', data: {} }

      const tracks = []

      for (let w = 0; w < widgets.length; w++) {
        const items = widgets[w]?.items
        if (!Array.isArray(items) || items.length === 0) continue

        for (let j = 0; j < items.length; j++) {
          const item = items[j]
          const isSong = item?.label === 'song'
          const isSquare =
            typeof item?.interface === 'string' &&
            item.interface.includes('SquareHorizontalItemElement')
          if (!isSong && !isSquare) continue

          const deeplink = item?.primaryLink?.deeplink
          const identifier = extractIdentifier(deeplink)
          if (!identifier) continue
          if (!isSong && (!deeplink || deeplink.indexOf('trackAsin=') === -1))
            continue

          tracks.push({
            identifier,
            isSeekable: true,
            author: getText(item.secondaryText, 'Unknown Artist'),
            length: 0,
            isStream: false,
            position: 0,
            title: getText(item.primaryText, 'Unknown Track'),
            uri: `https://music.amazon.com/tracks/${identifier}`,
            artworkUrl: item.image,
            isrc: null,
            sourceName: 'amazonmusic'
          })
        }
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      const fetchLimit = Math.min(tracks.length, 5)
      const durations = await Promise.all(
        tracks
          .slice(0, fetchLimit)
          .map((t) => this._fetchTrackDurationFromAPI(t.identifier))
      )
      for (let i = 0; i < fetchLimit; i++)
        if (durations[i] > 0) tracks[i].length = durations[i]

      return {
        loadType: 'search',
        data: tracks.map((t) => ({ encoded: encodeTrack(t), info: t }))
      }
    } catch (e) {
      logger('error', 'AmazonMusic', `Search failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
    const query = `${decodedTrack.title} ${decodedTrack.author}`

    try {
      let searchResult = await this.nodelink.sources.searchWithDefault(
        decodedTrack.isrc ? `"${decodedTrack.isrc}"` : query
      )

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        throw new Error('No alternative stream found via default search.')
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)
      if (!bestMatch)
        throw new Error('No suitable alternative stream found after filtering.')

      const streamInfo = await this.nodelink.sources.getTrackUrl(
        bestMatch.info,
        itag,
        forceRefresh
      )
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger(
        'warn',
        'AmazonMusic',
        `Mirror search for "${query}" failed: ${e.message}`
      )
      throw e
    }
  }

  async loadStream() {
    return null
  }
}
