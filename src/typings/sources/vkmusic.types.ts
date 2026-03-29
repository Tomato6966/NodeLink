/**
 * Token response data from VK authentication.
 * @public
 */
export interface VKTokenData {
  access_token: string
  expires: number
  user_id: number
}

/**
 * Metadata node for a VK user.
 * @public
 */
export interface VKUserNode {
  id: number
  first_name: string
  last_name: string
  [key: string]: unknown
}

/**
 * Metadata node for a VK audio track.
 * @public
 */
export interface VKAudioNode {
  id: number
  owner_id: number
  artist: string
  title: string
  duration: number
  url?: string
  access_key?: string
  album?: {
    id: number
    thumb?: {
      photo_300?: string
      photo_600?: string
      photo_1200?: string
    }
    images?: Array<{
      url: string
      width: number
      height: number
    }>
  }
  external_ids?: {
    isrc?: string
  }
  [key: string]: unknown
}

/**
 * API response structure from VK.
 * @public
 */
export interface VKApiResponse<T> {
  response?: T
  error?: {
    error_code: number
    error_msg: string
    request_params: Array<{ key: string; value: string }>
  }
}

/**
 * Paged list of VK audio items.
 * @public
 */
export interface VKAudioList {
  count: number
  items: VKAudioNode[]
}
