/**
 * GraphQL operation payload for Twitch.
 * @public
 */
export interface TwitchGraphQLOperation {
  operationName: string
  variables: Record<string, unknown>
  query?: string
  extensions?: {
    persistedQuery?: {
      version: number
      sha256Hash: string
    }
  }
  [key: string]: unknown
}

/**
 * Access token structure for Twitch playback.
 * @public
 */
export interface TwitchPlaybackAccessToken {
  value: string
  signature: string
}

/**
 * Metadata node for a Twitch clip.
 * @public
 */
export interface TwitchClipNode {
  id: string
  slug: string
  title: string
  broadcaster: {
    id: string
    displayName: string
    login: string
  }
  videoQualities: Array<{
    quality: string
    sourceURL: string
  }>
  thumbnailURL: string
  durationSeconds: number
  playbackAccessToken?: TwitchPlaybackAccessToken
}

/**
 * Metadata node for a Twitch VOD.
 * @public
 */
export interface TwitchVodNode {
  id: string
  title: string
  owner: {
    id: string
    displayName: string
    login: string
  }
  previewThumbnailURL: string
  lengthSeconds: number
}

/**
 * Stream information for a Twitch channel.
 * @public
 */
export interface TwitchStreamNode {
  id: string
  type: 'live' | 'vodcast' | string
  viewersCount: number
  createdAt: string
}

/**
 * Registry of GQL responses for Twitch operations.
 * @public
 */
export interface TwitchGraphQLResponse {
  data?: {
    clip?: TwitchClipNode
    video?: TwitchVodNode
    user?: {
      stream?: TwitchStreamNode
      lastBroadcast: {
        title: string
      }
    }
    streamPlaybackAccessToken?: TwitchPlaybackAccessToken
    videoPlaybackAccessToken?: TwitchPlaybackAccessToken
  }
}
