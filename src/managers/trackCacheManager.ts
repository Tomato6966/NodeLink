import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { TrackCacheEntry } from '../typings/trackCache.types.ts'
import { logger } from '../utils.js'

const TRACK_CACHE_SALT = 'nodelink-track-salt'
const DEFAULT_CACHE_FILE = './.cache/tracks.bin'
const DEFAULT_SAVE_DELAY_MS = 5000
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6

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
  private readonly key: Buffer
  private readonly filePath: string
  private cache: Map<string, TrackCacheEntry<unknown>>
  private saveTimeout: NodeJS.Timeout | null

  /**
   * Creates a new track cache manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: TrackCacheContext) {
    this.nodelink = nodelink
    const password = this._resolvePassword(nodelink.options)
    this.key = crypto.scryptSync(password, TRACK_CACHE_SALT, 32)
    this.filePath = DEFAULT_CACHE_FILE
    this.cache = new Map()
    this.saveTimeout = null
  }

  /**
   * Loads cached tracks from disk.
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filePath)
      if (data.length < 32) return

      const store = this._decodeStore(data)
      this.cache = new Map(Object.entries(store))

      const expiredCount = this._purgeExpired()
      if (expiredCount > 0) this.save()

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
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    })
    this.save()
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

  private _decodeStore(data: Buffer): Record<string, TrackCacheEntry<unknown>> {
    const iv = data.subarray(0, 16)
    const tag = data.subarray(16, 32)
    const encrypted = data.subarray(32)

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
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
