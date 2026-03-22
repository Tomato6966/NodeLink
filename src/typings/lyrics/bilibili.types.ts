import type { TrackInfo } from '../sources/source.types.ts'
import type { LyricsLine } from './musixmatch.types.ts'

/**
 * WBI image key payload from Bilibili nav endpoint.
 * @public
 */
export interface BilibiliWbiImagePayload {
  /**
   * Main image URL used to derive WBI key.
   */
  img_url: string

  /**
   * Secondary image URL used to derive WBI key.
   */
  sub_url: string
}

/**
 * Minimal response shape for Bilibili nav endpoint.
 * @public
 */
export interface BilibiliNavResponse {
  /**
   * Data payload envelope.
   */
  data?: {
    /**
     * WBI image payload.
     */
    wbi_img?: BilibiliWbiImagePayload
  }
}

/**
 * Bilibili video info response shape.
 * @public
 */
export interface BilibiliVideoInfoResponse {
  /**
   * API status code (`0` means success).
   */
  code?: number

  /**
   * Video payload envelope.
   */
  data?: {
    /**
     * Numeric Bilibili AV identifier.
     */
    aid?: string | number

    /**
     * Content identifier.
     */
    cid?: string | number
  }
}

/**
 * Subtitle item returned by Bilibili WBI endpoint.
 * @public
 */
export interface BilibiliSubtitleItem {
  /**
   * Subtitle download URL.
   */
  subtitle_url?: string
}

/**
 * Bilibili WBI subtitle response shape.
 * @public
 */
export interface BilibiliWbiSubtitleResponse {
  /**
   * API status code (`0` means success).
   */
  code?: number

  /**
   * Subtitle payload envelope.
   */
  data?: {
    subtitle?: {
      subtitles?: BilibiliSubtitleItem[]
    }
  }
}

/**
 * Raw subtitle line payload from Bilibili subtitle endpoint.
 * @public
 */
export interface BilibiliRawSubtitleLine {
  /**
   * Line start time in seconds.
   */
  from: number

  /**
   * Line end time in seconds.
   */
  to: number

  /**
   * Line text.
   */
  content: string
}

/**
 * Bilibili subtitle file response payload.
 * @public
 */
export interface BilibiliSubtitleFileResponse {
  /**
   * Subtitle lines array.
   */
  body?: BilibiliRawSubtitleLine[]
}

/**
 * Plugin info payload accepted by Bilibili lyrics provider.
 * @public
 */
export interface BilibiliLyricsPluginInfo {
  /**
   * Numeric Bilibili AV identifier.
   */
  aid?: string | number

  /**
   * Content identifier.
   */
  cid?: string | number
}

/**
 * Track payload accepted by Bilibili lyrics provider.
 * @public
 */
export interface BilibiliLyricsTrackPayload {
  /**
   * Track info object.
   */
  info?: Pick<TrackInfo, 'identifier' | 'sourceName'>

  /**
   * Source plugin metadata.
   */
  pluginInfo?: BilibiliLyricsPluginInfo
}

/**
 * Minimal credential manager shape used by Bilibili lyrics provider.
 * @public
 */
export interface BilibiliLyricsCredentialManager {
  /**
   * Reads a credential value by key.
   */
  get: <T = unknown>(key: string) => T | null

  /**
   * Stores a credential value with TTL.
   */
  set: <T = unknown>(key: string, value: T, ttlMs?: number) => void
}

/**
 * Minimal NodeLink context shape used by Bilibili lyrics provider.
 * @public
 */
export interface NodelinkInstanceForBilibiliLyrics {
  /**
   * Credential manager accessor.
   */
  credentialManager: BilibiliLyricsCredentialManager
}

/**
 * Success payload returned by Bilibili lyrics provider.
 * @public
 */
export interface BilibiliLyricsData {
  /**
   * Source display name.
   */
  name: string

  /**
   * Bilibili CC subtitles are synchronized.
   */
  synced: true

  /**
   * Parsed subtitle lines.
   */
  lines: LyricsLine[]

  /**
   * Optional provider identifier injected by LyricsManager.
   */
  provider?: string
}

/**
 * Unified result returned by Bilibili lyrics provider.
 * @public
 */
export type BilibiliLyricsResult =
  | { loadType: 'lyrics'; data: BilibiliLyricsData }
  | { loadType: 'empty'; data: Record<string, never> }
  | { loadType: 'error'; data: { message: string; severity: string } }
