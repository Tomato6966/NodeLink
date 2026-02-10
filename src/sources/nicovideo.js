import { encodeTrack, http1makeRequest, logger } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.ts'

export default class NicoVideoSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = ['ncsearch', 'nicovideo']
    this.patterns = [
      /^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/(\w+)/,
      /^https?:\/\/nico\.ms\/(\w+)/
    ]
    this.priority = 75
  }
  async setup() {
    logger('info', 'Sources', 'Loaded NicoVideo source.')
    return true
  }
  _buildHeaders(accessRightKey) {
    const headers = {
      'User-Agent': 'NodeLink',
      'X-Request-With': 'https://www.nicovideo.jp',
      Referer: 'https://www.nicovideo.jp/',
      'X-Frontend-Id': '6',
      'X-Frontend-Version': '0'
    }
    if (accessRightKey) {
      headers['x-access-right-key'] = accessRightKey
    }
    return headers
  }
  async search(query) {
    logger('debug', 'NicoVideo', `Searching for: ${query}`)
    const params = new URLSearchParams({
      q: query,
      targets: 'title,tags',
      fields: 'contentId,title,owner,thumbnailUrl,duration',
      _sort: '-viewCounter',
      _context: 'NodeLink',
      _limit: 25
    })
    const { body, error, statusCode } = await http1makeRequest(
      `https://api.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`
    )
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to search: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    if (!body.data || body.data.length === 0) {
      return { loadType: 'empty', data: {} }
    }
    const tracks = body.data.map((item) => {
      const trackInfo = {
        identifier: item.contentId,
        isSeekable: true,
        author: item.owner?.name || 'Unknown Artist',
        length: item.duration * 1000,
        isStream: false,
        position: 0,
        title: item.title,
        uri: `https://www.nicovideo.jp/watch/${item.contentId}`,
        artworkUrl: item.thumbnailUrl,
        isrc: null,
        sourceName: 'nicovideo'
      }
      return {
        encoded: encodeTrack(trackInfo),
        info: trackInfo,
        pluginInfo: {}
      }
    })
    return { loadType: 'search', data: tracks }
  }
  async resolve(url) {
    const videoId =
      url.match(this.patterns[0])?.[1] || url.match(this.patterns[1])?.[1]
    if (!videoId) return { loadType: 'empty', data: {} }
    const { body, error, statusCode } = await http1makeRequest(
      `https://www.nicovideo.jp/watch/${videoId}?responseType=json`,
      { headers: this._buildHeaders() }
    )
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to resolve URL: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    const jsonLd = body?.data?.metadata?.jsonLds?.find(
      (x) => x['@type'] === 'VideoObject'
    )
    const videoIdFromApi = body?.data?.response?.client?.watchId
    if (!jsonLd || !videoIdFromApi) {
      return {
        exception: {
          message: 'Could not extract video information.',
          severity: 'common'
        }
      }
    }
    const durationStr = jsonLd.duration
    const durationMs = durationStr
      ? Number.parseInt(durationStr.match(/(\d+)S/)?.[1] || 0, 10) * 1000
      : 0
    const track = {
      identifier: videoIdFromApi,
      isSeekable: true,
      author: jsonLd.author?.name || 'Unknown Artist',
      length: durationMs,
      isStream: false,
      position: 0,
      title: jsonLd.name,
      uri: jsonLd['@id'],
      artworkUrl: jsonLd.thumbnailUrl?.[0] || null,
      isrc: null,
      sourceName: 'nicovideo'
    }
    return {
      loadType: 'track',
      data: { encoded: encodeTrack(track), info: track, pluginInfo: {} }
    }
  }
  _buildOutputData(dmcMedia) {
    const quality = ['1080p', '720p', '480p', '360p', '144p']
    const outputs = []
    let topAudioId = null
    let topAudioQuality = -1
    for (const audio of dmcMedia.audios) {
      if (audio.isAvailable && audio.qualityLevel > topAudioQuality) {
        topAudioId = audio.id
        topAudioQuality = audio.qualityLevel
      }
    }
    if (!topAudioId) return outputs
    for (const video of dmcMedia.videos) {
      if (quality.includes(video.label) && video.isAvailable) {
        outputs.push([video.id, topAudioId])
      }
    }
    return outputs
  }
  async getTrackUrl(track, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.nodelink.trackCacheManager.get('nicovideo', track.identifier)
      if (cached) return cached
    }

    const {
      body: pageData,
      error,
      statusCode
    } = await http1makeRequest(`${track.uri}?responseType=json`, {
      headers: this._buildHeaders()
    })
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to get track page: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    const response = pageData?.data?.response
    if (!response) {
      return {
        exception: {
          message: 'Failed to extract response data from page',
          severity: 'fault'
        }
      }
    }
    const dmcMedia = response.media?.domand
    const watchTrackId = response.client?.watchTrackId
    const accessRightKey = dmcMedia?.accessRightKey
    if (!dmcMedia || !watchTrackId || !accessRightKey) {
      return {
        exception: {
          message: 'Failed to extract required DMC info for stream access',
          severity: 'fault'
        }
      }
    }
    const streamRequestUrl = `https://nvapi.nicovideo.jp/v1/watch/${track.identifier}/access-rights/hls?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`
    const postBody = { outputs: this._buildOutputData(dmcMedia) }
    const {
      body: streamData,
      headers: streamHeaders,
      error: streamError,
      statusCode: streamStatus
    } = await http1makeRequest(streamRequestUrl, {
      method: 'POST',
      headers: this._buildHeaders(accessRightKey),
      body: postBody,
      disableBodyCompression: true
    })
    if (streamError || streamStatus !== 201) {
      return {
        exception: {
          message: `Failed to get stream access rights: ${streamError?.message || streamStatus}`,
          severity: 'fault'
        }
      }
    }
    const cookie = streamHeaders['set-cookie']
      ? Array.isArray(streamHeaders['set-cookie'])
        ? streamHeaders['set-cookie'].join('; ')
        : streamHeaders['set-cookie']
      : null
    const masterPlaylistUrl = streamData.data.contentUrl
    const {
      body: masterPlaylistContent,
      error: masterError,
      statusCode: masterStatus
    } = await http1makeRequest(masterPlaylistUrl, {
      headers: { Cookie: cookie }
    })
    if (masterError || masterStatus !== 200) {
      return {
        exception: {
          message: `Failed to fetch master HLS playlist: ${masterError?.message || masterStatus}`,
          severity: 'fault'
        }
      }
    }
    const lines = masterPlaylistContent.split('\n')
    const audioTag = lines.find(
      (l) => l.startsWith('#EXT-X-MEDIA') && l.includes('TYPE=AUDIO')
    )
    if (!audioTag) {
      return {
        url: masterPlaylistUrl,
        protocol: 'hls',
        format: 'aac',
        additionalData: { cookie }
      }
    }
    const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1]
    if (!audioUri) {
      return {
        exception: {
          message: 'Could not parse audio URI from master playlist',
          severity: 'fault'
        }
      }
    }
    const audioPlaylistUrl = new URL(audioUri, masterPlaylistUrl).toString()
    const result = {
      url: audioPlaylistUrl,
      protocol: 'hls',
      format: 'aac',
      additionalData: { cookie }
    }
    this.nodelink.trackCacheManager.set('nicovideo', track.identifier, result, 1000 * 60 * 60)
    return result
  }
  async loadStream(_track, url, protocol, additionalData) {
    if (protocol === 'hls') {
      const headers = this._buildHeaders()
      if (additionalData?.cookie) {
        headers.Cookie = additionalData.cookie
      }
      const stream = new HLSHandler(url, {
        headers,
        type: 'fmp4',
        localAddress: this.nodelink.routePlanner?.getIP(),
        startTime: additionalData?.startTime || 0
      })
      return { stream, type: 'fmp4' }
    }
    return {
      exception: { message: 'Unsupported protocol', severity: 'common' }
    }
  }
}
