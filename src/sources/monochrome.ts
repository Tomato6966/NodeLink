import type {
  InstanceHealth,
  MonochromeManifestResponse,
  MonochromeResponse,
  MonochromeSearchResults,
  MonochromeSourceConfig,
  MonochromeTrack,
  MonochromeVideo
} from '../typings/sources/monochrome.types.ts'
import type {
  SourceInstance,
  SourceResult,
  TrackData,
  TrackInfo,
  TrackUrlResult,
  WorkerNodeLink
} from '../typings/sources/source.types.ts'
import { encodeTrack, logger, makeRequest } from '../utils.ts'

/**
 * NodeLink audio source provider for Monochrome (Tidal proxy).
 *
 * This source implements a full-scale proxy engine ported from the Monochrome JS/TS reference.
 * Features include:
 * - Health-based instance rotation with exponential backoff.
 * - Robust pagination for Tidal collections (albums/playlists).
 * - Advanced manifest resolution with quality prioritization (FLAC > Lossless > AAC).
 * - Extraction of ReplayGain and Peak metadata for audio normalization.
 * - Integration with NodeLink's native track cache manager.
 *
 * @public
 */
class MonochromeSource implements SourceInstance {
  /** Master NodeLink instance reference. */
  public readonly nodelink: WorkerNodeLink
  /** Source configuration object. */
  public readonly config: MonochromeSourceConfig
  /** Registered search terms for identifier routing. */
  public readonly searchTerms = ['mcsearch']
  /** URL regex patterns this source can handle. */
  public readonly patterns: RegExp[]
  /** Source priority for URL matching. */
  public readonly priority = 100

  private apiInstances: InstanceHealth[] = []
  private streamingInstances: InstanceHealth[] = []

  /**
   * Initializes the Monochrome source with health-tracked instance pools.
   * @param nodelink - The worker server context.
   */
  constructor(nodelink: WorkerNodeLink) {
    this.nodelink = nodelink
    const sources = nodelink.options?.sources as
      | Record<string, { enabled?: boolean }>
      | undefined
    this.config =
      (sources?.monochrome as unknown as MonochromeSourceConfig) || {
        enabled: false
      }

    const defaultUrls = [
      'https://eu-central.monochrome.tf',
      'https://us-west.monochrome.tf',
      'https://arran.monochrome.tf',
      'https://api.monochrome.tf',
      'http://wolf.qqdl.site'
    ]

    const initPool = (urls: string[]) =>
      urls.map((url) => ({
        url: url.replace(/\/$/, ''),
        score: 100,
        lastFailure: 0,
        failures: 0,
        activeRequests: 0
      }))

    const instances = this.config.instances?.length
      ? this.config.instances
      : defaultUrls
    const streamingInstances = this.config.streamingInstances?.length
      ? this.config.streamingInstances
      : instances

    this.apiInstances = initPool(instances)
    this.streamingInstances = initPool(streamingInstances)

    this.patterns = [
      /^https?:\/\/monochrome\.tf\/(track|album|playlist|artist|video)\/[\w-]+/,
      /^https?:\/\/(?:www\.)?tidal\.com\/(?:browse\/)?(track|album|playlist|artist|video)\/[\w-]+/
    ]
  }

  /**
   * Performs provider-specific resource initialization.
   * @returns A promise resolving to true if initialized.
   */
  public async setup(): Promise<boolean> {
    const apiCount = this.apiInstances.length
    const streamCount = this.streamingInstances.length

    if (apiCount > 0) {
      logger(
        'info',
        'Monochrome',
        `Source is ready with ${apiCount} API and ${streamCount} streaming instances.`
      )
      return true
    }

    logger('warn', 'Monochrome', 'Source failed to initialize: No instances available.')
    return false
  }

  /**
   * Selects the healthiest instance from the pool using a scored random strategy.
   * @param type - Whether to pick an API or streaming instance.
   * @returns Health-tracked instance metadata.
   * @private
   */
  private getBestInstance(type: 'api' | 'streaming' = 'api'): InstanceHealth {
    const pool =
      type === 'streaming' ? this.streamingInstances : this.apiInstances
    const now = Date.now()

    const candidates = pool.filter(
      (i) => i.score > 0 || now - i.lastFailure > 30_000
    )
    const activePool = candidates.length > 0 ? candidates : pool

    const sorted = activePool.sort(
      (a, b) => b.score - a.score || a.activeRequests - b.activeRequests
    )

    const instance =
      sorted[Math.floor(Math.random() * Math.min(sorted.length, 3))] || pool[0]
    if (!instance) {
      throw new Error('No instances available in pool')
    }
    return instance
  }

  /**
   * Executes a request with automatic retries across the instance pool.
   * @param path - API path with parameters.
   * @param type - Instance pool to use.
   * @returns Parsed response or null after all retries fail.
   * @private
   */
  private async fetchWithRetry<T>(
    path: string,
    type: 'api' | 'streaming' = 'api'
  ): Promise<T | null> {
    const pool =
      type === 'streaming' ? this.streamingInstances : this.apiInstances
    const maxAttempts = Math.min(pool.length * 2, 5)
    let lastError: string | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const instance = this.getBestInstance(type)
      const url = `${instance.url}${path}`

      instance.activeRequests++
      try {
        const { body, error, statusCode } = await makeRequest(url, {})
        instance.activeRequests--

        if (statusCode === 200 && body) {
          instance.score = Math.min(instance.score + 5, 100)
          return body as T
        }

        if (statusCode === 429) {
          instance.score = Math.max(instance.score - 20, 0)
          await new Promise((r) => setTimeout(r, 500))
        } else if (statusCode === 401 || statusCode === 403) {
          instance.score = 0
        } else {
          instance.score = Math.max(instance.score - 10, 0)
        }

        instance.failures++
        instance.lastFailure = Date.now()
        lastError = error || `Status ${statusCode}`
      } catch (e) {
        instance.activeRequests--
        instance.score = Math.max(instance.score - 30, 0)
        instance.lastFailure = Date.now()
        lastError = e instanceof Error ? e.message : String(e)
      }
    }

    logger(
      'error',
      'Monochrome',
      `Exhausted all retries for ${path}. Last failure: ${lastError}`
    )
    return null
  }

  /**
   * Searches for tracks, videos or other types using Tidal's API proxy.
   * @param query - The user search query.
   * @param _sourceName - Ignored.
   * @param searchType - Type of result to prioritize.
   * @returns Search result payload.
   */
  public async search(
    query: string,
    _sourceName?: string,
    searchType = 'track'
  ): Promise<SourceResult> {
    logger('debug', 'Monochrome', `Searching for ${searchType}: "${query}"`)
    const cacheKey = `search:${searchType}:${query}`
    const cached = this.nodelink.trackCacheManager?.get<SourceResult>(
      'monochrome',
      cacheKey
    )
    if (cached) return cached

    let endpoint = '/search/'
    switch (searchType) {
      case 'album':
        endpoint += `?al=${encodeURIComponent(query)}`
        break
      case 'artist':
        endpoint += `?a=${encodeURIComponent(query)}`
        break
      case 'playlist':
        endpoint += `?p=${encodeURIComponent(query)}`
        break
      case 'video':
        endpoint += `?v=${encodeURIComponent(query)}`
        break
      default:
        endpoint += `?s=${encodeURIComponent(query)}`
        break
    }

    const response =
      await this.fetchWithRetry<MonochromeResponse<MonochromeSearchResults>>(
        endpoint
      )
    if (!response) return { loadType: 'empty', data: {} }

    const results: TrackData[] = []

    if (searchType === 'track' && response.data?.tracks?.items) {
      for (const t of response.data.tracks.items) {
        if (this.isTrackUnavailable(t)) continue
        const info = this.prepareTrackInfo(t)
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: {}
        })
      }
    } else if (searchType === 'video' && response.data?.videos?.items) {
      for (const v of response.data.videos.items) {
        const info = this.prepareVideoInfo(v)
        results.push({
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: {}
        })
      }
    }

    const finalResult: SourceResult =
      results.length > 0
        ? { loadType: 'search', data: results }
        : { loadType: 'empty', data: {} }

    logger('debug', 'Monochrome', `Search for "${query}" returned ${results.length} results.`)
    this.nodelink.trackCacheManager?.set(
      'monochrome',
      cacheKey,
      finalResult,
      1800_000
    )
    return finalResult
  }

  /**
   * Resolves a URL to a track, album or playlist with full pagination support.
   * @param url - The resource URL or ISRC identifier.
   * @returns Resolved data payload.
   */
  public async resolve(url: string): Promise<SourceResult> {
    // 1. Mirror Support (ISRC)
    if (url.startsWith('isrc:')) {
      const isrc = url.substring(5)
      const res = await this.fetchWithRetry<
        MonochromeResponse<MonochromeSearchResults>
      >(`/search/?s=${encodeURIComponent(isrc)}`)
      const best =
        res?.data?.tracks?.items?.find((t) => t.isrc === isrc) ||
        res?.data?.tracks?.items?.[0]
      if (!best || this.isTrackUnavailable(best))
        return { loadType: 'empty', data: {} }
      const info = this.prepareTrackInfo(best)
      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: {}
        }
      }
    }

    // 2. Direct Track/Video resolution
    const directMatch = url.match(/(track|video)\/(\d+)/)
    if (directMatch) {
      const type = directMatch[1] === 'video' ? 'video' : 'info'
      const res = await this.fetchWithRetry<
        MonochromeResponse<MonochromeTrack | MonochromeVideo>
      >(`/${type}/?id=${directMatch[2]}`)
      const data = res?.data
      if (!data) return { loadType: 'empty', data: {} }

      const info =
        directMatch[1] === 'video'
          ? this.prepareVideoInfo(data as MonochromeVideo)
          : this.prepareTrackInfo(data as MonochromeTrack)
      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack({ ...info, details: [] }),
          info,
          pluginInfo: {}
        }
      }
    }

    // 3. Collection resolution (Album/Playlist) with exaustive pagination
    const collectionMatch = url.match(/(album|playlist)\/([a-f0-9-]+|\d+)/)
    if (collectionMatch) {
      const type = collectionMatch[1] || ''
      const id = collectionMatch[2] || ''
      const tracks: TrackData[] = []
      let offset = 0
      const limit = 100
      let total = Infinity
      let name = 'Unknown Collection'

      while (
        tracks.length < total &&
        tracks.length <
          ((this.nodelink.options.maxAlbumPlaylistLength as number) || 1000)
      ) {
        const res = await this.fetchWithRetry<
          MonochromeResponse<{
            items: { item?: MonochromeTrack }[]
            title?: string
            numberOfTracks?: number
            playlist?: { title: string; numberOfTracks: number }
          }>
        >(`/${type}/?id=${id}&offset=${offset}&limit=${limit}`)
        if (!res) break

        const data = res.data
        if (offset === 0) {
          name = data.title || data.playlist?.title || 'Monochrome Collection'
          total = data.numberOfTracks || data.playlist?.numberOfTracks || 0
        }

        const items = data.items || []
        if (items.length === 0) break

        for (const entry of items) {
          const t = entry.item || (entry as unknown as MonochromeTrack)
          if (!t.id || this.isTrackUnavailable(t)) continue
          const info = this.prepareTrackInfo(t)
          tracks.push({
            encoded: encodeTrack({ ...info, details: [] }),
            info,
            pluginInfo: {}
          })
        }

        if (items.length < limit) break
        offset += items.length
      }

      return tracks.length > 0
        ? {
            loadType: 'playlist',
            data: { info: { name, selectedTrack: 0 }, pluginInfo: {}, tracks }
          }
        : { loadType: 'empty', data: {} }
    }

    return { loadType: 'empty', data: {} }
  }

  /**
   * Resolves the final manifest and streaming URI for a track.
   * Handles DASH manifest parsing and audio normalization extraction.
   * @param track - Normalized track metadata.
   * @returns Streaming result with URI and ReplayGain data.
   */
  public async getTrackUrl(track: TrackInfo): Promise<TrackUrlResult> {
    const isVideo = track.uri.includes('/video/')
    const formats = 'HEAACV1,AACLC,FLAC,FLAC_HIRES'
    const params = `adaptive=true&manifestType=MPEG_DASH&uriScheme=HTTPS&usage=PLAYBACK&formats=${formats}`
    const endpoint = isVideo
      ? `/video/?id=${track.identifier}&quality=HIGH`
      : `/trackManifests/?id=${track.identifier}&${params}`

    const response = await this.fetchWithRetry<MonochromeManifestResponse>(
      endpoint,
      'streaming'
    )
    if (!response)
      return {
        exception: {
          message: 'Failed to fetch playback manifest',
          severity: 'fault'
        }
      }

    const uri = this.extractStreamUrl(response)
    if (!uri)
      return {
        exception: {
          message: 'Failed to extract playable URI from manifest',
          severity: 'fault'
        }
      }

    const attr = response?.data?.data?.attributes
    if (attr?.trackAudioNormalizationData) {
      logger(
        'debug',
        'Monochrome',
        `Normalization for ${track.identifier}: Gain ${attr.trackAudioNormalizationData.replayGain} dB, Peak ${attr.trackAudioNormalizationData.peakAmplitude}`
      )
    }

    return { url: uri, protocol: uri.includes('.m3u8') ? 'hls' : 'http' }
  }

  /**
   * Implements the site's extractStreamUrlFromManifest logic.
   * @param data - Raw manifest response.
   * @returns Final stream URL or null.
   * @private
   */
  private extractStreamUrl(
    data: MonochromeManifestResponse | Record<string, unknown>
  ): string | null {
    let uri: string | null = null
    let manifest: string | null = null

    interface InternalAttr {
      uri?: string
      manifest?: string
    }

    interface InternalData {
      data?: {
        attributes?: InternalAttr
      }
      attributes?: InternalAttr
      manifest?: string
      Manifest?: string
      OriginalTrackUrl?: string
      originalTrackUrl?: string
    }

    if (
      'data' in data &&
      data.data &&
      typeof data.data === 'object' &&
      'data' in (data.data as Record<string, unknown>)
    ) {
      const internalData = data.data as InternalData
      const attr = internalData.data?.attributes || internalData.attributes
      uri = attr?.uri || null
      manifest = attr?.manifest || null
    } else {
      const internalData = data as InternalData
      uri = internalData.attributes?.uri || null
      manifest =
        internalData.manifest ||
        internalData.Manifest ||
        internalData.attributes?.manifest ||
        null
    }

    if (uri) return uri

    if (!manifest) {
      const internalData = data as InternalData
      return (
        internalData.OriginalTrackUrl || internalData.originalTrackUrl || null
      )
    }

    try {
      const decoded = Buffer.from(manifest, 'base64').toString()
      if (decoded.includes('<MPD'))
        return `data:application/dash+xml;base64,${manifest}`
      const parsed = JSON.parse(decoded)
      return (parsed.urls as string[])?.[0] || null
    } catch {
      return null
    }
  }

  /**
   * Normalizes a raw track object into NodeLink's TrackInfo structure.
   * @param t - Raw Tidal track data.
   * @returns Normalized metadata.
   * @private
   */
  private prepareTrackInfo(t: MonochromeTrack): TrackInfo {
    const coverPath = t.album?.cover?.replace(/-/g, '/')
    const title = t.version ? `${t.title} (${t.version})` : t.title

    return {
      identifier: t.id.toString(),
      isSeekable: true,
      author: t.artist?.name || 'Unknown Artist',
      length: t.duration * 1000,
      isStream: false,
      position: 0,
      title,
      uri: `https://monochrome.tf/track/${t.id}`,
      artworkUrl: coverPath
        ? `https://resources.tidal.com/images/${coverPath}/1280x1280.jpg`
        : null,
      isrc: t.isrc,
      sourceName: 'monochrome'
    }
  }

  /**
   * Normalizes a raw video object into NodeLink's TrackInfo structure.
   * @param v - Raw Tidal video data.
   * @returns Normalized metadata.
   * @private
   */
  private prepareVideoInfo(v: MonochromeVideo): TrackInfo {
    const imagePath = v.image?.replace(/-/g, '/')
    return {
      identifier: v.id.toString(),
      isSeekable: true,
      author: v.artist?.name || 'Unknown Artist',
      length: v.duration * 1000,
      isStream: false,
      position: 0,
      title: v.title,
      uri: `https://monochrome.tf/video/${v.id}`,
      artworkUrl: imagePath
        ? `https://resources.tidal.com/images/${imagePath}/1280x720.jpg`
        : null,
      isrc: null,
      sourceName: 'monochrome'
    }
  }

  /**
   * Checks if a track is unavailable for streaming based on site rules.
   * @param t - Raw track data.
   * @returns True if the track cannot be played.
   * @private
   */
  private isTrackUnavailable(t: MonochromeTrack): boolean {
    if (!t) return true
    return (
      t.allowStreaming === false ||
      t.streamReady === false ||
      t.title === 'Unavailable'
    )
  }
}

export default MonochromeSource
