import { getBestMatch, logger, makeRequest } from '../utils.js'

export default class DeezerLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.jwt = null
    this.jwtExpiry = 0
  }

  async setup() {
    return true
  }

  async _getJwt() {
    if (this.jwt && Date.now() < this.jwtExpiry) return this.jwt

    try {
      const { body, error } = await makeRequest(
        'https://auth.deezer.com/login/anonymous?jo=p&rto=c',
        { method: 'GET' }
      )

      if (error) throw new Error('Request failed')

      const data = typeof body === 'string' ? JSON.parse(body) : body
      if (!data?.jwt) throw new Error('No JWT in response')

      this.jwt = data.jwt
      this.jwtExpiry = Date.now() + 300000

      return this.jwt
    } catch (e) {
      logger('error', 'Lyrics', `Deezer JWT fetch failed: ${e.message}`)
      return null
    }
  }

  async getLyrics(trackInfo) {
    const jwt = await this._getJwt()
    if (!jwt) return { loadType: 'empty', data: {} }

    let trackId = trackInfo.identifier
    if (trackInfo.sourceName !== 'deezer') {
      const query = `${trackInfo.title} ${trackInfo.author}`
      const searchRes = await this.nodelink.sources.search('deezer', query)

      if (searchRes.loadType !== 'search' || !searchRes.data?.length)
        return { loadType: 'empty', data: {} }

      const bestMatch = getBestMatch(searchRes.data, trackInfo)
      if (!bestMatch) return { loadType: 'empty', data: {} }
      trackId = bestMatch.info.identifier
    }

    try {
      const query = `query GetLyrics($trackId: String!) {
  track(trackId: $trackId) {
    id
    lyrics {
      id
      text
      ...SynchronizedWordByWordLines
      ...SynchronizedLines
      licence
      copyright
      writers
      __typename
    }
    __typename
  }
}

fragment SynchronizedWordByWordLines on Lyrics {
  id
  synchronizedWordByWordLines {
    start
    end
    words {
      start
      end
      word
      __typename
    }
    __typename
  }
  __typename
}

fragment SynchronizedLines on Lyrics {
  id
  synchronizedLines {
    lrcTimestamp
    line
    lineTranslated
    milliseconds
    duration
    __typename
  }
  __typename
}`

      const res = await makeRequest('https://pipe.deezer.com/api', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: {
          operationName: 'GetLyrics',
          variables: { trackId: String(trackId) },
          query
        },
        disableBodyCompression: true
      })

      const data =
        typeof res.body === 'string' ? JSON.parse(res.body) : res.body

      if (res.error || !data?.data?.track?.lyrics)
        return { loadType: 'empty', data: {} }

      const lyrics = data.data.track.lyrics
      let lines = []
      let synced = false

      if (lyrics.synchronizedWordByWordLines?.length) {
        synced = true
        lines = lyrics.synchronizedWordByWordLines.map((line) => ({
          time: line.start,
          duration: line.end - line.start,
          text: line.words.map((w) => w.word).join(' '),
          words: line.words.map((w) => ({
            text: w.word,
            timestamp: w.start,
            duration: w.end - w.start
          }))
        }))
      } else if (lyrics.synchronizedLines?.length) {
        synced = true
        lines = lyrics.synchronizedLines.map((line) => ({
          time: line.milliseconds,
          duration: line.duration,
          text: line.line
        }))
      } else if (lyrics.text) {
        lines = lyrics.text
          .split(/\r?\n/)
          .map((text) => ({ time: 0, duration: 0, text: text.trim() }))
          .filter((l) => l.text.length > 0)
      }

      return {
        loadType: 'lyrics',
        data: {
          name: trackInfo.title,
          synced,
          lines
        }
      }
    } catch (e) {
      logger('error', 'Lyrics', `Deezer lyrics request failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }
}
