import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { TrackCacheEntry } from '../typings/playback/trackCache.types.ts'
import { logger } from '../utils.ts'

const TRACK_CACHE_SALT = 'nodelink-track-salt'
const DEFAULT_CACHE_FILE = './.cache/tracks.bin'
const DEFAULT_SAVE_DELAY_MS = 5000
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000

type TrackCacheContext = {
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
 * Encrypted cache for resolved track metadata and URLs.
 * @remarks Uses AES-256-GCM and purges expired entries on load and access.
 * @example
 * ```ts
 * const cache = new TrackCacheManager(nodelink)
 * await cache.load()
 * cache.set('youtube', 'id', { url: '...' })
 * const cached = cache.get('youtube', 'id')
 * ```
 * @public
 */
export default class TrackCacheManager {
  private readonly nodelink: TrackCacheContext
  private readonly password: string
  private key: Buffer
  private legacyKey: Buffer | null
  private readonly filePath: string
  private readonly maxEntries: number
  private readonly cleanupIntervalMs: number
  private cache: Map<string, TrackCacheEntry<unknown>>
  private saveTimeout: NodeJS.Timeout | null
  private cleanupInterval: NodeJS.Timeout | null

  /**
   * Creates a new track cache manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: TrackCacheContext) {
    this.nodelink = nodelink
    this.password = this._resolvePassword(nodelink.options)
    this.key = this._deriveFastKey(this.password)
    this.legacyKey = null
    const cacheOptions = this._resolveCacheOptions(nodelink.options)
    this.filePath = DEFAULT_CACHE_FILE
    this.maxEntries = cacheOptions.maxEntries
    this.cleanupIntervalMs = cacheOptions.cleanupIntervalMs
    this.cache = new Map()
    this.saveTimeout = null
    this.cleanupInterval = setInterval(() => {
      const expiredCount = this._purgeExpired()
      const evictedCount = this._enforceMaxEntries()
      if (expiredCount > 0 || evictedCount > 0) this.save()
    }, this.cleanupIntervalMs)
    this.cleanupInterval.unref?.()
  }

  /**
   * Loads cached tracks from disk.
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath)
      if (data.length < 32) return

      let store: Record<string, TrackCacheEntry<unknown>>
      let migratedFromLegacy = false

      try {
        store = this._decodeStore(data, this.key)
      } catch {
        const legacyKey = this._getLegacyKey()
        store = this._decodeStore(data, legacyKey)
        migratedFromLegacy = true
      }

      this.cache = new Map(Object.entries(store))

      const expiredCount = this._purgeExpired()
      const evictedCount = this._enforceMaxEntries()
      if (expiredCount > 0 || evictedCount > 0 || migratedFromLegacy)
        this.save()

      logger(
        'debug',
        'TrackCache',
        `Loaded ${this.cache.size} cached tracks from disk.`
      )
    } catch (error) {
      const code = getErrorCode(error)
      if (code !== 'ENOENT') {
        logger(
          'error',
          'TrackCache',
          `Failed to load track cache: ${getErrorMessage(error)}`
        )
      }
      this.cache = new Map()
    }
  }

  /**
   * Debounces cache persistence.
   */
  save(): void {
    if (this.saveTimeout) return

    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null
      void this.forceSave()
    }, DEFAULT_SAVE_DELAY_MS)
  }

  /**
   * Forces the cache to be written to disk immediately.
   */
  async forceSave(): Promise<void> {
    try {
      const plainText = JSON.stringify(Object.fromEntries(this.cache))
      const iv = crypto.randomBytes(16)
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)

      const encrypted = Buffer.concat([
        cipher.update(plainText, 'utf8'),
        cipher.final()
      ])
      const tag = cipher.getAuthTag()

      await fs.mkdir('./.cache', { recursive: true })
      await fs.writeFile(this.filePath, Buffer.concat([iv, tag, encrypted]))
    } catch (error) {
      logger(
        'error',
        'TrackCache',
        `Failed to save track cache: ${getErrorMessage(error)}`
      )
    }
  }

  /**
   * Retrieves a cached value by source/identifier.
   * @param source - Source name (e.g., "youtube").
   * @param identifier - Track identifier.
   */
  get<T = unknown>(source: string, identifier: string): T | null {
    const key = `${source}:${identifier}`
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      this.save()
      return null
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value as T
  }

  /**
   * Stores a cached value with a TTL.
   * @param source - Source name (e.g., "youtube").
   * @param identifier - Track identifier.
   * @param value - Cached payload.
   * @param ttlMs - Time-to-live in milliseconds.
   */
  set<T = unknown>(
    source: string,
    identifier: string,
    value: T,
    ttlMs: number = DEFAULT_TTL_MS
  ): void {
    const key = `${source}:${identifier}`
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }
    this.cache.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null
    })
    this._enforceMaxEntries()
    this.save()
  }

  private _resolveCacheOptions(options: Record<string, unknown>): {
    maxEntries: number
    cleanupIntervalMs: number
  } {
    const directCandidate = (options as { trackCache?: unknown }).trackCache
    const rootCache = isRecord(directCandidate) ? directCandidate : null
    const nestedCandidate = (options as { cache?: unknown }).cache
    const nestedCache = isRecord(nestedCandidate)
      ? (nestedCandidate as { track?: unknown }).track
      : null
    const nestedTrackCache = isRecord(nestedCache) ? nestedCache : null
    const selected = rootCache ?? nestedTrackCache

    const maxEntriesRaw = selected?.maxEntries
    const cleanupIntervalRaw = selected?.cleanupIntervalMs

    const maxEntries =
      typeof maxEntriesRaw === 'number' && Number.isFinite(maxEntriesRaw)
        ? Math.max(100, Math.floor(maxEntriesRaw))
        : DEFAULT_MAX_ENTRIES
    const cleanupIntervalMs =
      typeof cleanupIntervalRaw === 'number' &&
      Number.isFinite(cleanupIntervalRaw)
        ? Math.max(1000, Math.floor(cleanupIntervalRaw))
        : DEFAULT_CLEANUP_INTERVAL_MS

    return { maxEntries, cleanupIntervalMs }
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
      throw new Error('TrackCacheManager requires options.server.password')
    }
    return password
  }

  private _deriveFastKey(password: string): Buffer {
    return crypto
      .createHash('sha256')
      .update(`${TRACK_CACHE_SALT}:${password}`)
      .digest()
  }

  private _getLegacyKey(): Buffer {
    if (!this.legacyKey) {
      this.legacyKey = crypto.scryptSync(this.password, TRACK_CACHE_SALT, 32)
    }

    return this.legacyKey
  }

  private _purgeExpired(): number {
    const now = Date.now()
    let expiredCount = 0
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key)
        expiredCount++
      }
    }
    return expiredCount
  }

  private _enforceMaxEntries(): number {
    if (this.cache.size <= this.maxEntries) return 0

    let removed = 0
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (!oldestKey) break
      this.cache.delete(oldestKey)
      removed++
    }
    return removed
  }

  private _decodeStore(
    data: Buffer,
    key: Buffer
  ): Record<string, TrackCacheEntry<unknown>> {
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
    return this._normalizeStore(parsed)
  }

  private _normalizeStore(
    raw: unknown
  ): Record<string, TrackCacheEntry<unknown>> {
    if (!isRecord(raw)) return {}

    const store: Record<string, TrackCacheEntry<unknown>> = {}
    for (const [key, value] of Object.entries(raw)) {
      store[key] = this._normalizeEntry(value)
    }
    return store
  }

  private _normalizeEntry(rawValue: unknown): TrackCacheEntry<unknown> {
    if (isRecord(rawValue)) {
      const entryCandidate = rawValue as Partial<TrackCacheEntry<unknown>> & {
        value?: unknown
      }
      const value = Object.hasOwn(entryCandidate, 'value')
        ? entryCandidate.value
        : rawValue
      const expiresAt =
        typeof entryCandidate.expiresAt === 'number'
          ? entryCandidate.expiresAt
          : null
      return {
        value,
        expiresAt
      }
    }

    return {
      value: rawValue,
      expiresAt: null
    }
  }
}
