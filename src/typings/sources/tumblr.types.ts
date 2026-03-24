import type {
  SourceManager,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Tumblr post metadata extracted from URL patterns.
 * @public
 */
export interface TumblrUrlInfo {
  /**
   * Tumblr blog slug.
   */
  blog: string

  /**
   * Tumblr post identifier.
   */
  id: string
}

/**
 * Minimal media block extracted from Tumblr post content.
 * @public
 */
export interface TumblrMediaContent {
  /**
   * Content type discriminator.
   */
  type?: string

  /**
   * Direct URL when present.
   */
  url?: string

  /**
   * Nested media payload.
   */
  media?: {
    /**
     * Nested direct URL.
     */
    url?: string
  }
}

/**
 * Minimal Tumblr post shape used by resolver.
 * @public
 */
export interface TumblrPostObject {
  /**
   * Object type discriminator.
   */
  objectType?: string

  /**
   * String post ID.
   */
  idString?: string

  /**
   * Numeric post ID.
   */
  id?: string | number

  /**
   * Source blog name.
   */
  blogName?: string

  /**
   * Optional duration in seconds.
   */
  duration?: number

  /**
   * Post summary/title.
   */
  summary?: string

  /**
   * Canonical post URL.
   */
  postUrl?: string

  /**
   * Poster array with optional artwork URLs.
   */
  poster?: Array<{ url?: string }>

  /**
   * Optional thumbnail URL.
   */
  thumbnail?: string

  /**
   * Post content blocks.
   */
  content?: TumblrMediaContent[]
}

/**
 * Parsed Tumblr initial state payload.
 * @public
 */
export interface TumblrInitialState {
  /**
   * Timeline wrapper returned by Tumblr.
   */
  PeeprRoute?: {
    /**
     * Initial timeline payload.
     */
    initialTimeline?: {
      /**
       * Timeline object list.
       */
      objects?: TumblrPostObject[]
    }
  }
}

/**
 * Plugin metadata attached to Tumblr track payloads.
 * @public
 */
export interface TumblrPluginInfo {
  /**
   * Direct media URL extracted from Tumblr.
   */
  directUrl: string
}

/**
 * Track payload returned by Tumblr source.
 * @public
 */
export interface TumblrTrackData {
  /**
   * Encoded track string.
   */
  encoded: string

  /**
   * Canonical track metadata.
   */
  info: TrackInfo

  /**
   * Tumblr plugin metadata.
   */
  pluginInfo: TumblrPluginInfo
}

/**
 * Resolve result union used by Tumblr source.
 * @public
 */
export type TumblrResolveResult =
  | { loadType: 'track'; data: TumblrTrackData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: { message: string; severity: string } }
  | SourceResult

/**
 * Decoded track payload accepted by Tumblr `getTrackUrl`.
 * @public
 */
export type TumblrDecodedTrack = TrackInfo & {
  /**
   * Optional plugin metadata injected during resolve.
   */
  pluginInfo?: Partial<TumblrPluginInfo>
}

/**
 * Track URL response for Tumblr source.
 * @public
 */
export type TumblrTrackUrlResult = TrackUrlResult & {
  protocol: 'https'
  format: 'mp3' | 'mp4'
}

/**
 * Stream result union for Tumblr source.
 * @public
 */
export type TumblrLoadStreamResult =
  | TrackStreamResult
  | { exception: { message: string; severity: string } }

/**
 * Minimal NodeLink context required by Tumblr source.
 * @public
 */
export interface TumblrNodeLinkContext extends WorkerNodeLink {
  /**
   * Source manager accessor used for delegated resolves.
   */
  sources: SourceManager
}
