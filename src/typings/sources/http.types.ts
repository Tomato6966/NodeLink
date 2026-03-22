import type { TrackInfo } from './source.types.ts'

/**
 * Parsed ICY metadata payload emitted by metadata transform.
 * @public
 */
export interface IcyMetadataPayload {
  /**
   * Raw ICY metadata payload after trimming null bytes.
   */
  raw: string

  /**
   * ICY stream title value.
   */
  streamTitle: string | null

  /**
   * ICY stream URL value.
   */
  streamUrl: string | null

  /**
   * Parsed ICY metadata fields.
   */
  fields: Record<string, string>
}

/**
 * ICY headers attached to metadata events.
 * @public
 */
export interface IcyMetadataHeaders {
  /**
   * Stream name.
   */
  name: string | null

  /**
   * Stream description.
   */
  description: string | null

  /**
   * Stream genre.
   */
  genre: string | null

  /**
   * Stream URL.
   */
  url: string | null

  /**
   * Stream bitrate.
   */
  bitrate: string | null
}

/**
 * Parsed plugin info attached to resolved HTTP tracks.
 * @public
 */
export interface HttpResolvedPluginInfo {
  /**
   * Stream bitrate.
   */
  bitrate: number

  /**
   * Stream genre.
   */
  genre: string

  /**
   * Stream station URL.
   */
  stationUrl: string

  /**
   * Derived artwork URL when available.
   */
  artworkUrl: string | null

  /**
   * ICY bitrate header value.
   */
  icyBr: string

  /**
   * ICE audio info header value.
   */
  audioInfo: string
}

/**
 * Track payload returned by HTTP source resolution.
 * @public
 */
export interface HttpResolvedTrackData {
  /**
   * Encoded track string.
   */
  encoded: string

  /**
   * Track metadata.
   */
  info: TrackInfo

  /**
   * Source plugin metadata.
   */
  pluginInfo: HttpResolvedPluginInfo
}

/**
 * Metadata event payload emitted by HTTP stream wrapper.
 * @public
 */
export interface IcyMetadataEventPayload {
  /**
   * Parsed metadata payload.
   */
  metadata: IcyMetadataPayload

  /**
   * Stream-level ICY headers.
   */
  icy: IcyMetadataHeaders

  /**
   * Event reception timestamp in milliseconds.
   */
  receivedAt: number
}
