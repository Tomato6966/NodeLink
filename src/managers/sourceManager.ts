import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrackInfoExtended } from '../typings/playback/player.types.ts'
import type {
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult
} from '../typings/sources/source.types.ts'
import { logger } from '../utils.ts'

/**
 * Represents a loaded source instance (e.g. YouTube, SoundCloud, HTTP).
 * Sources are plain JS classes with optional properties describing
 * their search terms, URL patterns, and priority.
 */
interface SourceInstance {
  /** Called once during initialization; returns true if ready. */
  setup: () => Promise<boolean>
  /** Search for tracks by query. */
  search?: (query: string, ...args: unknown[]) => Promise<unknown>
  /** Resolve a URL to track/playlist data. */
  resolve?: (url: string) => Promise<unknown>
  /** Get a playable URL for a track. */
  getTrackUrl?: (
    trackInfo: TrackInfo | TrackInfoExtended,
    ...args: unknown[]
  ) => Promise<TrackUrlResult & { protocol?: string; format?: unknown; additionalData?: Record<string, unknown> }>
  /** Fetch an audio stream for a track. */
  loadStream?: (
    track: TrackInfo | TrackInfoExtended,
    url: string,
    protocol?: string,
    additionalData?: Record<string, unknown>
  ) => Promise<TrackStreamResult & { type?: string; exception?: { message: string } }>
  /** Get chapters for a track (e.g. YouTube chapters). */
  getChapters?: (trackInfo: TrackInfo | TrackInfoExtended) => Promise<unknown>
  /** Additional source names that this source responds to. */
  additionalsSourceName?: string[]
  /** Search term prefixes (e.g. 'scsearch'). */
  searchTerms?: string[]
  /** Recommendation term prefixes. */
  recommendationTerm?: string[]
  /** URL regex patterns that this source handles. */
  patterns?: RegExp[]
  /** Priority for URL pattern matching (higher wins). */
  priority?: number
  /** Live chat accessor (YouTube). */
  liveChat?: {
    getLiveChat: (videoId: string) => Promise<unknown>
  }
  /** OAuth credentials (source-specific). */
  oauth?: {
    refreshToken?: string | null
    accessToken?: string | null
    tokenExpiry?: number
  }
  /** YouTube internal context. */
  ytContext?: { client?: { visitorData?: string } }
  /** Catch-all for source-specific fields. */
  [key: string]: unknown
}

/**
 * Entry in the pattern map used for URL-to-source routing.
 */
interface PatternEntry {
  /** Compiled regex pattern */
  regex: RegExp
  /** Source key to route to */
  sourceName: string
  /** Matching priority (higher wins) */
  priority: number
}

/**
 * Context object passed to the SourcesManager constructor.
 * Must expose the NodeLink options and a stats manager for instrumentation.
 */
interface SourcesManagerContext {
  options: Record<string, unknown> & {
    sources?: Record<
      string,
      { enabled?: boolean } | undefined
    >
    defaultSearchSource?: string | string[]
    unifiedSearchSources?: string[]
    maxSearchResults?: number
    maxAlbumPlaylistLength?: number
  }
  statsManager?: {
    incrementSourceSuccess?: (source: string) => void
    incrementSourceFailure?: (source: string) => void
  }
  credentialManager?: { get: <T = unknown>(key: string) => T | null }
  trackCacheManager?: {
    get: <T = unknown>(source: string, identifier: string) => T | null
    set: (source: string, identifier: string, value: unknown, ttlMs?: number) => void
  }
  routePlanner?: { getIP?: () => string | undefined }
  [key: string]: unknown
}

/**
 * Result returned by search / resolve calls.
 */
interface SourceResult {
  loadType?: string
  data?: unknown
  exception?: { message: string; severity?: string }
}

export default class SourcesManager {
  nodelink: SourcesManagerContext
  sources: Map<string, SourceInstance>
  sourceMap: Map<string, SourceInstance>
  searchAliasMap: Map<string, SourceInstance>
  patternMap: PatternEntry[]

  constructor(nodelink: SourcesManagerContext) {
    this.nodelink = nodelink
    this.sources = new Map()
    this.sourceMap = new Map()
    this.searchAliasMap = new Map()
    this.patternMap = []
  }

  async loadFolder(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const sourcesDir = path.join(__dirname, '../sources')

    this.sources.clear()
    this.sourceMap.clear()
    this.searchAliasMap.clear()
    this.patternMap = []

    const processSource = async (
      name: string,
      mod: Record<string, unknown>
    ): Promise<void> => {
      const isYouTube = name === 'youtube' || name.includes('YouTube.js')
      const sourceKey = isYouTube ? 'youtube' : name

      const enabled = isYouTube
        ? (
            this.nodelink.options.sources?.['youtube'] as
              | { enabled?: boolean }
              | undefined
          )?.enabled
        : !!this.nodelink.options.sources?.[sourceKey]?.enabled

      if (!enabled) return

      const Mod = (mod['default'] || mod) as new (
        ctx: SourcesManagerContext
      ) => SourceInstance
      const instance = new Mod(this.nodelink)

      if (await instance.setup()) {
        this.sources.set(sourceKey, instance)
        this.sourceMap.set(sourceKey, instance)

        if (Array.isArray(instance.additionalsSourceName)) {
          for (const addName of instance.additionalsSourceName) {
            this.sourceMap.set(addName, instance)
          }
        }

        if (Array.isArray(instance.searchTerms)) {
          for (const term of instance.searchTerms) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.recommendationTerm)) {
          for (const term of instance.recommendationTerm) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.patterns)) {
          for (const regex of instance.patterns) {
            if (regex instanceof RegExp) {
              this.patternMap.push({
                regex,
                sourceName: sourceKey,
                priority: instance.priority || 0
              })
            }
          }
        }
        logger('info', 'Sources', `Loaded source: ${sourceKey}`)
      }
    }

    try {
      await fs.access(sourcesDir)
      const files = await fs.readdir(sourcesDir, { recursive: true })
      const jsFiles = (files as string[]).filter(
        (f) => f.endsWith('.js') && !f.includes('clients/')
      )

      await Promise.all(
        jsFiles.map(async (file) => {
          const name = path.basename(file, '.js').toLowerCase()
          const filePath = path.join(sourcesDir, file)
          const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
          const mod = await import(fileUrl.href)
          await processSource(name, mod as Record<string, unknown>)
        })
      )
    } catch (e) {
      logger(
        'error',
        'Sources',
        `Error loading sources: ${(e as Error).message}`
      )
    }

    this.patternMap.sort(
      (a: PatternEntry, b: PatternEntry) => b.priority - a.priority
    )
  }

  async _instrumentedSourceCall(
    sourceName: string,
    method: string,
    ...args: unknown[]
  ): Promise<SourceResult> {
    const instance = this.sourceMap.get(sourceName)
    if (
      !instance ||
      typeof (instance as Record<string, unknown>)[method] !== 'function'
    ) {
      this.nodelink.statsManager?.incrementSourceFailure?.(
        sourceName || 'unknown'
      )
      throw new Error(
        `Source ${sourceName} not found or does not support ${method}`
      )
    }

    try {
      const fn = (instance as Record<string, (...a: unknown[]) => Promise<SourceResult>>)[method] as
        | ((...a: unknown[]) => Promise<SourceResult>)
        | undefined
      if (!fn) {
        throw new Error(`Method ${method} not found on source ${sourceName}`)
      }
      const result = await fn.call(instance, ...args)
      if (result.loadType === 'error') {
        this.nodelink.statsManager?.incrementSourceFailure?.(sourceName)
      } else {
        this.nodelink.statsManager?.incrementSourceSuccess?.(sourceName)
      }
      return result
    } catch (e) {
      this.nodelink.statsManager?.incrementSourceFailure?.(sourceName)
      throw e
    }
  }

  async search(sourceTerm: string, query: string): Promise<SourceResult> {
    let instance = this.searchAliasMap.get(sourceTerm)
    const sourceName = sourceTerm

    if (!instance) {
      instance = this.sourceMap.get(sourceTerm)
    }

    if (!instance) {
      throw new Error(`Source or search alias not found for: ${sourceTerm}`)
    }

    let searchType = 'track'
    let searchQuery = query

    if (query.includes(':')) {
      const parts = query.split(':')
      const possibleType = (parts[0] ?? '').toLowerCase()
      const types = ['playlist', 'artist', 'album', 'channel', 'track']

      if (types.includes(possibleType)) {
        searchType = possibleType
        searchQuery = parts.slice(1).join(':')
      }
    }

    const name = instance.constructor.name.replace('Source', '').toLowerCase()
    logger(
      'debug',
      'Sources',
      `Searching on ${name} (${searchType}) for: "${searchQuery}"`
    )
    return this._instrumentedSourceCall(
      name,
      'search',
      searchQuery,
      sourceName,
      searchType
    )
  }

  async searchWithDefault(query: string): Promise<SourceResult> {
    const defaultSources = Array.isArray(
      this.nodelink.options.defaultSearchSource
    )
      ? this.nodelink.options.defaultSearchSource
      : [this.nodelink.options.defaultSearchSource]

    for (const source of defaultSources) {
      try {
        const result = await this.search(source as string, query)
        if (
          result.loadType === 'search' &&
          Array.isArray(result.data) &&
          result.data.length > 0
        ) {
          return result
        }
      } catch (e) {
        logger(
          'warn',
          'Sources',
          `Default source search failed for ${source}: ${(e as Error).message}`
        )
      }
    }

    return { loadType: 'empty', data: {} }
  }

  async unifiedSearch(query: string): Promise<SourceResult> {
    const searchSources = (this.nodelink.options.unifiedSearchSources || [
      'youtube'
    ]) as string[]
    logger(
      'debug',
      'Sources',
      `Performing unified search for "${query}" on [${searchSources.join(', ')}]`
    )

    const searchPromises = searchSources.map((sourceName: string) =>
      this._instrumentedSourceCall(sourceName, 'search', query).catch((e) => {
        logger(
          'warn',
          'Sources',
          `A source (${sourceName}) failed during unified search: ${(e as Error).message}`
        )
        return { loadType: 'error', data: { message: (e as Error).message } }
      })
    )

    const results = await Promise.all(searchPromises)

    const allTracks: unknown[] = []
    results.forEach((result: SourceResult) => {
      if (result.loadType === 'search') {
        allTracks.push(...(result.data as unknown[]))
      }
    })

    if (allTracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: `Search results for: ${query}`,
          selectedTrack: -1
        },
        pluginInfo: {},
        tracks: allTracks
      }
    }
  }

  async resolve(url: string): Promise<SourceResult> {
    let sourceName: string | null = null

    for (const entry of this.patternMap) {
      if (entry.regex.test(url)) {
        sourceName = entry.sourceName
        break
      }
    }

    if (
      !sourceName &&
      (url.startsWith('https://') || url.startsWith('http://'))
    ) {
      sourceName = 'http'
    }

    if (!sourceName || !this.sourceMap.has(sourceName)) {
      logger('warn', 'Sources', `No source found for URL: ${url}`)
      return {
        loadType: 'error',
        data: {
          message: 'No source found for URL',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    logger('debug', 'Sources', `Resolving with ${sourceName} for: ${url}`)
    return this._instrumentedSourceCall(sourceName, 'resolve', url)
  }

  async reload(): Promise<void> {
    await this.loadFolder()
  }

  async getTrackUrl(
    track: TrackInfo | TrackInfoExtended,
    itag?: number,
    ...args: unknown[]
  ): Promise<TrackUrlResult & { protocol?: string; format?: unknown; additionalData?: Record<string, unknown> }> {
    const instance = this.sourceMap.get(track.sourceName)
    if (!instance?.getTrackUrl) {
      throw new Error(`Source ${track.sourceName} not found or does not support getTrackUrl`)
    }
    return await instance.getTrackUrl(track, itag, ...args)
  }

  async getTrackStream(
    track: TrackInfo | TrackInfoExtended,
    url: string,
    protocol: string,
    additionalData: Record<string, unknown>
  ): Promise<TrackStreamResult & { type?: string; exception?: { message: string } }> {
    const instance = this.sourceMap.get(track.sourceName)
    if (!instance?.loadStream) {
      throw new Error(`Source ${track.sourceName} not found or does not support loadStream`)
    }
    return await instance.loadStream(track, url, protocol, additionalData)
  }

  async getChapters(track: { info?: TrackInfo | TrackInfoExtended }): Promise<unknown> {
    const sourceName = track.info?.sourceName
    if (!sourceName) return []

    const instance = this.sourceMap.get(sourceName)
    if (!instance || typeof instance.getChapters !== 'function' || !track.info) {
      return []
    }
    return await instance.getChapters(track.info)
  }

  getAllSources(): SourceInstance[] {
    return Array.from(this.sources.values())
  }

  getSource(name: string): SourceInstance | undefined {
    return this.sourceMap.get(name)
  }

  getEnabledSourceNames(): string[] {
    const enabledNames: string[] = []
    const sources = this.nodelink.options.sources
    if (sources) {
      for (const sourceName in sources) {
        if (sources[sourceName]?.enabled) {
          enabledNames.push(sourceName)
        }
      }
    }
    return enabledNames
  }
}
