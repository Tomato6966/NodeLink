/**
 * Type definitions for Pandora source.
 * @module typings/sources/pandora.types
 */

import type { TrackData, TrackInfo } from './source.types.ts'

/**
 * Pandora CSRF token structure.
 * @public
 */
export interface PandoraCsrfToken {
  /** Raw cookie string. */
  raw: string
  /** Parsed CSRF token value. */
  parsed: string
}

/**
 * Pandora source configuration options.
 * @public
 */
export interface PandoraSourceConfig {
  /** Pre-configured CSRF token (optional). */
  csrfToken?: string
  /** Remote token provider URL (optional). */
  remoteTokenUrl?: string
  /** Enable/disable source. */
  enabled?: boolean
}

/**
 * Remote token provider response.
 * @public
 */
export interface PandoraRemoteTokenResponse {
  success: boolean
  authToken?: string
  csrfToken?: string
  expires_in_seconds?: number
}

/**
 * Pandora anonymous login response.
 * @public
 */
export interface PandoraAuthResponse {
  authToken?: string
  errorCode?: number
}

/**
 * Pandora API error response.
 * @public
 */
export interface PandoraApiError {
  message?: string
  errorCode?: number
  errors?: unknown[]
}

/**
 * Pandora artwork structure.
 * @public
 */
export interface PandoraArtwork {
  artId?: string
  dominantColor?: string
  artUrl?: string
  url?: string
}

/**
 * Pandora artist reference.
 * @public
 */
export interface PandoraArtistRef {
  name?: string
  __typename?: string
}

/**
 * Pandora track annotation from API.
 * @public
 */
export interface PandoraTrackAnnotation {
  type?: string
  name?: string
  pandoraId?: string
  id?: string
  artistName?: string | PandoraArtistRef
  programName?: string
  shareableUrlPath?: string
  urlPath?: string
  icon?: PandoraArtwork
  art?: PandoraArtwork[]
  duration?: number
  trackLength?: number
  length?: number
  isrc?: string
}

/**
 * Pandora search result structure.
 * @public
 */
export interface PandoraSearchResult {
  results?: unknown[]
  annotations?: Record<string, PandoraTrackAnnotation>
}

/**
 * Pandora playlist track request body.
 * @public
 */
export interface PandoraPlaylistRequest {
  request: {
    pandoraId: string
    playlistVersion: number
    offset: number
    limit: number
    annotationLimit: number
    allowedTypes: string[]
    bypassPrivacyRules: boolean
  }
}

/**
 * Pandora playlist response.
 * @public
 */
export interface PandoraPlaylistResponse {
  name?: string
  annotations?: Record<string, PandoraTrackAnnotation>
}

/**
 * Pandora station details response.
 * @public
 */
export interface PandoraStationDetails {
  name?: string
  seeds?: PandoraStationSeed[]
  message?: string
}

/**
 * Pandora station seed.
 * @public
 */
export interface PandoraStationSeed {
  song?: {
    songTitle?: string
    artistSummary?: string
    songDetailUrl?: string
    songId?: string
  }
  art?: Array<{ url?: string }>
}

/**
 * Pandora station playlist item.
 * @public
 */
export interface PandoraPlaylistItem {
  songName?: string
  artistName?: string
  songDetailUrl?: string
  albumArtUrl?: string
  songId?: string
  trackLength?: number
}

/**
 * Pandora station playlist response.
 * @public
 */
export interface PandoraStationPlaylistResponse {
  items?: PandoraPlaylistItem[]
}

/**
 * Pandora podcast details response.
 * @public
 */
export interface PandoraPodcastDetails {
  details?: {
    podcastProgramDetails?: { type?: string }
    podcastEpisodeDetails?: { type?: string; pandoraId?: string }
    annotations?: Record<string, PandoraTrackAnnotation>
  }
  message?: string
}

/**
 * Pandora podcast episodes response.
 * @public
 */
export interface PandoraPodcastEpisodesResponse {
  episodes?: {
    episodesWithLabel?: Array<{
      episodes?: string[]
    }>
  }
  message?: string
}

/**
 * Pandora annotate objects response.
 * @public
 */
export interface PandoraAnnotateResponse {
  annotations?: Record<string, PandoraTrackAnnotation>
  message?: string
}

/**
 * Pandora GraphQL artist response.
 * @public
 */
export interface PandoraArtistGraphQLResponse {
  data?: {
    entity?: {
      name?: string
      topTracksWithCollaborations?: PandoraTrackAnnotation[]
    }
  }
  errors?: unknown[]
}

/**
 * Pandora catalog details response.
 * @public
 */
export interface PandoraCatalogDetailsResponse {
  annotations?: Record<string, PandoraTrackAnnotation>
  errors?: unknown[]
}

/**
 * Pandora track data with encoded info.
 * @public
 */
export type PandoraTrackData = TrackData

/**
 * Pandora track info.
 * @public
 */
export interface PandoraTrackInfo extends TrackInfo {
  sourceName: 'pandora'
}
