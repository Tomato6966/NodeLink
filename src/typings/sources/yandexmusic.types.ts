/**
 * Metadata node for a Yandex Music track.
 * @public
 */
export interface YandexMusicTrackNode {
  id: number | string
  title: string
  durationMs: number
  available: boolean
  isrc?: string
  artists: Array<{
    id: number
    name: string
  }>
  albums: Array<{
    id: number
    title: string
  }>
  ogImage?: string
  coverUri?: string
  [key: string]: unknown
}

/**
 * Metadata node for a Yandex Music album.
 * @public
 */
export interface YandexMusicAlbumNode {
  id: number
  title: string
  available: boolean
  artists: Array<{
    id: number
    name: string
  }>
  volumes?: Array<YandexMusicTrackNode[]>
  [key: string]: unknown
}

/**
 * Metadata node for a Yandex Music artist.
 * @public
 */
export interface YandexMusicArtistNode {
  id: number
  name: string
  available: boolean
  [key: string]: unknown
}

/**
 * Metadata node for a Yandex Music playlist.
 * @public
 */
export interface YandexMusicPlaylistNode {
  owner: {
    login: string
    name: string
  }
  kind: number
  title: string
  tracks?: Array<{ track: YandexMusicTrackNode }>
  [key: string]: unknown
}

/**
 * Registry of discovery node response data.
 * @public
 */
export interface YandexMusicApiResponse<T> {
  result: T
}

/**
 * Search results from Yandex Music API.
 * @public
 */
export interface YandexMusicSearchResponse {
  tracks?: { results: YandexMusicTrackNode[] }
  albums?: { results: YandexMusicAlbumNode[] }
  artists?: { results: YandexMusicArtistNode[] }
  playlists?: { results: YandexMusicPlaylistNode[] }
}

/**
 * Similar tracks response from Yandex Music API.
 * @public
 */
export interface YandexMusicSimilarTracksResponse {
  similarTracks: YandexMusicTrackNode[]
}

/**
 * Download information for a track.
 * @public
 */
export interface YandexMusicDownloadInfo {
  codec: string
  bitrateInKbps: number
  downloadInfoUrl: string
}
