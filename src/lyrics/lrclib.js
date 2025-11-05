import { logger, makeRequest } from '../utils.js'

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]
// this clears titles like [Official] or (Official), etc... this improves the accuary of the lyrics

const FEAT_PATTERN =
  /\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\s+[^\)\]]+[\)\]]/gi

const SEPARATORS = [' - ', ' – ', ' — ']

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

export default class LRCLIBLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  _parseLRC(lrc) {
    const lines = []
    // match [mm:ss.xx] text for the api resolve it
    const regex = /\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.+?)(?=\[|$)/gs
    let match
    while ((match = regex.exec(lrc)) !== null) {
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const centiseconds = parseInt(match[3], 10)
      const time = (minutes * 60 + seconds) * 1000 + centiseconds * 10
      const text = match[4].trim()
      if (text) {
        lines.push({ text, time, duration: 0 })
      }
    }
    return lines
  }

  _parsePlainLyrics(lyrics) {
    return lyrics
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line)
      .map((text) => ({ text, time: 0, duration: 0 }))
  }

  async getLyrics(trackInfo) {
    const parsed = _parse(trackInfo.title)
    const cleanAuthor = _clean(trackInfo.author, false)
    const artist = parsed.artist || cleanAuthor
    const title = parsed.artist ? parsed.title : _clean(trackInfo.title, true)

    const query = `${title} ${artist}`
    logger('debug', 'Lyrics', `Searching LRCLIB for: ${query}`)

    try {
      const { body: results } = await makeRequest(
        `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
        { method: 'GET' }
      )

      if (!Array.isArray(results) || results.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const titleLower = _clean(title, true).toLowerCase()
      const authorLower = _clean(artist, false).toLowerCase()
      let bestMatch = null

      bestMatch = results.find(
        (r) =>
          _clean(r.trackName, true).toLowerCase() === titleLower &&
          _clean(r.artistName, false).toLowerCase() === authorLower &&
          !r.instrumental
      )

      if (!bestMatch) {
        bestMatch = results.find(
          (r) =>
            _clean(r.trackName, true).toLowerCase() === titleLower &&
            !r.instrumental
        )
      }

      if (!bestMatch) {
        bestMatch = results.find((r) => !r.instrumental)
      }

      if (!bestMatch) {
        return { loadType: 'empty', data: {} }
      }

      let lines = []
      let synced = false

      if (bestMatch.syncedLyrics) {
        lines = this._parseLRC(bestMatch.syncedLyrics)
        synced = true
      } else if (bestMatch.plainLyrics) {
        lines = this._parsePlainLyrics(bestMatch.plainLyrics)
        synced = false
      } else {
        return { loadType: 'empty', data: {} }
      }

      if (lines.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      return {
        loadType: 'lyrics',
        data: {
          name: bestMatch.trackName,
          synced,
          lines
        }
      }
    } catch (e) {
      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics from LRCLIB: ${e.message}`
      )
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
