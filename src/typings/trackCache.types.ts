/**
 * Track cache entry stored on disk.
 * @example
 * ```ts
 * const entry: TrackCacheEntry<string> = {
 *   value: 'https://cdn.example.com/track.mp3',
 *   expiresAt: Date.now() + 60_000
 * }
 * ```
 * @public
 */
export interface TrackCacheEntry<T = unknown> {
  /**
   * Cached value for a given source/identifier.
   */
  value: T

  /**
   * Expiration timestamp in milliseconds, or null if not set.
   */
  expiresAt: number | null
}
