import type { SourceResult, TrackInfo } from './source.types.ts'

/**
 * Apple Music artwork metadata.
 * @public
 */
export interface AppleMusicArtwork {
  /**
   * Raw artwork URL with {w} and {h} placeholders.
   */
  url: string

  /**
   * Original artwork width.
   */
  width: number

  /**
   * Original artwork height.
   */
  height: number
}

/**
 * Editorial video metadata for motion artwork.
 * @public
 */
export interface AppleMusicEditorialVideo {
  /**
   * Video variants for different aspect ratios.
   */
  motionDetailSquare?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionDetailTall?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionSquareVideo1x1?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionArtistFullscreen16x9?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionArtistSquare1x1?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionArtistSquare?: { video: string }
  /**
   * Video variants for different aspect ratios.
   */
  motionArtistFullscreen?: { video: string }
}

/**
 * Common Apple Music resource attributes.
 * @public
 */
export interface AppleMusicAttributes {
  /**
   * Resource name or title.
   */
  name?: string

  /**
   * Resource artist or curator name.
   */
  artistName?: string

  /**
   * Canonical Apple Music URL.
   */
  url?: string

  /**
   * Artwork metadata.
   */
  artwork?: AppleMusicArtwork

  /**
   * Duration in milliseconds for songs.
   */
  durationInMillis?: number

  /**
   * Content rating (e.g., 'explicit').
   */
  contentRating?: string

  /**
   * ISRC for songs.
   */
  isrc?: string

  /**
   * Album name for songs.
   */
  albumName?: string

  /**
   * Preview audio sources.
   */
  previews?: Array<{ url: string }>

  /**
   * Motion artwork video metadata.
   */
  editorialVideo?: AppleMusicEditorialVideo

  /**
   * Track count for albums and playlists.
   */
  trackCount?: number

  /**
   * Curator name for playlists.
   */
  curatorName?: string
}

/**
 * Generic Apple Music resource shape.
 * @public
 */
export interface AppleMusicResource {
  /**
   * Stable Apple Music identifier.
   */
  id: string

  /**
   * Resource type (e.g., 'songs', 'albums').
   */
  type: string

  /**
   * Resource attributes.
   */
  attributes?: AppleMusicAttributes

  /**
   * Related resource links.
   */
  relationships?: {
    /**
     * Related tracks.
     */
    tracks?: {
      /**
       * Track list.
       */
      data?: AppleMusicResource[]
      /**
       * Metadata including total count.
       */
      meta?: { total?: number }
    }
    /**
     * Related albums.
     */
    albums?: {
      /**
       * Album list.
       */
      data?: AppleMusicResource[]
    }
  }

  /**
   * Resolved artist URL.
   */
  artistUrl?: string
}

/**
 * Apple Music API response shape.
 * @public
 */
export interface AppleMusicApiResponse {
  /**
   * Primary data results.
   */
  data?: AppleMusicResource[]

  /**
   * Search result buckets.
   */
  results?: {
    songs?: { data?: AppleMusicResource[] }
    albums?: { data?: AppleMusicResource[] }
    playlists?: { data?: AppleMusicResource[] }
    artists?: { data?: AppleMusicResource[] }
  }
}

/**
 * Apple Music track data with plugin metadata.
 * @public
 */
export interface AppleMusicTrackData {
  /**
   * Base64-encoded Lavalink track.
   */
  encoded: string

  /**
   * Track information.
   */
  info: TrackInfo

  /**
   * Apple Music-specific plugin metadata.
   */
  pluginInfo: {
    albumName?: string
    albumUrl?: string
    artistUrl?: string
    previewUrl?: string
    hlsVideoUrl?: string
    type?: string
    trackCount?: number | null
  }
}

/**
 * Unified result for Apple Music operations.
 * @public
 */
export type AppleMusicSourceResult =
  | { loadType: 'track'; data: AppleMusicTrackData }
  | { loadType: 'search'; data: AppleMusicTrackData[] }
  | {
      loadType: 'playlist'
      data: {
        info: { name: string; selectedTrack: number }
        tracks: AppleMusicTrackData[]
      }
    }
  | { loadType: 'empty'; data: Record<string, never> }
  | { exception: { message: string; severity: string } }
  | SourceResult
