import { getBestMatch, logger, makeRequest } from '../utils.ts'
import type { TrackInfo } from '../typings/sources/source.types.ts'
import type { LyricsLine } from '../typings/lyrics/musixmatch.types.ts'
import type {
  DeezerGraphqlResponse,
  DeezerJwtResponse,
  DeezerLyricsResult,
  DeezerSearchCandidate,
  NodelinkInstanceForDeezerLyrics
} from '../typings/lyrics/deezer.types.ts'

/**
 * Deezer lyrics provider backed by Deezer GraphQL endpoint.
 * @public
 */
export default class DeezerLyrics {
  /**
   * Runtime NodeLink context.
   */
  public readonly nodelink: NodelinkInstanceForDeezerLyrics

  /**
   * Cached Deezer JWT token.
   */
  private jwt: string | null

  /**
   * JWT expiration timestamp in milliseconds.
   */
  private jwtExpiry: number

  /**
   * Creates a new Deezer lyrics provider.
   * @param nodelink - Runtime NodeLink context.
   */
  public constructor(nodelink: NodelinkInstanceForDeezerLyrics) {
    this.nodelink = nodelink
    this.jwt = null
    this.jwtExpiry = 0
  }

  /**
   * Initializes provider resources.
   * @returns Always true for this provider.
   */
  public async setup(): Promise<boolean> {
    return true
  }

  /**
   * Retrieves and caches Deezer JWT used by lyrics endpoint.
   * @returns JWT token or null when unavailable.
   * @internal
   */
  private async _getJwt(): Promise<string | null> {
    if (this.jwt && Date.now() < this.jwtExpiry) return this.jwt

    try {
      const { body, error } = await makeRequest(
        'https://auth.deezer.com/login/anonymous?jo=p&rto=c',
        { method: 'GET' }
      )

      if (error) throw new Error('Request failed')

      const data =
        typeof body === 'string'
          ? (JSON.parse(body) as DeezerJwtResponse)
          : (body as DeezerJwtResponse)

      if (!data?.jwt) throw new Error('No JWT in response')

      this.jwt = data.jwt
      this.jwtExpiry = Date.now() + 300000

      return this.jwt
    } catch (e) {
      logger(
        'error',
        'Lyrics',
        `Deezer JWT fetch failed: ${e instanceof Error ? e.message : String(e)}`
      )
      return null
    }
  }

  /**
   * Loads lyrics for a track.
   * @param trackInfo - Track metadata from manager.
   * @returns Lyrics payload or empty result.
   */
  public async getLyrics(trackInfo: TrackInfo): Promise<DeezerLyricsResult> {
    const jwt = await this._getJwt()
    if (!jwt) return { loadType: 'empty', data: {} }

    let trackId = trackInfo.identifier

    if (trackInfo.sourceName !== 'deezer') {
      const query = `${trackInfo.title} ${trackInfo.author}`
      const searchRes = await this.nodelink.sources.search('deezer', query)

      const searchData = searchRes.data
      if (searchRes.loadType !== 'search' || !Array.isArray(searchData) || searchData.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const candidates = searchData as DeezerSearchCandidate[]
      const bestMatch = getBestMatch(candidates, trackInfo)
      if (!bestMatch) return { loadType: 'empty', data: {} }
      const matchedCandidate = bestMatch as DeezerSearchCandidate
      trackId = matchedCandidate.info.identifier
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
        typeof res.body === 'string'
          ? (JSON.parse(res.body) as DeezerGraphqlResponse)
          : (res.body as DeezerGraphqlResponse)

      const lyrics = data?.data?.track?.lyrics
      if (res.error || !lyrics) return { loadType: 'empty', data: {} }

      let lines: LyricsLine[] = []
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
          .filter((line) => line.text.length > 0)
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
      logger(
        'error',
        'Lyrics',
        `Deezer lyrics request failed: ${e instanceof Error ? e.message : String(e)}`
      )
      return { loadType: 'empty', data: {} }
    }
  }
}
