import { encodeTrack, getBestMatch, http1makeRequest, logger } from '../utils.js'
import crypto from 'node:crypto'

const BOT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function parseISO8601Duration(duration) {
  if (!duration) return 0
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const hours = Number.parseInt(match[1] || '0', 10)
  const minutes = Number.parseInt(match[2] || '0', 10)
  const seconds = Number.parseInt(match[3] || '0', 10)
  return (hours * 3600 + minutes * 60 + seconds) * 1000
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
  }

  async setup() {
    return true
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

      const trackAsin = url.match(/(?:[?&]|%26)trackAsin=([a-z0-9]+)/i)?.[1]

      if (trackAsin) {
        return await this._resolveTrack(url, trackAsin)
      }

      switch (type) {
        case 'track':
          return await this._resolveTrack(url, id)
        case 'album':
          return await this._resolveAlbum(url, id)
        case 'playlist':
          return await this._resolvePlaylist(url, id)
        case 'artist':
          return await this._resolveArtist(url, id)
        case 'dp':
          return await this._resolveTrack(url, id)
        default:
          return { loadType: 'empty', data: {} }
      }
    } catch (e) {
      logger('error', 'AmazonMusic', `Resolution failed: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _resolveTrack(url, id) {
    const data = await this._fetchJsonLd(url, id)
    if (data?.loadType === 'track') return data

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
        ?.replace(/&amp;/g, '&')
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
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
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
        } catch (_e) {}
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
          const tTitle = m[2].replace(/&amp;/g, '&')
          const tHref = m[3]
          const tArtist = (m[4] || collectionName).replace(/&amp;/g, '&')
          const tDuration = m[5]
          const tImage = m[6] || collectionImage
          const tId =
            tHref.split('trackAsin=').pop().split('&')[0] ||
            tHref.split('/').pop()

          tracks.push({
            identifier: tId,
            isSeekable: true,
            author: tArtist,
            length: tDuration.includes(':')
              ? (parseInt(tDuration.split(':')[0], 10) * 60 +
                  parseInt(tDuration.split(':')[1], 10)) *
                1000
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
    } catch (_e) {}
    return null
  }

  async _fallbackToOdesli(url, targetId) {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0])}`
      const { body, statusCode } = await http1makeRequest(apiUrl)
      if (statusCode === 200 && body.entitiesByUniqueId) {
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
    } catch (_e) {}
    return { loadType: 'empty', data: {} }
  }

  _buildTrackResult(title, author, url, image, id, length = 0, isrc = null) {
    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: author?.trim() || 'Unknown Artist',
      length: length,
      isStream: false,
      position: 0,
      title: title?.trim() || 'Unknown Track',
      uri: url,
      artworkUrl: image || null,
      isrc: isrc,
      sourceName: 'amazonmusic'
    }
    return {
      loadType: 'track',
      data: { encoded: encodeTrack(trackInfo), info: trackInfo }
    }
  }

  async search(query, _sourceTerm) {
    const headersUA = { 'User-Agent': BOT_USER_AGENT }

    const decodeAmp = (v) =>
      typeof v === 'string' ? v.replaceAll('&amp;', '&') : v

    const getText = (v, fallback) => {
      if (v == null) return fallback
      if (typeof v === 'object') return decodeAmp(v.text ?? fallback)
      return decodeAmp(v) || fallback
    }

    const extractIdentifier = (deeplink) => {
      if (!deeplink) return null

      const k = 'trackAsin='
      const i = deeplink.indexOf(k)
      if (i !== -1) {
        let s = i + k.length
        let e = deeplink.indexOf('&', s)
        if (e === -1) e = deeplink.length
        const id = deeplink.slice(s, e)
        return id || null
      }

      let end = deeplink.length
      const q = deeplink.indexOf('?')
      if (q !== -1 && q < end) end = q
      const h = deeplink.indexOf('#')
      if (h !== -1 && h < end) end = h
      const cut = deeplink.lastIndexOf('/', end - 1)
      const id = deeplink.slice(cut + 1, end)
      return id || null
    }

    try {
      const configRes = await http1makeRequest(
        'https://music.amazon.com/config.json',
        { headers: headersUA }
      )
      if (configRes.statusCode !== 200) {
        throw new Error(`Failed to fetch config: ${configRes.statusCode}`)
      }

      const config = configRes.body
      const { accessToken, sessionId, deviceId, csrf } = config
      if (!csrf?.token) throw new Error('Failed to retrieve CSRF token from config')

      const finalDeviceId =
        deviceId && !deviceId.startsWith('000')
          ? deviceId
          : '13580682033287541'
      const finalSessionId =
        sessionId && !sessionId.startsWith('000')
          ? sessionId
          : '142-4001091-4160417'

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
            accessToken: accessToken || ''
          }),
          'x-amzn-device-model': 'WEBPLAYER',
          'x-amzn-device-width': '1920',
          'x-amzn-device-height': '1080',
          'x-amzn-device-family': 'WebPlayer',
          'x-amzn-device-id': finalDeviceId,
          'x-amzn-user-agent': BOT_USER_AGENT,
          'x-amzn-session-id': finalSessionId,
          'x-amzn-request-id': crypto.randomUUID(),
          'x-amzn-device-language': 'en_US',
          'x-amzn-currency-of-preference': 'USD',
          'x-amzn-os-version': '1.0',
          'x-amzn-application-version': '1.0.9172.0',
          'x-amzn-device-time-zone': 'America/New_York',
          'x-amzn-timestamp': String(now),
          'x-amzn-csrf': JSON.stringify({
            interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
            token: csrf.token,
            timestamp: csrf.ts,
            rndNonce: csrf.rnd
          }),
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
            'x-amzn-csrf': csrf.token,
            Origin: 'https://music.amazon.com',
            Referer: 'https://music.amazon.com/'
          }
        }
      )

      if (searchRes.statusCode !== 200) {
        logger('error', 'AmazonMusic', `Search API returned ${searchRes.statusCode}`)
        return { loadType: 'empty', data: {} }
      }

      let data
      try {
        data =
          typeof searchRes.body === 'string' ? JSON.parse(searchRes.body) : searchRes.body
      } catch (e) {
        logger('error', 'AmazonMusic', `Failed to parse search response: ${e.message}`)
        return { loadType: 'empty', data: {} }
      }

      const widgets = data?.methods?.[0]?.template?.widgets
      if (!Array.isArray(widgets) || widgets.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = []
      for (let w = 0; w < widgets.length; w++) {
        const items = widgets[w]?.items
        if (!Array.isArray(items) || items.length === 0) continue

        for (let j = 0; j < items.length; j++) {
          const item = items[j]
          const isSong = item?.label === 'song'
          const isSquare = typeof item?.interface === 'string' &&
            item.interface.includes('SquareHorizontalItemElement')
          if (!isSong && !isSquare) continue

          const deeplink = item?.primaryLink?.deeplink
          const identifier = extractIdentifier(deeplink)
          if (!identifier) continue
          if (!isSong && (!deeplink || deeplink.indexOf('trackAsin=') === -1)) continue

          tracks.push({
            identifier,
            isSeekable: true,
            author: getText(item.secondaryText, 'Unknown Artist'),
            length: 0, // não consegui achar o duration ainda, nunca sobra nada pro beta 🙅‍♂️
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

      return {
        loadType: 'search',
        data: tracks.map((t) => ({ encoded: encodeTrack(t), info: t }))
      }
    } catch (e) {
      logger('error', 'AmazonMusic', `Search failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack) {
    const query = `${decodedTrack.title} ${decodedTrack.author} official audio`

    try {
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
        ) {
          searchResult = null
        }
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
        throw new Error('No alternative stream found via default search.')
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)
      if (!bestMatch)
        throw new Error('No suitable alternative stream found after filtering.')

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
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