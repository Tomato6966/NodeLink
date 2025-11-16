import { logger, makeRequest } from '../utils.js'

const APPLE_SEARCH_API = `http://lyrics.paxsenix.dpdns.org/searchAppleMusic.php?q=`
const APPLE_LYRICS_API = `http://lyrics.paxsenix.dpdns.org/getAppleMusicLyrics.php?id=`

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]

const FEAT_PATTERN =
  /\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\s+[^\)\]]+[\)\]]/gi
const SEPARATORS = [' - ', ' – ', ' — ']

const _clean = (text, removeFeat = false) => {
  if (!text) return ''
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
      return {
        artist: cleaned.slice(0, idx).trim(),
        title: cleaned.slice(idx + sep.length).trim()
      }
    }
  }
  return { artist: null, title: _clean(query, true) }
}

export default class AppleMusicLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
  }

  async setup() {
    const adv = this.config.lyrics.applemusic?.advanceSearch || false
    if (adv) {
      logger('info', 'Lyrics', 'Apple Music: Advanced search enabled.')
    }
    return true
  }

  _parseSynced(contentArray) {
    const lines = []
    for (const e of contentArray) {
      const txt = e.text
        ?.map((t) => t.text)
        .join(' ')
        .trim()
      if (!txt) continue
      const s = e.timestamp ?? 0
      const ed = e.endtime ?? 0
      lines.push({ text: txt, time: s, duration: Math.max(ed - s, 0) })
    }
    return lines
  }

  async _getLyricsByID(id) {
    try {
      const url = APPLE_LYRICS_API + id
      const { body } = await makeRequest(url, { method: 'GET' })
      if (!body) return null
      const synced = body.type === 'Line'
      let lines = []
      if (synced) {
        lines = this._parseSynced(body.content)
      } else {
        const raw = body.plainLyrics ?? ''
        lines = raw
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((t) => ({ text: t, time: 0, duration: 0 }))
      }
      if (!lines.length) return null
      return { synced, lines }
    } catch {
      return null
    }
  }

  _findBestAppleMatch(results, title, authors) {
    if (!title) return results[0]
    const normalize = (s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
    const scoreStrings = (a, b) => {
      a = normalize(a)
      b = normalize(b)
      if (a === b) return 100
      let m = 0
      const len = Math.max(a.length, b.length)
      for (let i = 0; i < Math.min(a.length, b.length); i++)
        if (a[i] === b[i]) m++
      return Math.round((m / len) * 100)
    }
    let best = null
    let bestScore = -1
    for (const r of results) {
      const ts = scoreStrings(r.songName, title)
      let as = 0
      if (authors.length)
        as = Math.max(...authors.map((a) => scoreStrings(r.artistName, a)))
      const final = ts * 0.7 + as * 0.3
      r.__matchScore = final
      if (final > bestScore) {
        bestScore = final
        best = r
      }
    }
    return best
  }

  async _searchApple(info) {
    let title = null
    let authors = []
    const adv = this.config.lyrics.applemusic?.advanceSearch || false

    if (info.sourceName === 'youtube' && adv) {
      try {
        const res = await this.nodelink.sources.resolve(info.uri)

        if (res.loadType === 'track' && res.data.info) {
          const trackInfo = res.data.info
          title =
            info.title !== trackInfo.title
              ? trackInfo.title
              : _clean(info.title, true)
          authors = trackInfo.author ? trackInfo.author.split(', ') : []
        } else {
          logger(
            'warn',
            'Lyrics',
            'YouTube resolve returned invalid info, fallback used.'
          )
        }
      } catch (err) {
        logger('error', 'Lyrics', `YouTube resolve failed: ${err.message}`)
      }
    }

    const query = (() => {
      if (title && authors.length) return `${title} ${authors[0]}`
      if (title) return title
      return `${_clean(info.title, true)} ${_clean(info.author, false)}`
    })()
    let results
    try {
      const url = APPLE_SEARCH_API + encodeURIComponent(query)
      const { body: raw } = await makeRequest(url, {
        method: 'GET',
        timeout: 4000
      })
      results = JSON.parse(raw)
    } catch (e) {
      logger(
        'error',
        'Lyrics',
        `AppleMusic: Apple search failed (${e.message})`
      )
      return null
    }
    if (!Array.isArray(results) || !results.length) {
      logger('warn', 'Lyrics', 'AppleMusic: No results returned.')
      return null
    }
    let best = null
    try {
      best = this._findBestAppleMatch(results, _clean(title), authors)
    } catch (e) {
      logger('error', 'Lyrics', `Matching failed (${e.message})`)
    }
    if (!best) {
      logger('warn', 'Lyrics', 'AppleMusic: No strong match, falling back.')
      return results[0]
    }

    return best
  }

  async getLyrics(trackInfo) {
    try {
      const isApple = trackInfo.sourceName === 'applemusic'
      let id = null
      let matched = null
      if (isApple && trackInfo.identifier) {
        id = trackInfo.identifier
        logger('debug', 'Lyrics', `AppleMusic: Direct ID: ${id}`)
      }
      if (!id) {
        matched = await this._searchApple(trackInfo)
        if (!matched) return { loadType: 'empty', data: {} }
        id = matched.id
      }
      const lyr = await this._getLyricsByID(id)
      if (!lyr) return { loadType: 'empty', data: {} }
      const trackName = matched?.songName || trackInfo.title
      return {
        loadType: 'lyrics',
        data: {
          name: trackName,
          synced: lyr.synced,
          lines: lyr.lines
        }
      }
    } catch (e) {
      logger('error', 'Lyrics', `AppleMusic error: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
