import { PassThrough } from 'node:stream'
import {
  encodeTrack,
  http1makeRequest,
  loadHLS,
  logger,
  makeRequest
} from '../utils.js'

export default class {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.baseUrl = 'https://api-v2.soundcloud.com'
    this.searchTerms = ['scsearch']
    this.patterns = [
      /^https?:\/\/(www\.)?soundcloud\.com\/[^/\s]+\/[^/\s]+$/,
      /^https?:\/\/m\.soundcloud\.com\/[^/\s]+\/[^/\s]+$/,
      /^https?:\/\/(www\.)?soundcloud\.com\/[^/\s]+\/sets\/[^/\s]+$/,
      /^https?:\/\/m\.soundcloud\.com\/[^/\s]+\/sets\/[^/\s]+$/
    ]

    this.clientId = this.nodelink.options?.sources?.clientId ?? null
  }
  async setup() {
    if (this.clientId) return true
    try {
      const mainPageRequest = await makeRequest('https://soundcloud.com', {
        method: 'GET'
      })
      if (!mainPageRequest) {
        logger('error', 'Sources', 'Failed to load SoundCloud main page')
        return false
      }
      if (mainPageRequest.error) {
        logger(
          'error',
          'Sources',
          `Failed to fetch SoundCloud clientId: ${mainPageRequest.error.message}`
        )
        return false
      }
      const assetIdMatch = mainPageRequest.body.match(
        /https:\/\/a-v2.sndcdn.com\/assets\/([a-zA-Z0-9-]+).js/gs
      )
      if (!assetIdMatch || !assetIdMatch[5]) {
        logger('warn', 'Sources', 'SoundCloud asset script URL not found at expected index. Source setup failed.')
        return false
      }
      const assetId = assetIdMatch[5]

      const assetRequest = await http1makeRequest(assetId)
      if (!assetRequest) {
        logger('error', 'Sources', 'Failed to load SoundCloud asset. Source setup failed.')
        return false
      }
      if (assetRequest.error) {
        logger(
          'error',
          'Sources',
          `Failed to fetch SoundCloud assets: ${assetRequest.error.message}. Source setup failed.`
        )
        return false
      }

      const clientIdMatch = assetRequest.body.match(/client_id=([a-zA-Z0-9]{32})/)
      if (!clientIdMatch || !clientIdMatch[1]) {
        logger('warn', 'Sources', 'SoundCloud client_id not found in asset script. Source setup failed.')
        return false
      }
      const clientId = clientIdMatch[1]
      if (!clientId) {
        logger('error', 'Sources', 'Failed to fetch SoundCloud clientId. Source setup failed.')
        return false
      }
      logger(
        'info',
        'Sources',
        `Loaded SoundCloud source (clientId: ${clientId})`
      )
      this.clientId = clientId
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Error setting up SoundCloud source: ${err.message}`
      )
      return false
    }
    return true
  }
  match() {}
  async search(query) {
    const req = await http1makeRequest(
      `https://api-v2.soundcloud.com/search?q=${encodeURI(query)}&variant_ids=&facet=model&user_id=992000-167630-994991-450103&client_id=${this.clientId}&limit=${this.nodelink.options.maxSearchResults}&offset=0&linked_partitioning=1&app_version=1679652891&app_locale=en`
    )
    if (req.error || req.statusCode !== 200) {
      return {
        loadType: 'error',
        data: {
          message: req.error
            ? req.error.message
            : `SoundCloud returned invalid status code: ${req.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
    const { body } = req
    if (body.total_results === 0) {
      logger(
        'debug',
        'Sources',
        `No results found on SoundCloud for: "${query}"`
      )
      return {
        loadType: 'empty',
        data: {}
      }
    }

    const tracks = []
    if (body.collection > this.nodelink.options.maxSearchResults)
      body.collection = body.collection.filter(
        (item, index) =>
          index < this.nodelink.options.maxSearchResults ||
          item.kind === 'track'
      )
    for (const item of body.collection) {
      if (item.kind !== 'track') continue
      const track = this.buildTrack(item)
      tracks.push(track)
    }

    logger(
      'debug',
      'Sources',
      `Found ${tracks.length} tracks on SoundCloud for "${query}"`
    )
    return {
      loadType: 'search',
      data: tracks
    }
  }
  async resolve(url) {
    const request = await http1makeRequest(
      `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${this.clientId}`
    )

    if (request.statusCode === 404) return { loadType: 'empty', data: {} }

    if (request.error || request.statusCode !== 200) {
      return {
        loadType: 'error',
        data: {
          message:
            request.error?.message ||
            `Invalid status code: ${request.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    const { body } = request
    if (!body || typeof body !== 'object') {
      return {
        loadType: 'error',
        data: {
          message: 'Invalid SoundCloud response',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    if (body.kind === 'track') {
      return {
        loadType: 'track',
        data: this.buildTrack(body)
      }
    }

    if (body.kind === 'playlist') {
      const trackIds = []
      const completeTracks = []

      for (const t of body.tracks) {
        if (t?.title && t.user) {
          completeTracks.push(t)
        } else if (t?.id) {
          trackIds.push(t.id)
        }
      }

      while (trackIds.length) {
        const batch = trackIds.splice(0, 50)
        const res = await http1makeRequest(
          `https://api-v2.soundcloud.com/tracks?ids=${batch.join('%2C')}&client_id=${this.clientId}`,
          {
            method: 'GET'
          }
        )

        if (Array.isArray(res.body)) {
          completeTracks.push(...res.body)
        } else {
          break
        }
      }

      if (completeTracks.length > this.nodelink.options.maxAlbumPlaylistLength)
        completeTracks.length = this.nodelink.options.maxAlbumPlaylistLength

      const tracks = completeTracks.map((item) => {
        const info = {
          identifier: item.id.toString(),
          isSeekable: true,
          author: item.user.username,
          length: item.duration,
          isStream: false,
          position: 0,
          title: item.title,
          uri: item.permalink_url,
          artworkUrl: item.artwork_url,
          isrc: item.publisher_metadata?.isrc || null,
          sourceName: 'soundcloud'
        }

        return {
          encoded: encodeTrack(info),
          info,
          playlistInfo: {}
        }
      })

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

    return { loadType: 'empty', data: {} }
  }
  buildTrack(item) {
    const info = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.user.username,
      length: item.duration,
      isStream: false,
      position: 0,
      title: item.title,
      uri: item.permalink_url,
      artworkUrl: item.artwork_url,
      isrc: item.publisher_metadata?.isrc || null,
      sourceName: 'soundcloud'
    }

    return {
      encoded: encodeTrack(info),
      info,
      pluginInfo: {}
    }
  }

  async getTrackUrl(info) {
    const req = await http1makeRequest(
      `https://api-v2.soundcloud.com/resolve?url=https://api.soundcloud.com/tracks/${info.identifier}&client_id=${this.clientId}`
    )
    const body = req.body
    if (req.error || req.statusCode !== 200) {
      logger(
        'error',
        'Sources',
        `SoundCloud getTrackUrl error: ${req.error?.message}`
      )
      return {
        exception: {
          message:
            req.error?.message ||
            `SoundCloud returned invalid status code: ${req.statusCode}`,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
    if (body.errors) {
      logger(
        'error',
        'Sources',
        `SoundCloud getTrackUrl error: ${body.errors[0].error_message}`
      )
      return {
        exception: {
          message: body.errors[0].error_message,
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }

    const oggOpus = body.media.transcodings.find(
      (transcoding) =>
        transcoding.format.mime_type === 'audio/ogg; codecs="opus"'
    )

    const transcoding = oggOpus || body.media.transcodings[0]
    let url = `${transcoding.url}?client_id=${this.clientId}`

    if (transcoding.format.protocol === 'hls') {
      url = await http1makeRequest(url)
      url = url.body.url
    }

    // In previous versions, there was a parameter for automatic fallback if the track was "snipped", searching in another configured source (e.g., YouTube) if `config.search.sources.soundcloud.fallbackIfSnipped` was enabled.
    // The code would perform a new search by the track title using the default source and return the alternative URL.
    // Since there is currently no other source implemented for alternative search, this functionality will not be implemented at this time.

    let format = 'opus'
    if (transcoding.format.mime_type) {
      const mimeType = transcoding.format.mime_type.toLowerCase()
      if (mimeType.includes('opus')) {
        format = 'ogg/opus'
      } else if (mimeType.includes('mpeg')) {
        format = 'audio/mpeg'
      } else if (mimeType.includes('aac')) {
        format = 'audio/aac'
      }
    }

    return {
      url,
      protocol: transcoding.format.protocol,
      format
    }
  }
  async loadStream(track, url, protocol, additionalData) {
    const stream = PassThrough()
    loadHLS(url, stream, false, true)
    return { stream }
  }
}
