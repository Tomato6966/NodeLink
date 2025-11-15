import { logger, makeRequest } from '../utils.js'
import Fuse from 'fuse.js'


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

  return {
    artist: null,
    title: _clean(query, true)
  }
}

export default class AppleMusicLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  _parseSynced(contentArray) {
    const lines = []

    for (const entry of contentArray) {
      const text = entry.text?.map(t => t.text).join(' ').trim()
      if (!text) continue

      const start = entry.timestamp ?? 0
      const end = entry.endtime ?? 0

      lines.push({
        text,
        time: start,
        duration: Math.max(end - start, 0)
      })
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
          .map(line => line.trim())
          .filter(Boolean)
          .map(text => ({ text, time: 0, duration: 0 }))
      }

      if (!lines.length) return null

      return { synced, lines }
    } catch {
      return null
    }
  }

  async _searchApple(query) {

    const url = APPLE_SEARCH_API + encodeURIComponent(query)
    const { body: raw_results } = await makeRequest(url, { method: 'GET' })
    let results = JSON.parse(raw_results)

    if (!Array.isArray(results) || results.length === 0) return null

    const fuse = new Fuse(results, {
      includeScore: true,
      keys: ['songName', 'artistName'],
      threshold: 0.4
    })

    const found = fuse.search(query)
    return found.length ? found[0].item : results[0]
  }

  async getLyrics(trackInfo) {
    try {
      const isAppleSource = trackInfo.sourceName === 'applemusic'
      let songID = null
      let matchedTrack = null


      if (isAppleSource && trackInfo.identifier) {
        songID = trackInfo.identifier
        logger('debug', 'Lyrics', `AppleMusic: Direct ID: ${songID}`)
      }

      if (!songID) {
        const parsed = _parse(trackInfo.title)
        const cleanAuthor = _clean(trackInfo.author, false)

        const artist = parsed.artist || cleanAuthor
        const title = parsed.artist ? parsed.title : _clean(trackInfo.title, true)
        const query = `${title} ${artist}`

        logger('debug', 'Lyrics', `AppleMusic: Searching: ${query}`)

        matchedTrack = await this._searchApple(query)
        if (!matchedTrack) {
          return { loadType: 'empty', data: {} }
        }

        songID = matchedTrack.id
      }

      const lyricObj = await this._getLyricsByID(songID)
      if (!lyricObj) {
        return { loadType: 'empty', data: {} }
      }

      const trackName =
        matchedTrack?.songName || trackInfo.title

      return {
        loadType: 'lyrics',
        data: {
          name: trackName,
          synced: lyricObj.synced,
          lines: lyricObj.lines
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
