import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type {
  CredentialEntry,
  CredentialManagerStats,
  CredentialStorePayload
} from '../typings/modules/credential.types.ts'
import { logger } from '../utils.ts'

const CREDENTIALS_SALT = 'nodelink-salt'
const CREDENTIALS_VERSION = 1
const DEFAULT_SAVE_DELAY_MS = 1000
const DEFAULT_CREDENTIALS_PATH = './.cache/credentials.bin'
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

type CredentialManagerContext = {
  options: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error')

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Encrypted credential store with TTL support and debounced persistence.
 * @remarks
 * Credentials are stored in AES-256-GCM format and persisted atomically to disk.
 * @example
 * ```ts
 * const credentials = new CredentialManager(nodelink)
 * await credentials.load()
 * credentials.set('spotify_token', 'abc', 60_000)
 * const token = credentials.get<string>('spotify_token')
 * ```
 * @public
 */
export default class CredentialManager {
  private readonly nodelink: CredentialManagerContext
  private readonly password: string
  private key: Buffer
  private legacyKey: Buffer | null
  private readonly filePath: string
  private readonly tempFilePath: string
  private readonly saveDelayMs: number
  private credentials: Map<string, CredentialEntry<unknown>>
  private saveTimeout: NodeJS.Timeout | null
  private cleanupInterval: NodeJS.Timeout | null
  private savePromise: Promise<void> | null
  private saveQueued: boolean
  private lastLoadedAt: number | null
  private lastSavedAt: number | null

  /**
   * Creates a new credential manager instance.
   * @param nodelink - NodeLink runtime used to derive the encryption key.
   */
  constructor(nodelink: CredentialManagerContext) {
    this.nodelink = nodelink
    this.password = this._resolvePassword(nodelink.options)
    this.key = this._deriveFastKey(this.password)
    this.legacyKey = null
    this.filePath = DEFAULT_CREDENTIALS_PATH
    this.tempFilePath = `${DEFAULT_CREDENTIALS_PATH}.tmp`
    this.saveDelayMs = DEFAULT_SAVE_DELAY_MS
    this.credentials = new Map()
    this.saveTimeout = null
    this.cleanupInterval = setInterval(() => {
      const expiredCount = this._purgeExpired()
      if (expiredCount > 0) this.save()
    }, DEFAULT_CLEANUP_INTERVAL_MS)
    this.cleanupInterval.unref?.()
    this.savePromise = null
    this.saveQueued = false
    this.lastLoadedAt = null
    this.lastSavedAt = null
  }

  /**
   * Loads and decrypts credential data from disk.
   * @remarks Purges expired entries and persists if cleanup occurs.
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath)
      if (data.length < 32) return

      let payload: CredentialStorePayload
      let migratedFromLegacy = false

      try {
        payload = this._decodePayload(data, this.key)
      } catch {
        const legacyKey = this._getLegacyKey()
        payload = this._decodePayload(data, legacyKey)
        migratedFromLegacy = true
      }

      this.credentials = new Map(Object.entries(payload.entries))
      const expiredCount = this._purgeExpired()
      if (expiredCount > 0 || migratedFromLegacy) this.save()

      this.lastLoadedAt = Date.now()
      logger(
        'debug',
        'Credentials',
        `Loaded ${this.credentials.size} encrypted credentials from disk.`
      )
    } catch (error) {
      const code = getErrorCode(error)
      if (code !== 'ENOENT') {
        logger(
          'error',
          'Credentials',
          `Failed to decrypt credentials: ${getErrorMessage(error)}`
        )
      }
      this.credentials = new Map()
    }
  }

  /**
   * Debounces credential persistence to disk.
   */
  save(): void {
    if (this.saveTimeout) return

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null
      void this.forceSave()
    }, this.saveDelayMs)
  }

  /**
   * Forces credentials to be written immediately.
   */
  async forceSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }

    try {
      this._purgeExpired()
      await this._flushSaveQueue()
      logger('debug', 'Credentials', 'Force saved credentials to disk.')
    } catch (error) {
      logger(
        'error',
        'Credentials',
        `Failed to force save credentials: ${getErrorMessage(error)}`
      )
    }
  }

  /**
   * Retrieves a credential value by key.
   * @param key - Credential identifier.
   * @returns The stored value or null when missing/expired.
   */
  get<T = unknown>(key: string): T | null {
    const entry = this._getValidEntry(key)
    return entry ? (entry.value as T) : null
  }

  /**
   * Retrieves the full credential entry with metadata.
   * @param key - Credential identifier.
   * @returns The entry or null when missing/expired.
   */
  getEntry<T = unknown>(key: string): CredentialEntry<T> | null {
    const entry = this._getValidEntry(key)
    if (!entry) return null
    return {
      ...(entry as CredentialEntry<T>)
    }
  }

  /**
   * Stores a credential value with an optional TTL.
   * @param key - Credential identifier.
   * @param value - Value to persist.
   * @param ttlMs - Time-to-live in milliseconds (0 = no expiry).
   */
  set<T = unknown>(key: string, value: T, ttlMs = 0): void {
    const now = Date.now()
    const current = this.credentials.get(key)
    const expiresAt = ttlMs > 0 ? now + ttlMs : null
    this.credentials.set(key, {
      value,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      expiresAt
    })
    this.save()
  }

  /**
   * Removes a credential entry.
   * @param key - Credential identifier.
   * @returns True if an entry was removed.
   */
  delete(key: string): boolean {
    const existed = this.credentials.delete(key)
    if (existed) this.save()
    return existed
  }

  /**
   * Checks whether a credential entry exists and is not expired.
   * @param key - Credential identifier.
   */
  has(key: string): boolean {
    return this._getValidEntry(key) !== null
  }

  /**
   * Clears all stored credentials.
   */
  clear(): void {
    if (this.credentials.size === 0) return
    this.credentials.clear()
    this.save()
  }

  /**
   * Returns runtime statistics for credential storage.
   */
  getStats(): CredentialManagerStats {
    const now = Date.now()
    const expiredEntries = this._countExpired(now)
    return {
      totalEntries: this.credentials.size,
      expiredEntries,
      lastLoadedAt: this.lastLoadedAt ?? undefined,
      lastSavedAt: this.lastSavedAt ?? undefined
    }
  }

  private _resolvePassword(options: Record<string, unknown>): string {
    const optionsCandidate = options as { server?: unknown }
    const serverCandidate = optionsCandidate.server
    const server = isRecord(serverCandidate)
      ? (serverCandidate as { password?: unknown })
      : null
    const password =
      server && typeof server.password === 'string' ? server.password : null
    if (!password) {
      throw new Error('CredentialManager requires options.server.password')
    }
    return password
  }

  private _deriveFastKey(password: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`${CREDENTIALS_SALT}:${password}`)
      .digest()
  }

  private _getLegacyKey(): Buffer {
    if (!this.legacyKey) {
      this.legacyKey = crypto.scryptSync(this.password, CREDENTIALS_SALT, 32)
    }

    return this.legacyKey
  }

  private _getValidEntry(key: string): CredentialEntry<unknown> | null {
    const entry = this.credentials.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.credentials.delete(key)
      this.save()
      return null
    }
    return entry
  }

  private _purgeExpired(): number {
    const now = Date.now()
    let expiredCount = 0
    for (const [key, entry] of this.credentials.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.credentials.delete(key)
        expiredCount++
      }
    }
    return expiredCount
  }

  private _countExpired(now: number): number {
    let expiredCount = 0
    for (const entry of this.credentials.values()) {
      if (entry.expiresAt && now > entry.expiresAt) expiredCount++
    }
    return expiredCount
  }

  private _decodePayload(data: Buffer, key: Buffer): CredentialStorePayload {
    const iv = data.subarray(0, 16)
    const tag = data.subarray(16, 32)
    const encrypted = data.subarray(32)

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8')
    const parsed = JSON.parse(decrypted) as unknown
    return this._normalizePayload(parsed)
  }

  private _normalizePayload(raw: unknown): CredentialStorePayload {
    const now = Date.now()
    if (isRecord(raw)) {
      const payloadCandidate = raw as Partial<CredentialStorePayload> & {
        entries?: unknown
        savedAt?: unknown
      }
      const entriesValue = payloadCandidate.entries
      if (isRecord(entriesValue)) {
        const entries = this._normalizeEntries(entriesValue, now)
        const savedAt =
          typeof payloadCandidate.savedAt === 'number'
            ? payloadCandidate.savedAt
            : now
        return {
          version: CREDENTIALS_VERSION,
          savedAt,
          entries
        }
      }

      return {
        version: CREDENTIALS_VERSION,
        savedAt: now,
        entries: this._normalizeEntries(raw, now)
      }
    }

    return {
      version: CREDENTIALS_VERSION,
      savedAt: now,
      entries: {}
    }
  }

  private _normalizeEntries(
    rawEntries: Record<string, unknown>,
    fallbackTime: number
  ): Record<string, CredentialEntry<unknown>> {
    const entries: Record<string, CredentialEntry<unknown>> = {}

    for (const [key, value] of Object.entries(rawEntries)) {
      entries[key] = this._normalizeEntry(value, fallbackTime)
    }

    return entries
  }

  private _normalizeEntry(
    rawValue: unknown,
    fallbackTime: number
  ): CredentialEntry<unknown> {
    if (isRecord(rawValue)) {
      const entryCandidate = rawValue as Partial<CredentialEntry<unknown>> & {
        value?: unknown
      }
      const value = Object.hasOwn(entryCandidate, 'value')
        ? entryCandidate.value
        : rawValue
      const createdAt =
        typeof entryCandidate.createdAt === 'number'
          ? entryCandidate.createdAt
          : fallbackTime
      const updatedAt =
        typeof entryCandidate.updatedAt === 'number'
          ? entryCandidate.updatedAt
          : createdAt
      const expiresAt =
        typeof entryCandidate.expiresAt === 'number' &&
        entryCandidate.expiresAt > 0
          ? entryCandidate.expiresAt
          : null

      return {
        value,
        createdAt,
        updatedAt,
        expiresAt
      }
    }

    return {
      value: rawValue,
      createdAt: fallbackTime,
      updatedAt: fallbackTime,
      expiresAt: null
    }
  }

  private _buildPayload(): CredentialStorePayload {
    return {
      version: CREDENTIALS_VERSION,
      savedAt: Date.now(),
      entries: Object.fromEntries(this.credentials)
    }
  }

  private async _flushSaveQueue(): Promise<void> {
    if (this.savePromise) {
      this.saveQueued = true
      await this.savePromise
      if (this.saveQueued) {
        this.saveQueued = false
        await this._flushSaveQueue()
      }
      return
    }

    const payload = this._buildPayload()
    this.savePromise = this._writeToDisk(payload)
    try {
      await this.savePromise
    } finally {
      this.savePromise = null
    }

    if (this.saveQueued) {
      this.saveQueued = false
      await this._flushSaveQueue()
    }
  }

  private async _writeToDisk(payload: CredentialStorePayload): Promise<void> {
    const plainText = JSON.stringify(payload)
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)

    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final()
    ])
    const tag = cipher.getAuthTag()
    const outBuffer = Buffer.concat([iv, tag, encrypted])

    await fs.mkdir('./.cache', { recursive: true })
    try {
      await fs.writeFile(this.tempFilePath, outBuffer)
      await fs.rename(this.tempFilePath, this.filePath)
    } catch (error) {
      logger(
        'debug',
        'Credentials',
        `Atomic save failed, falling back to direct write: ${getErrorMessage(error)}`
      )
      await fs.writeFile(this.filePath, outBuffer)
      try {
        await fs.unlink(this.tempFilePath)
      } catch (cleanupError) {
        logger(
          'debug',
          'Credentials',
          `Failed to remove temp credentials file: ${getErrorMessage(cleanupError)}`
        )
      }
    }

    this.lastSavedAt = payload.savedAt
  }
}
