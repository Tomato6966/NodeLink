/**
 * Stored credential entry with TTL metadata.
 * @example
 * ```ts
 * const entry: CredentialEntry<string> = {
 *   value: 'token',
 *   createdAt: Date.now(),
 *   updatedAt: Date.now(),
 *   expiresAt: Date.now() + 60_000
 * }
 * ```
 * @public
 */
export interface CredentialEntry<T = unknown> {
  /**
   * Stored credential value.
   */
  value: T

  /**
   * Timestamp (ms) when the entry was first stored.
   */
  createdAt: number

  /**
   * Timestamp (ms) when the entry was last updated.
   */
  updatedAt: number

  /**
   * Expiration timestamp (ms), or null when the entry never expires.
   */
  expiresAt: number | null
}

/**
 * Serialized payload stored in the encrypted credentials file.
 * @public
 */
export interface CredentialStorePayload {
  /**
   * Payload version for forward compatibility.
   */
  version: number

  /**
   * Timestamp (ms) when the payload was written.
   */
  savedAt: number

  /**
   * Credential entries keyed by identifier.
   */
  entries: Record<string, CredentialEntry<unknown>>
}

/**
 * Runtime statistics about the credential manager state.
 * @public
 */
export interface CredentialManagerStats {
  /**
   * Total number of stored entries.
   */
  totalEntries: number

  /**
   * Number of entries currently expired.
   */
  expiredEntries: number

  /**
   * Timestamp (ms) when credentials were last loaded.
   */
  lastLoadedAt?: number

  /**
   * Timestamp (ms) when credentials were last saved.
   */
  lastSavedAt?: number
}
