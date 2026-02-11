import {
  encodeTrack,
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.ts'

export default class ShazamSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['shsearch', 'szsearch']
    this.patterns = [/https?:\/\/(?:www\.)?shazam\.com\/song\/\d+(?:\/[^/?#]+)?/]
    this.priority = 90
    this.allowExplicit = true
  }

  async setup() {
    const shazamConfig = this.config.sources?.shazam || {}
    this.allowExplicit = shazamConfig.allowExplicit ?? true
    return true
  }

  async search(query) {
    try {
      const limit = this.config.maxSearchResults || 10
      const url = `https://www.shazam.com/services/amapi/v1/catalog/US/search?types=songs&term=${encodeURIComponent(query)}&limit=${limit}`

      const { body: data, statusCode } = await http1makeRequest(url)
      if (statusCode !== 200) return { loadType: 'empty', data: {} }

      const songs = data?.results?.songs?.data || []
      if (!songs.length) return { loadType: 'empty', data: {} }

      const tracks = []
      for (let i = 0; i < songs.length; i++) {
        const t = this._buildTrack(songs[i])
        if (t) tracks.push(t)
      }

      return { loadType: 'search', data: tracks }
    } catch (error) {
      logger('error', 'Shazam', `Search failed for ${query}: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    try {
      const res = await http1makeRequest(url)
      if (res.statusCode !== 200) return { loadType: 'empty', data: {} }

      const html =
        typeof res.body === 'string' ? res.body : String(res.body ?? '')

      const extractTextAfterClass = (classPart) => {
        let from = 0
        while (true) {
          const c = html.indexOf('class="', from)
          if (c === -1) return null

          const q = html.indexOf('"', c + 7)
          if (q === -1) return null

          const cls = html.slice(c + 7, q)
          if (cls.includes(classPart)) {
            const gt = html.indexOf('>', q)
            if (gt === -1) return null
            const lt = html.indexOf('<', gt + 1)
            if (lt === -1) return null
            const text = html.slice(gt + 1, lt).trim()
            return text || null
          }

          from = q + 1
        }
      }

      const extractHrefStartingAt = (hrefPrefix) => {
        const i = html.indexOf(hrefPrefix)
        if (i === -1) return null
        const start = i + 6
        const end = html.indexOf('"', start)
        return end > start ? html.slice(start, end) : null
      }

      const extractArtworkFromImgAlt = () => {
        const ogImage = html.match(
          /<meta property="og:image" content="([^"]+)"/
        )
        if (ogImage) return ogImage[1]

        let altIdx = html.indexOf('alt="album cover"')
        if (altIdx === -1) altIdx = html.indexOf('alt="song thumbnail"')
        if (altIdx === -1) return null

        const imgStart = html.lastIndexOf('<img', altIdx)
        if (imgStart === -1) return null
        const imgEnd = html.indexOf('>', altIdx)
        if (imgEnd === -1) return null

        const tag = html.slice(imgStart, imgEnd + 1)
        const s = tag.indexOf('srcset="')
        if (s === -1) return null

        const valStart = s + 8
        const valEnd = tag.indexOf('"', valStart)
        if (valEnd === -1) return null

        const srcset = tag.slice(valStart, valEnd)
        const space = srcset.indexOf(' ')
        return (space === -1 ? srcset : srcset.slice(0, space)) || null
      }

      const extractIsrcFromHtml = () => {
        const tokens = ['"isrc"', '\\"isrc\\"']
        const isUpper = (c) => c >= 65 && c <= 90
        const isDigit = (c) => c >= 48 && c <= 57
        const isUpperOrDigit = (c) => isUpper(c) || isDigit(c)

        for (let t = 0; t < tokens.length; t++) {
          const token = tokens[t]
          let from = 0

          while (true) {
            const at = html.indexOf(token, from)
            if (at === -1) break
            from = at + token.length

            let i = html.indexOf(':', from)
            if (i === -1) break
            i++

            while (i < html.length) {
              const cc = html.charCodeAt(i)
              if (cc !== 32 && cc !== 9 && cc !== 10 && cc !== 13) break
              i++
            }

            while (html.charCodeAt(i) === 92) i++
            if (html.charCodeAt(i) !== 34) continue
            i++

            if (i + 12 > html.length) continue

            if (
              !isUpper(html.charCodeAt(i)) ||
              !isUpper(html.charCodeAt(i + 1))
            )
              continue

            if (
              !isUpperOrDigit(html.charCodeAt(i + 2)) ||
              !isUpperOrDigit(html.charCodeAt(i + 3)) ||
              !isUpperOrDigit(html.charCodeAt(i + 4))
            )
              continue

            for (let k = 5; k < 12; k++) {
              if (!isDigit(html.charCodeAt(i + k))) {
                i = -1
                break
              }
            }
            if (i === -1) continue

            return html.slice(i, i + 12)
          }
        }

        return null
      }

      const appleMusicUrl = extractHrefStartingAt(
        'href="https://www.shazam.com/applemusic/song/'
      )

      const durationMs = (() => {
        const findIso = () => {
          const needles = [
            '"duration":"PT',
            '"duration": "PT',
            '\\"duration\\":\\"PT'
          ]
          for (let i = 0; i < needles.length; i++) {
            const n = needles[i]
            const at = html.indexOf(n)
            if (at === -1) continue

            const start = at + n.length - 2
            const end =
              n[0] === '\\'
                ? html.indexOf('\\"', start)
                : html.indexOf('"', start)
            return end === -1 ? null : html.slice(start, end)
          }
          return null
        }

        const parseIsoMs = (iso) => {
          if (!iso) return 0
          const t = iso.indexOf('T')
          if (t === -1) return 0

          let ms = 0
          let num = 0
          let frac = 0
          let fracDiv = 1
          let inFrac = false

          for (let i = t + 1; i < iso.length; i++) {
            const c = iso.charCodeAt(i)

            if (c >= 48 && c <= 57) {
              const d = c - 48
              if (inFrac) {
                frac = frac * 10 + d
                fracDiv *= 10
              } else {
                num = num * 10 + d
              }
              continue
            }

            if (c === 46) {
              inFrac = true
              continue
            }

            const val = inFrac ? num + frac / fracDiv : num
            if (c === 72) ms += val * 3600000
            else if (c === 77) ms += val * 60000
            else if (c === 83) ms += val * 1000
            else break

            num = 0
            frac = 0
            fracDiv = 1
            inFrac = false
          }

          return ms ? Math.round(ms) : 0
        }

        return parseIsoMs(findIso())
      })()

      const isrc = extractIsrcFromHtml()

      const extractMetaContent = (prop) => {
        const regex = new RegExp(`<meta property="${prop}" content="([^"]+)"`)
        const match = html.match(regex)
        return match ? match[1] : null
      }

      let title = extractTextAfterClass('NewTrackPageHeader_trackTitle__')
      let artist = extractTextAfterClass('TrackPageArtistLink_artistNameText__')
      let artworkUrl = extractArtworkFromImgAlt()

      if (!title || title === 'Unknown') {
        const ogTitle = extractMetaContent('og:title')
        if (ogTitle) {
          const match = ogTitle.match(/^(.+?) - (.+?):/)
          if (match) {
            title = match[1]
            artist = match[2]
          } else {
             title = ogTitle
          }
        }
      }

      if (!title) title = 'Unknown'
      if (!artist) artist = 'Unknown'

      if (!artworkUrl) {
        artworkUrl = extractMetaContent('og:image')
      }

      if (title === 'Unknown' && !appleMusicUrl)
        return { loadType: 'empty', data: {} }

      const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url
      const identifier = cleanUrl.slice(cleanUrl.lastIndexOf('/') + 1)

      const trackInfo = {
        identifier,
        isSeekable: true,
        author: artist,
        length: durationMs || 0,
        isStream: false,
        position: 0,
        title,
        uri: url,
        artworkUrl,
        isrc: null,
        sourceName: 'shazam',
        appleMusicUrl
      }

      if (isrc) trackInfo.isrc = isrc

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        }
      }
    } catch (error) {
      logger('error', 'Shazam', `Failed to resolve ${url}: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    try {
      const query = `${decodedTrack.title} ${decodedTrack.author}`
      const hasResults = (r) => r?.loadType === 'search' && r.data?.length

      let searchResult

      if (decodedTrack.isrc) {
        searchResult = await this.nodelink.sources.search(
          'youtube',
          `"${decodedTrack.isrc}"`,
          'ytmsearch'
        )

        if (hasResults(searchResult)) {
          logger(
            'debug',
            'Shazam',
            `Found result via ISRC: ${decodedTrack.isrc}`
          )
        }
      }

      if (!hasResults(searchResult)) {
        if (decodedTrack.isrc) {
          logger(
            'debug',
            'Shazam',
            `ISRC search failed for ${decodedTrack.isrc}, falling back to text query`
          )
        }

        searchResult = await this.nodelink.sources.search(
          'youtube',
          query,
          'ytmsearch'
        )
      }

      if (!hasResults(searchResult)) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (!hasResults(searchResult)) {
        return {
          exception: { message: 'No alternative found.', severity: 'fault' }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack, {
        allowExplicit: this.allowExplicit
      })

      if (!bestMatch) {
        return {
          exception: { message: 'No suitable match.', severity: 'fault' }
        }
      }

      const stream = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...stream }
    } catch (error) {
      logger('error', 'Shazam', `Failed to get track URL: ${error.message}`)
      return { exception: { message: error.message, severity: 'fault' } }
    }
  }

  _buildTrack(item) {
    if (!item?.id) return null

    const attributes = item.attributes || {}
    const artwork = this._parseArtwork(attributes.artwork)
    const isExplicit = attributes.contentRating === 'explicit'

    let trackUri = attributes.url || ''
    if (trackUri) {
      trackUri += `${trackUri.includes('?') ? '&' : '?'}explicit=${isExplicit}`
    }

    const trackInfo = {
      identifier: item.id,
      isSeekable: true,
      author: attributes.artistName || 'Unknown',
      length: attributes.durationInMillis ?? 0,
      isStream: false,
      position: 0,
      title: attributes.name || 'Unknown',
      uri: trackUri,
      artworkUrl: artwork,
      isrc: attributes.isrc || null,
      sourceName: 'shazam'
    }

    return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: {} }
  }

  _parseArtwork(artworkData) {
    if (!artworkData?.url) return null
    return artworkData.url
      .replace('{w}', artworkData.width)
      .replace('{h}', artworkData.height)
  }
}
