import { PassThrough, pipeline } from 'node:stream'

import {
  encodeTrack,
  http1makeRequest,
  loadHLS,
  logger,
  makeRequest
} from '../utils.js'

const BASE_URL = 'https://api-v2.soundcloud.com'
const SOUNDCLOUD_URL = 'https://soundcloud.com'
const ASSET_PATTERN = /https:\/\/a-v2\.sndcdn\.com\/assets\/[a-zA-Z0-9-]+\.js/g
const CLIENT_ID_PATTERN = /client_id=([a-zA-Z0-9]{32})/
const TRACK_PATTERN = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/\s]+\/(?:sets\/)?[^/\s]+$/
const BATCH_SIZE = 50
const DEFAULT_PRIORITY = 85

export default class SoundCloudSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.baseUrl = BASE_URL
    this.searchTerms = ['scsearch']
    this.patterns = [TRACK_PATTERN]
    this.priority = DEFAULT_PRIORITY
    this.clientId = nodelink.options?.sources?.clientId ?? null
  }

  async setup() {
    try {
      const mainPage = await makeRequest(SOUNDCLOUD_URL, { method: 'GET' })

      if (!mainPage || mainPage.error) {
        this._logError('Failed to load SoundCloud main page', mainPage?.error)

        return false
      }

      const assetMatches = [...mainPage.body.matchAll(ASSET_PATTERN)]

      if (assetMatches.length === 0) {
        logger('warn', 'Sources', 'SoundCloud asset URL not found')

        return false
      }

      try {
        const clientId = await Promise.any(
          assetMatches.map(async (match) => {
            const assetUrl = match[0]
            const asset = await http1makeRequest(assetUrl)

            if (asset && !asset.error) {
              const idMatch = asset.body.match(CLIENT_ID_PATTERN)
              if (idMatch?.[1]) {
                return idMatch[1]
              }
            }
            throw new Error('No client_id found in asset')
          })
        )

        this.clientId = clientId
        logger('info', 'Sources', `Loaded SoundCloud (clientId: ${this.clientId})`)

        return true
      } catch {
        logger('warn', 'Sources', 'client_id not found in any assets')

        return false
      }
    } catch (err) {
      this._logError('Setup failed', err)

      return false
    }
  }

  match(url) {
    return this.patterns.some((p) => p.test(url))
  }

  async search(query) {
    if (!this._isValidString(query)) {
      return this._buildError('Invalid query')
    }

    try {
      const params = new URLSearchParams({
        q: query,
        client_id: this.clientId,
        limit: String(this.nodelink.options.maxSearchResults),
        offset: '0',
        linked_partitioning: '1',
        facet: 'model'
      })

      const req = await http1makeRequest(`${BASE_URL}/search?${params}`)

      if (req.error || req.statusCode !== 200) {
        return this._buildError(req.error?.message ?? `Status: ${req.statusCode}`)
      }

      if (!req.body?.total_results && !req.body?.collection?.length) {
        logger('debug', 'Sources', `No results for '${query}'`)

        return { loadType: 'empty', data: {} }
      }

      const tracks = this._processTracks(req.body.collection)
      logger('debug', 'Sources', `Found ${tracks.length} tracks for '${query}'`)

      return { loadType: 'search', data: tracks }
    } catch (err) {
      this._logError('Search failed', err)

      return this._buildError(err.message)
    }
  }

  async resolve(url) {
    if (!this._isValidString(url)) {
      return this._buildError('Invalid URL')
    }

    try {
      const reqUrl = `${BASE_URL}/resolve?${new URLSearchParams({ url, client_id: this.clientId })}`
      const req = await http1makeRequest(reqUrl)

      if (req.statusCode === 404) return { loadType: 'empty', data: {} }

      if (req.error || req.statusCode !== 200) {
        return this._buildError(req.error?.message ?? `Status: ${req.statusCode}`)
      }

      const { body } = req

      if (!body?.kind) return this._buildError('Invalid response')

      if (body.kind === 'track') {
        return { loadType: 'track', data: this._buildTrack(body) }
      }

      if (body.kind === 'playlist') {
        return await this._resolvePlaylist(body)
      }

      return { loadType: 'empty', data: {} }
    } catch (err) {
      this._logError('Resolve failed', err)

      return this._buildError(err.message)
    }
  }

  async _resolvePlaylist(body) {
    const complete = []
    const ids = []

    for (const t of body.tracks ?? []) {
      if (t?.title && t?.user) {
        complete.push(t)
      } else if (t?.id) {
        ids.push(t.id)
      }
    }

    const limit = this.nodelink.options.maxAlbumPlaylistLength
    const neededIds = ids.slice(0, Math.max(0, limit - complete.length))

    if (neededIds.length > 0) {
      const chunks = []

      for (let i = 0; i < neededIds.length; i += BATCH_SIZE) {
        chunks.push(neededIds.slice(i, i + BATCH_SIZE))
      }

      const promises = chunks.map((chunk) => {
        const batchUrl = `${BASE_URL}/tracks?${new URLSearchParams({
          ids: chunk.join(','),
          client_id: this.clientId
        })}`

        return http1makeRequest(batchUrl, { method: 'GET' })
          .then((res) => (Array.isArray(res.body) ? res.body : []))
          .catch((err) => {
            this._logError('Batch fetch failed', err)

            return []
          })
      })

      const results = await Promise.all(promises)
      results.forEach((batch) => complete.push(...batch))
    }

    const tracks = complete
      .slice(0, limit)
      .filter((t) => t.title)
      .map((t) => this._buildTrack(t))

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: body.title || 'Untitled playlist',
          selectedTrack: 0
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  _processTracks(collection) {
    const max = this.nodelink.options.maxSearchResults
    const tracks = []

    if (!Array.isArray(collection)) return []

    for (let i = 0; i < collection.length && tracks.length < max; i++) {
      if (collection[i]?.kind === 'track') {
        tracks.push(this._buildTrack(collection[i]))
      }
    }

    return tracks
  }

  _buildTrack(item) {
    const info = {
      title: item.title ?? 'Unknown',
      author: item.user?.username ?? 'Unknown',
      length: item.duration ?? 0,
      identifier: String(item.id ?? ''),
      isSeekable: true,
      isStream: false,
      uri: item.permalink_url ?? '',
      artworkUrl: item.artwork_url ?? null,
      isrc: item.publisher_metadata?.isrc ?? null,
      sourceName: 'soundcloud',
      position: 0
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {}
    }
  }

  async getTrackUrl(info) {
    if (!info?.identifier) {
      return this._buildException('Invalid track info')
    }

    try {
      const trackUrl = `https://api.soundcloud.com/tracks/${info.identifier}`
      const reqUrl = `${BASE_URL}/resolve?${new URLSearchParams({ url: trackUrl, client_id: this.clientId })}`
      const req = await http1makeRequest(reqUrl)

      if (req.error || req.statusCode !== 200) {
        this._logError('getTrackUrl failed', req.error)

        return this._buildException(req.error?.message ?? `Status: ${req.statusCode}`)
      }

      if (req.body?.errors?.[0]) {
        const msg = req.body.errors[0].error_message
        this._logError('API error', new Error(msg))

        return this._buildException(msg)
      }

      return await this._selectTranscoding(req.body)
    } catch (err) {
      this._logError('getTrackUrl exception', err)

      return this._buildException(err.message)
    }
  }

  async _selectTranscoding(body) {
    const transcodings = body.media?.transcodings ?? []

    if (!transcodings.length && (body.hls_aac_160_url || body.hls_aac_96_url)) {
      if (body.hls_aac_160_url) {
        transcodings.push({
          format: { protocol: 'hls', mime_type: 'audio/aac' },
          url: body.hls_aac_160_url,
          quality: 'high'
        })
      }

      if (body.hls_aac_96_url) {
        transcodings.push({
          format: { protocol: 'hls', mime_type: 'audio/aac' },
          url: body.hls_aac_96_url,
          quality: 'low'
        })
      }
    }

    if (transcodings.length === 0) {
      return this._buildException('No transcodings available')
    }

    const progressiveMp3 = transcodings.find(
      (t) =>
        t.format?.protocol === 'progressive' &&
        t.format?.mime_type?.includes('mpeg')
    )

    const progressiveAac = transcodings.find(
      (t) =>
        t.format?.protocol === 'progressive' &&
        t.format?.mime_type?.includes('aac')
    )

    const hlsAacHigh = transcodings.find(
      (t) =>
        t.format?.protocol === 'hls' &&
        (t.format?.mime_type?.includes('aac') || t.format?.mime_type?.includes('mp4')) &&
        (t.quality === 'hq' || t.preset?.includes('160') || t.url.includes('160'))
    )

    const hlsAacStandard = transcodings.find(
      (t) =>
        t.format?.protocol === 'hls' &&
        (t.format?.mime_type?.includes('aac') || t.format?.mime_type?.includes('mp4'))
    )

    const anyHls = transcodings.find((t) => t.format?.protocol === 'hls')
    const anyProgressive = transcodings.find(
      (t) => t.format?.protocol === 'progressive'
    )

    const selected =
      progressiveMp3 ||
      progressiveAac ||
      hlsAacHigh ||
      hlsAacStandard ||
      anyProgressive ||
      anyHls ||
      transcodings[0]

    if (selected.format?.mime_type?.includes('opus')) {
      logger(
        'warn',
        'Sources',
        `Using Opus codec which may cause decoder issues (track: ${body.id})`
      )
    }

    const streamAuthUrl = `${selected.url}?client_id=${this.clientId}`
    const urlReq = await http1makeRequest(streamAuthUrl, { method: 'GET' })
    let finalUrl = null

    if (urlReq.url && urlReq.url !== streamAuthUrl) {
      finalUrl = urlReq.url
    } else if (urlReq.statusCode === 302 || urlReq.statusCode === 301) {
      finalUrl = urlReq.headers?.location
    } else if (urlReq.body && typeof urlReq.body === 'object' && urlReq.body.url) {
      finalUrl = urlReq.body.url
    } else if (urlReq.statusCode === 200) {
      finalUrl = streamAuthUrl
    }

    if (!finalUrl) {
      return this._buildException('Failed to resolve stream URL')
    }

    const mimeType = selected.format?.mime_type?.toLowerCase() ?? ''
    const protocol = selected.format?.protocol ?? 'progressive'
    let format = 'arbitrary'

    if (mimeType.includes('mpeg')) {
      format = 'mp3'
    } else if (mimeType.includes('aac') || mimeType.includes('mp4')) {
      if (protocol === 'hls') {
        format = 'aac_hls'
      } else {
        format = 'm4a'
      }
    } else if (mimeType.includes('opus')) {
      format = 'opus'
    }

    return {
      url: finalUrl,
      protocol,
      format
    }
  }

  async loadStream(track, url, protocol, additionalData) {
    const stream = new PassThrough()

    if (protocol === 'progressive') {
      this._handleProgressive(url, stream)
    } else if (protocol === 'hls') {
      this._handleHls(url, stream)
    } else {
      stream.destroy(new Error(`Unsupported protocol: ${protocol}`))
    }

    return { stream }
  }

  async _handleProgressive(url, stream) {
    try {
      const res = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (res.error) {
        stream.destroy(new Error(`Stream load failed: ${res.error.message}`))
        return
      }

      pipeline(res.stream, stream, (err) => {
        if (err) {
          logger('error', 'Sources', `Progressive pipeline error: ${err.message}`)
          if (!stream.destroyed) stream.destroy(err)
        } else {
          stream.emit('finishBuffering')
        }
      })
    } catch (err) {
      this._logError('Progressive stream failed', err)
      stream.destroy(err)
    }
  }

  async _handleHls(url, stream) {
    try {
      await loadHLS(url, stream, false, true)
    } catch (err) {
      this._logError('HLS stream failed', err)
      if (!stream.destroyed) stream.destroy(err)
    }
  }

  _isValidString(val) {
    return typeof val === 'string' && val.length > 0
  }

  _logError(msg, err) {
    logger('error', 'Sources', `${msg}: ${err?.message ?? 'Unknown'}`)
  }

  _buildError(message) {
    return {
      loadType: 'error',
      data: {
        message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  _buildException(message) {
    return {
      exception: {
        message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }
}
