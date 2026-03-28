/**
 * Type definitions for Anghami source.
 * @module typings/sources/anghami.types
 */

import type { TrackData, TrackInfo } from './source.types.ts'

/**
 * Anghami source configuration options.
 * @public
 */
export interface AnghamiSourceConfig {
  enabled?: boolean
  cookies?: string
}

/**
 * Generic Anghami object map.
 * @public
 */
export type AnghamiRecord = Record<string, unknown>

/**
 * Raw Anghami track payload from API responses.
 * @public
 */
export interface AnghamiTrackPayload extends AnghamiRecord {
  id?: string | number
  title?: string
  name?: string
  artist?: string
  artistName?: string
  duration?: string | number
  coverArt?: string
  AlbumArt?: string
  cover?: string
}

/**
 * Anghami section payload used by search/resolve endpoints.
 * @public
 */
export interface AnghamiSection {
  type?: string
  group?: string
  data?: AnghamiTrackPayload[]
}

/**
 * Anghami tab search response payload.
 * @public
 */
export interface AnghamiSearchResponse extends AnghamiRecord {
  sections?: AnghamiSection[]
}

/**
 * Anghami song response payload.
 * @public
 */
export interface AnghamiSongResponse extends AnghamiTrackPayload {
  status?: string
}

/**
 * Anghami metadata block containing embedded attributes.
 * @public
 */
export interface AnghamiMetaBlock extends AnghamiRecord {
  title?: string
  name?: string
  songorder?: string
  songs?: Record<string, unknown>
  _attributes?: AnghamiRecord
}

/**
 * Anghami collection response used by playlist/album endpoints.
 * @public
 */
export interface AnghamiCollectionResponse extends AnghamiRecord {
  error?: unknown
  title?: string
  name?: string
  songorder?: string
  songbuffers?: string[]
  sections?: AnghamiSection[]
  data?: AnghamiTrackPayload[]
  playlist?: AnghamiMetaBlock
  album?: AnghamiMetaBlock
  songs?: Record<string, unknown>
  _attributes?: AnghamiRecord
}

/**
 * Anghami artist profile response payload.
 * @public
 */
export interface AnghamiArtistResponse extends AnghamiRecord {
  name?: string
  title?: string
  sections?: AnghamiSection[]
  data?: AnghamiTrackPayload[]
}

/**
 * Anghami URL resolve target type.
 * @public
 */
export type AnghamiResolveType = 'song' | 'album' | 'playlist' | 'artist'

/**
 * Decoded song payload from buffered protobuf playlist responses.
 * @public
 */
export interface AnghamiDecodedSong {
  id: string
  title: string
  album: string
  albumID: string
  artist: string
  artistID: string
  track: number
  year: string
  duration: number
  coverArt: string
  genre: string
  keywords: string[]
  description: string
  playervideo: string
  videoid: string
  thumbnailid: string
  ArtistArt?: string
  artistType: number
  artistGender: number
}

/**
 * Decoded protobuf batch response for songs.
 * @public
 */
export interface AnghamiSongBatchResponse {
  response: Record<string, AnghamiDecodedSong>
  takendownSongIds: string[]
  missingSongIds: string[]
}

/**
 * Anghami normalized track data.
 * @public
 */
export type AnghamiTrackData = TrackData

/**
 * Anghami normalized track info.
 * @public
 */
export interface AnghamiTrackInfo extends TrackInfo {
  sourceName: 'anghami'
}
