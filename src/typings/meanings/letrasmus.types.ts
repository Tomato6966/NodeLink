import type { BestMatchCandidate, BestMatchTrackInfo } from '../utils.types.ts'

/**
 * Typed track payload used by Letras provider matching.
 * @public
 */
export interface LetrasTrackInfo extends BestMatchTrackInfo {
  sourceName: 'letrasmus'
  uri: string
}

/**
 * Candidate wrapper used during Letras search ranking.
 * @public
 */
export interface LetrasCandidate extends BestMatchCandidate {
  info: LetrasTrackInfo
}

/**
 * Solr document returned by Letras suggest endpoint.
 * @public
 */
export interface SolrDoc {
  t?: string
  dns?: string
  url?: string
  txt?: string
  art?: string
}

/**
 * Solr response shape from Letras suggest endpoint.
 * @public
 */
export interface SolrResponse {
  response?: {
    docs?: SolrDoc[]
  }
}

/**
 * OMQ lyric metadata embedded in Letras page HTML.
 * @public
 */
export interface OmqLyricPayload {
  Name?: string
  Artist?: string
  YoutubeID?: string
  ID?: string | number
}

/**
 * OMQ meaning metadata embedded in Letras page HTML.
 * @public
 */
export interface OmqMeaningPayload {
  ID?: string | number
  LocaleID?: string | number
  Origin?: string | number
}

/**
 * Parsed meaning block extracted from Letras HTML.
 * @public
 */
export interface MeaningBlock {
  title: string | null
  body: string[]
}
