/**
 * Internal artwork structure for Audius resources.
 * @public
 */
export interface AudiusArtwork {
  /** 150x150 pixel variant URL. */
  '150x150'?: string
  /** 480x480 pixel variant URL. */
  '480x480'?: string
  /** 1000x1000 pixel variant URL. */
  '1000x1000'?: string
}

/**
 * Internal user structure for Audius resources.
 * @public
 */
export interface AudiusUser {
  /** Internal Audius identifier for the user. */
  id: string
  /** Display name of the user. */
  name: string
  /** Unique handle for the user. */
  handle: string
  /** Profile picture identifiers or URLs. */
  profile_picture?: AudiusArtwork
}

/**
 * Internal track structure returned by Audius discovery nodes.
 * @public
 */
export interface AudiusTrack {
  /** Internal Audius identifier for the track. */
  id: string
  /** Title of the track. */
  title: string
  /** Duration of the track in seconds. */
  duration: number
  /** Permalink slug used for URL generation. */
  permalink: string
  /** User object representing the track's creator. */
  user: AudiusUser
  /** Artwork object containing various resolution URLs. */
  artwork?: AudiusArtwork | string
}

/**
 * Internal playlist or album structure returned by Audius discovery nodes.
 * @public
 */
export interface AudiusPlaylist {
  /** Internal Audius identifier for the collection. */
  id: string
  /** Display name of the playlist or album. */
  playlist_name: string
  /** Whether the collection is an album. */
  is_album: boolean
  /** Permalink slug used for URL generation. */
  permalink: string
  /** User object representing the collection's creator. */
  user: AudiusUser
  /** Artwork object containing various resolution URLs. */
  artwork?: AudiusArtwork | string
}

/**
 * Generic data envelope for Audius API responses.
 * @public
 */
export interface AudiusApiResponse<T> {
  /** The payload data of the response. */
  data: T
}
