import type { SourceResult, TrackInfo } from '../sources/source.types.ts'
import type { BestMatchCandidate, BestMatchTrackInfo } from '../utils.types.ts'

/**
 * JWT payload returned by Deezer anonymous auth endpoint.
 * @public
 */
export interface DeezerJwtResponse {
  /**
   * JWT token used for Deezer GraphQL requests.
   */
  jwt?: string
}

/**
 * Word-level timing payload from Deezer lyrics API.
 * @public
 */
export interface DeezerLyricsWord {
  /**
   * Start timestamp in milliseconds.
   */
  start: number

  /**
   * End timestamp in milliseconds.
   */
  end: number

  /**
   * Word text.
   */
  word: string
}

/**
 * Line payload with word-by-word timing from Deezer lyrics API.
 * @public
 */
export interface DeezerSynchronizedWordByWordLine {
  /**
   * Line start timestamp in milliseconds.
   */
  start: number

  /**
   * Line end timestamp in milliseconds.
   */
  end: number

  /**
   * Word timing entries.
   */
  words: DeezerLyricsWord[]
}

/**
 * Line payload with per-line timing from Deezer lyrics API.
 * @public
 */
export interface DeezerSynchronizedLine {
  /**
   * Line timestamp in milliseconds.
   */
  milliseconds: number

  /**
   * Line duration in milliseconds.
   */
  duration: number

  /**
   * Line text.
   */
  line: string
}

/**
 * Deezer lyrics payload returned for a track.
 * @public
 */
export interface DeezerLyricsPayload {
  /**
   * Unsynced plain-text lyrics.
   */
  text?: string

  /**
   * Word-by-word synced lyrics.
   */
  synchronizedWordByWordLines?: DeezerSynchronizedWordByWordLine[]

  /**
   * Line-synced lyrics.
   */
  synchronizedLines?: DeezerSynchronizedLine[]
}

/**
 * Deezer GraphQL response shape used by lyrics provider.
 * @public
 */
export interface DeezerGraphqlResponse {
  /**
   * GraphQL data envelope.
   */
  data?: {
    /**
     * Track payload envelope.
     */
    track?: {
      /**
       * Lyrics payload for the selected track.
       */
      lyrics?: DeezerLyricsPayload
    }
  }
}

/**
 * Deezer search candidate used for best-match scoring.
 * @public
 */
export interface DeezerSearchCandidate extends BestMatchCandidate {
  /**
   * Candidate track info.
   */
  info: BestMatchTrackInfo & Pick<TrackInfo, 'identifier'>
}

/**
 * Minimal source manager shape required by Deezer lyrics provider.
 * @public
 */
export interface DeezerLyricsSourceManager {
  /**
   * Searches tracks for a given source key.
   */
  search: (source: string, query: string) => Promise<SourceResult>
}

/**
 * Minimal NodeLink context shape required by Deezer lyrics provider.
 * @public
 */
export interface NodelinkInstanceForDeezerLyrics {
  /**
   * Source manager accessor.
   */
  sources: DeezerLyricsSourceManager
}
