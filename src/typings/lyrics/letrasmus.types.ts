import type { TrackInfo } from '../sources/source.types.ts'
import type { LyricsLine } from './musixmatch.types.ts'

/**
 * Solr document payload returned by Letras suggest endpoint.
 * @public
 */
export interface LetrasSolrDoc {
  /**
   * Document type discriminator (`2` for track entries).
   */
  t?: string

  /**
   * Artist slug used in Letras URLs.
   */
  dns?: string

  /**
   * Song slug used in Letras URLs.
   */
  url?: string

  /**
   * Track title.
   */
  txt?: string

  /**
   * Track artist.
   */
  art?: string
}

/**
 * Solr response shape used by Letras provider.
 * @public
 */
export interface LetrasSolrResponse {
  /**
   * Solr response envelope.
   */
  response?: {
    /**
     * Candidate documents.
     */
    docs?: LetrasSolrDoc[]
  }
}

/**
 * OMQ lyric payload embedded in Letras HTML.
 * @public
 */
export interface LetrasOmqLyricPayload {
  /**
   * Internal Letras lyric identifier.
   */
  ID?: string | number

  /**
   * Related YouTube video identifier.
   */
  YoutubeID?: string

  /**
   * Track name.
   */
  Name?: string

  /**
   * Original song language.
   */
  SongLanguage?: string
}

/**
 * Translation entry payload exposed by Letras HTML.
 * @public
 */
export interface LetrasTranslationLanguageEntry {
  /**
   * Translation language code.
   */
  languageCode?: string

  /**
   * URL fragments required to build translation page URL.
   */
  url?: {
    /**
     * Artist slug.
     */
    artist?: string

    /**
     * Song slug.
     */
    song?: string

    /**
     * Translation slug.
     */
    translation?: string
  }
}

/**
 * Subtitle API payload returned by Letras endpoint.
 * @public
 */
export interface LetrasSubtitleApiResponse {
  /**
   * API status value.
   */
  status?: string

  /**
   * Original subtitle payload.
   */
  Original?: {
    /**
     * Serialized subtitle JSON payload.
     */
    Subtitle?: string
  }
}

/**
 * Subtitle tuple entry returned by Letras subtitle API.
 * @public
 */
export type LetrasSubtitleRawEntry = [unknown, unknown, unknown, ...unknown[]]

/**
 * Language metadata returned with lyrics responses.
 * @public
 */
export interface LetrasLyricsLanguagePayload {
  /**
   * Language originally requested by caller.
   */
  requested: string | null

  /**
   * Language resolved by provider.
   */
  resolved: string | null

  /**
   * Whether payload is original lyrics or translation.
   */
  type: 'original' | 'translation'
}

/**
 * Track info accepted by Letras lyrics provider.
 * @public
 */
export type LetrasLyricsTrackInfo = Pick<
  TrackInfo,
  'title' | 'author' | 'uri' | 'sourceName'
>

/**
 * Success payload returned by Letras lyrics provider.
 * @public
 */
export interface LetrasLyricsData {
  /**
   * Track display name.
   */
  name: string

  /**
   * Whether lyrics contain synchronization metadata.
   */
  synced: boolean

  /**
   * Language metadata for returned lyrics.
   */
  language: LetrasLyricsLanguagePayload

  /**
   * Parsed lyric lines.
   */
  lines: LyricsLine[]

  /**
   * Optional provider identifier injected by LyricsManager.
   */
  provider?: string
}

/**
 * Unified result returned by Letras lyrics provider.
 * @public
 */
export type LetrasMusLyricsResult =
  | { loadType: 'lyrics'; data: LetrasLyricsData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: { message: string; severity: string } }
