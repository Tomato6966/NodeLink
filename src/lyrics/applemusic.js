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



  _findBestAppleMatch(results, title, authors) {
    if (!title) return results[0];

    const normalize = (str) =>
      str.toLowerCase()
        .replace(/[^a-z0-9]+/gi, " ")
        .trim();

    const scoreStrings = (a, b) => {
      a = normalize(a);
      b = normalize(b);
      if (a === b) return 100;
      let matches = 0;
      const len = Math.max(a.length, b.length);

      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) matches++;
      }

      return Math.round((matches / len) * 100);
    };

    let bestMatch = null;
    let bestScore = -1;

    for (const r of results) {
      const titleScore = scoreStrings(r.songName, title);

      let artistScore = 0;

      if (authors.length) {
        artistScore = Math.max(
          ...authors.map(a => scoreStrings(r.artistName, a))
        );
      }

      const finalScore = titleScore * 0.7 + artistScore * 0.3;

      r.__matchScore = finalScore;

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestMatch = r;
      }
    }

    return bestMatch;
  }



  async _searchApple(info) {
    let title = null;
    let authors = [];

    if (info.sourceName === "youtube") {
      try {
        const { body: res } = await makeRequest(
          `https://ytm-api-nodelink.vercel.app/api/song-info?videoId=${encodeURIComponent(info.identifier)}`,
          { method: 'GET', timeout: 4000 }
        );

        if (res && res.title) {
         if(info.title !== res.title) { title = res.title } else { title = _clean(info.title, true)};
          authors = Array.isArray(res.artists) ? res.artists : [];
        } else {
          logger('warn', 'Lyrics', "AppleMusic: YTM API returned invalid data, using fallback.");
        }
      } catch (err) {
        logger('error', 'Lyrics', `AppleMusic: YTM API failed (${err.message}), using fallback info.`);
      }
    }


    const query = (() => {
      if (title && authors.length) return `${title} ${authors[0]}`;
      if (title) return title;
      return `${_clean(info.title, true)} ${_clean(info.author, false)}`;
    })();

    let results;

    try {
      const url = APPLE_SEARCH_API + encodeURIComponent(query);
      const { body: raw_results } = await makeRequest(url, { method: 'GET', timeout: 4000 });
      results = JSON.parse(raw_results);
    } catch (err) {
      logger('error', 'Lyrics', `AppleMusic: Apple search failed (${err.message})`);
      return null;
    }

    if (!Array.isArray(results) || results.length === 0) {
      logger('warn', 'Lyrics', "AppleMusic: No results returned.");
      return null;
    }

    let best = null;

    try {
      best = this._findBestAppleMatch(results, _clean(title), authors);
    } catch (err) {
      logger('error', 'Lyrics', `AppleMusic: Matching failed (${err.message})`);
    }

    if (!best) {
      logger('warn', 'Lyrics', "AppleMusic: No strong match, falling back to top result.");
      return results[0];
    }

    logger('info', 'Lyrics', `AppleMusic: Best Match Selected => ${JSON.stringify(best)}`);
    return best;
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
        matchedTrack = await this._searchApple(trackInfo)
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
