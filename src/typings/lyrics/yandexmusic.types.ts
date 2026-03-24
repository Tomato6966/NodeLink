import type { TrackInfo } from '../sources/source.types.ts'
import type { HttpRequestResult } from '../utils.types.ts'

/**
 * Signature payload used by Yandex lyrics API.
 * @public
 */
export interface YandexLyricsSignPayload {
  /**
   * URL-safe HMAC signature.
   */
  sign: string

  /**
   * Signature timestamp in seconds.
   */
  timestamp: number
}

/**
 * Minimal Yandex lyrics API response body.
 * @public
 */
export interface YandexLyricsApiResponse {
  /**
   * Error payload when request fails.
   */
  error?: unknown

  /**
   * Successful result payload.
   */
  result?: {
    /**
     * URL to download LRC text.
     */
    downloadUrl?: string
  }
}

/**
 * Minimal route planner runtime shape used by this provider.
 * @public
 */
export interface YandexLyricsRoutePlanner {
  /**
   * Returns next local IP address for outbound request binding.
   */
  getIP?: () => string | null | undefined
}

/**
 * Minimal credential manager shape used by this provider.
 * @public
 */
export interface YandexLyricsCredentialManager {
  /**
   * Reads a credential value by key.
   */
  get: <T = unknown>(key: string) => T | null
}

/**
 * Minimal NodeLink options shape used by Yandex lyrics provider.
 * @public
 */
export interface YandexLyricsOptions {
  /**
   * Lyrics configuration bucket.
   */
  lyrics?: {
    /**
     * Yandex Music lyrics configuration.
     */
    yandexmusic?: {
      /**
       * OAuth token for Yandex Music API.
       */
      accessToken?: string
    }
  }

  /**
   * Sources configuration bucket.
   */
  sources?: {
    /**
     * Yandex Music source configuration.
     */
    yandexmusic?: {
      /**
       * OAuth token for Yandex Music source.
       */
      accessToken?: string
    }
  }
}

/**
 * Minimal NodeLink context shape used by Yandex lyrics provider.
 * @public
 */
export interface NodelinkInstanceForYandexLyrics {
  /**
   * Runtime options.
   */
  options: YandexLyricsOptions

  /**
   * Credential manager accessor.
   */
  credentialManager: YandexLyricsCredentialManager

  /**
   * Optional route planner accessor.
   */
  routePlanner?: YandexLyricsRoutePlanner
}

/**
 * Track info accepted by Yandex lyrics provider.
 * @public
 */
export type YandexLyricsTrackInfo = Pick<TrackInfo, 'identifier' | 'title'>

/**
 * Minimal HTTP result used by yandex helper methods.
 * @public
 */
export type YandexHttpResult = HttpRequestResult & {
  body?: string | YandexLyricsApiResponse
}
