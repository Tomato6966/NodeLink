/**
 * Metadata for a Bilibili video page.
 * @public
 */
export interface BilibiliVideoPage {
  cid: number
  page: number
  from: string
  part: string
  duration: number
  vid: string
  weblink: string
  dimension: {
    width: number
    height: number
    rotate: number
  }
}

/**
 * Metadata for a Bilibili video.
 * @public
 */
export interface BilibiliVideoData {
  aid: number
  bvid: string
  cid: number
  title: string
  pubdate: number
  desc: string
  pic: string
  duration: number
  owner: {
    mid: number
    name: string
    face: string
  }
  pages?: BilibiliVideoPage[]
  [key: string]: unknown
}

/**
 * Metadata for a Bilibili bangumi episode.
 * @public
 */
export interface BilibiliBangumiEpisode {
  id: number
  aid: number
  bvid: string
  cid: number
  title: string
  long_title: string
  duration: number
  link: string
  cover: string
  [key: string]: unknown
}

/**
 * Metadata for a Bilibili bangumi season.
 * @public
 */
export interface BilibiliBangumiData {
  season_id: number
  season_title: string
  cover: string
  episodes: BilibiliBangumiEpisode[]
  [key: string]: unknown
}

/**
 * Metadata for a Bilibili audio track.
 * @public
 */
export interface BilibiliAudioData {
  id: number
  title: string
  cover: string
  duration: number
  uname: string
  [key: string]: unknown
}

/**
 * Generic API response from Bilibili.
 * @public
 */
export interface BilibiliApiResponse<T> {
  code: number
  message: string
  ttl?: number
  data?: T
  result?: T
  msg?: string
}

/**
 * WBI image metadata for signature generation.
 * @public
 */
export interface BilibiliWbiImg {
  img_url: string
  sub_url: string
}

/**
 * Playback URL information for Bilibili video.
 * @public
 */
export interface BilibiliPlayurlData {
  durl?: Array<{
    url: string
    size: number
    length: number
  }>
  dash?: {
    duration: number
    audio?: Array<{
      id: number
      base_url: string
      backup_url?: string[]
      bandwidth: number
    }>
    video?: Array<{
      id: number
      base_url: string
      backup_url?: string[]
      bandwidth: number
    }>
  }
}
