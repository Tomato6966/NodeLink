import type {
  SourceResult,
  TrackCacheManager,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * User block returned by the Mixcloud search API.
 * @public
 */
export interface MixcloudSearchUser {
  /**
   * Display name of the Mixcloud creator.
   */
  name?: string
}

/**
 * Artwork variants returned by Mixcloud search API.
 * @public
 */
export interface MixcloudSearchPictures {
  /**
   * Large thumbnail URL.
   */
  large?: string

  /**
   * Medium thumbnail URL.
   */
  medium?: string
}

/**
 * Single cloudcast item returned by Mixcloud search endpoint.
 * @public
 */
export interface MixcloudSearchItem {
  /**
   * Canonical Mixcloud URL.
   */
  url?: string

  /**
   * Cloudcast title.
   */
  name?: string

  /**
   * Track duration in seconds.
   */
  audio_length?: number

  /**
   * Track owner metadata.
   */
  user?: MixcloudSearchUser

  /**
   * Artwork variants.
   */
  pictures?: MixcloudSearchPictures
}

/**
 * Mixcloud search endpoint payload.
 * @public
 */
export interface MixcloudSearchResponse {
  /**
   * Search result items.
   */
  data?: MixcloudSearchItem[]
}

/**
 * Mixcloud owner/creator payload.
 * @public
 */
export interface MixcloudOwner {
  /**
   * Public display name.
   */
  displayName?: string

  /**
   * Mixcloud username slug.
   */
  username?: string
}

/**
 * Mixcloud picture payload.
 * @public
 */
export interface MixcloudPicture {
  /**
   * Picture URL.
   */
  url?: string
}

/**
 * Encrypted stream payload returned by Mixcloud GraphQL.
 * @public
 */
export interface MixcloudStreamInfo {
  /**
   * Encrypted HLS URL.
   */
  hlsUrl?: string

  /**
   * Encrypted direct media URL.
   */
  url?: string
}

/**
 * Normalized cloudcast node shape consumed by the source.
 * @public
 */
export interface MixcloudTrackNode {
  /**
   * Cloudcast duration in seconds.
   */
  audioLength?: number

  /**
   * Cloudcast title.
   */
  name?: string

  /**
   * Canonical cloudcast URL.
   */
  url?: string

  /**
   * Owner payload.
   */
  owner?: MixcloudOwner

  /**
   * Cover picture payload.
   */
  picture?: MixcloudPicture

  /**
   * Encrypted stream metadata.
   */
  streamInfo?: MixcloudStreamInfo

  /**
   * Restriction reason for unavailable tracks.
   */
  restrictedReason?: string
}

/**
 * GraphQL wrapper for single track lookup.
 * @public
 */
export interface MixcloudTrackLookupResponse {
  /**
   * GraphQL response payload.
   */
  data?: {
    /**
     * Looked-up cloudcast node.
     */
    cloudcastLookup?: MixcloudTrackNode | null
  }
}

/**
 * Cursor metadata for paginated GraphQL collections.
 * @public
 */
export interface MixcloudPageInfo {
  /**
   * Cursor for the next page.
   */
  endCursor?: string | null

  /**
   * Whether another page is available.
   */
  hasNextPage?: boolean
}

/**
 * Playlist edge node payload.
 * @public
 */
export interface MixcloudPlaylistEdge {
  /**
   * Wrapped track node.
   */
  node?: {
    /**
     * Cloudcast entry.
     */
    cloudcast?: MixcloudTrackNode | null
  }
}

/**
 * Playlist paginated connection.
 * @public
 */
export interface MixcloudPlaylistItems {
  /**
   * Playlist entries.
   */
  edges?: MixcloudPlaylistEdge[]

  /**
   * Pagination metadata.
   */
  pageInfo?: MixcloudPageInfo
}

/**
 * Playlist lookup payload from Mixcloud GraphQL.
 * @public
 */
export interface MixcloudPlaylistLookup {
  /**
   * Playlist name.
   */
  name?: string

  /**
   * Playlist entries.
   */
  items?: MixcloudPlaylistItems
}

/**
 * GraphQL wrapper for playlist lookup.
 * @public
 */
export interface MixcloudPlaylistLookupResponse {
  /**
   * GraphQL response payload.
   */
  data?: {
    /**
     * Playlist node.
     */
    playlistLookup?: MixcloudPlaylistLookup | null
  }
}

/**
 * Supported user list categories in Mixcloud URLs.
 * @public
 */
export type MixcloudUserCollectionType =
  | 'uploads'
  | 'favorites'
  | 'listens'
  | 'stream'

/**
 * User collection edge node payload.
 * @public
 */
export interface MixcloudUserEdgeNode extends MixcloudTrackNode {}

/**
 * User collection paginated payload.
 * @public
 */
export interface MixcloudUserCollection {
  /**
   * Collection entries.
   */
  edges?: Array<{
    /**
     * Collection item node.
     */
    node?: MixcloudUserEdgeNode
  }>

  /**
   * Pagination metadata.
   */
  pageInfo?: MixcloudPageInfo
}

/**
 * User lookup payload from Mixcloud GraphQL.
 * @public
 */
export interface MixcloudUserLookup {
  /**
   * Display name of the profile.
   */
  displayName?: string

  /**
   * Uploaded cloudcasts.
   */
  uploads?: MixcloudUserCollection

  /**
   * Favorited cloudcasts.
   */
  favorites?: MixcloudUserCollection

  /**
   * Listened cloudcasts.
   */
  listens?: MixcloudUserCollection

  /**
   * Stream cloudcasts.
   */
  stream?: MixcloudUserCollection
}

/**
 * GraphQL wrapper for user lookup.
 * @public
 */
export interface MixcloudUserLookupResponse {
  /**
   * GraphQL response payload.
   */
  data?: {
    /**
     * User node.
     */
    userLookup?: MixcloudUserLookup | null
  }
}

/**
 * Plugin metadata attached to Mixcloud tracks.
 * @public
 */
export interface MixcloudPluginInfo {
  /**
   * Encrypted HLS URL payload.
   */
  encryptedHls?: string

  /**
   * Encrypted direct URL payload.
   */
  encryptedUrl?: string
}

/**
 * Track data object emitted by Mixcloud resolve/search handlers.
 * @public
 */
export interface MixcloudTrackData {
  /**
   * Encoded track payload.
   */
  encoded: string

  /**
   * Normalized track metadata.
   */
  info: TrackInfo

  /**
   * Mixcloud plugin metadata.
   */
  pluginInfo: MixcloudPluginInfo
}

/**
 * Additional stream options accepted by Mixcloud `loadStream`.
 * @public
 */
export interface MixcloudLoadStreamAdditionalData {
  /**
   * Start time in milliseconds for HLS playback.
   */
  startTime?: number
}

/**
 * Source-level options consumed by Mixcloud provider.
 * @public
 */
export interface MixcloudSourceOptions {
  /**
   * Maximum number of search results returned to callers.
   */
  maxSearchResults?: number

  /**
   * Maximum number of tracks collected for playlist/user resolutions.
   */
  maxAlbumPlaylistLength?: number
}

/**
 * Runtime NodeLink context required by Mixcloud provider.
 * @public
 */
export interface MixcloudNodeLinkContext extends WorkerNodeLink {
  /**
   * Runtime options used by the source.
   */
  options: WorkerNodeLink['options'] & MixcloudSourceOptions

  /**
   * Track cache manager used for URL caching.
   */
  trackCacheManager: TrackCacheManager
}

/**
 * Decoded track shape accepted by Mixcloud `getTrackUrl`.
 * @public
 */
export interface MixcloudDecodedTrack extends TrackInfo {
  /**
   * Optional plugin metadata attached to decoded track.
   */
  pluginInfo?: MixcloudPluginInfo
}

/**
 * Cached URL descriptor stored by the track cache manager.
 * @public
 */
export interface MixcloudCachedUrlResult extends TrackUrlResult {
  /**
   * Stream protocol hint.
   */
  protocol: 'hls' | 'https'

  /**
   * Stream format hint.
   */
  format: 'mpegts' | 'm4a'
}

/**
 * Error payload used by Mixcloud exceptions.
 * @public
 */
export interface MixcloudErrorPayload {
  /**
   * Error message text.
   */
  message: string

  /**
   * Error severity category.
   */
  severity: string
}

/**
 * Playlist data shape emitted by Mixcloud provider.
 * @public
 */
export interface MixcloudPlaylistData {
  /**
   * Playlist metadata block.
   */
  info: {
    /**
     * Playlist title.
     */
    name: string

    /**
     * Selected track index.
     */
    selectedTrack: number
  }

  /**
   * Playlist tracks.
   */
  tracks: MixcloudTrackData[]
}

/**
 * Unified resolve/search result used by Mixcloud provider.
 * @public
 */
export type MixcloudSourceResult =
  | { loadType: 'track'; data: MixcloudTrackData }
  | { loadType: 'search'; data: MixcloudTrackData[] }
  | { loadType: 'playlist'; data: MixcloudPlaylistData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: MixcloudErrorPayload }
  | SourceResult

/**
 * Stream loading result used by Mixcloud provider.
 * @public
 */
export type MixcloudLoadStreamResult =
  | TrackStreamResult
  | { exception: MixcloudErrorPayload }

/**
 * Regex groups extracted for track URLs.
 * @public
 */
export interface MixcloudTrackPatternGroups {
  /**
   * User slug.
   */
  user?: string

  /**
   * Cloudcast slug.
   */
  slug?: string
}

/**
 * Regex groups extracted for playlist URLs.
 * @public
 */
export interface MixcloudPlaylistPatternGroups {
  /**
   * User slug.
   */
  user?: string

  /**
   * Playlist slug.
   */
  playlist?: string
}

/**
 * Regex groups extracted for user list URLs.
 * @public
 */
export interface MixcloudUserPatternGroups {
  /**
   * User slug.
   */
  id?: string

  /**
   * List type.
   */
  type?: MixcloudUserCollectionType
}
