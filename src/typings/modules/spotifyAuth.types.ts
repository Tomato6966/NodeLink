/**
 * Encoded Spotify TOTP secret entry bundled as local fallback.
 * @public
 */
export interface EncodedSpotifySecretEntry {
  /**
   * Encoded secret string.
   */
  secret: string

  /**
   * TOTP version associated with the secret.
   */
  version: number
}

/**
 * Response payload for Spotify server time endpoint.
 * @public
 */
export interface SpotifyServerTimeResponse {
  /**
   * Server time in milliseconds.
   */
  serverTime?: number
}

/**
 * Response payload for Spotify token endpoint.
 * @public
 */
export interface SpotifyLocalTokenResponse {
  /**
   * Bearer access token.
   */
  accessToken?: string

  /**
   * Expiration timestamp in milliseconds.
   */
  accessTokenExpirationTimestampMs?: number

  /**
   * Additional fields returned by Spotify.
   */
  [key: string]: unknown
}
