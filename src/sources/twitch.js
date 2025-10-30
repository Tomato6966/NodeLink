import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger } from '../utils.js'

async function manageHlsStream(initialUrl, outputStream) {
  const segmentQueue = []
  const processedSegments = new Set()
  let stop = false
  const playlistUrl = initialUrl

  outputStream.on('close', () => {
    stop = true
  })

  const playlistFetcher = async () => {
    while (!stop) {
      try {
        const {
          body: playlistContent,
          error,
          statusCode
        } = await http1makeRequest(playlistUrl)
        if (error || statusCode !== 200)
          throw new Error(`Playlist fetch failed: ${statusCode}`)

        const lines = playlistContent.split('\n')
        let targetDuration = 2
        const targetDurationLine = lines.find((l) =>
          l.startsWith('#EXT-X-TARGETDURATION:')
        )
        if (targetDurationLine)
          targetDuration = Number.parseInt(targetDurationLine.split(':')[1], 10)

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const segmentUrl = lines[++i]
            if (segmentUrl && !segmentUrl.startsWith('#')) {
              const absoluteUrl = new URL(segmentUrl, playlistUrl).toString()
              if (!processedSegments.has(absoluteUrl)) {
                processedSegments.add(absoluteUrl)
                segmentQueue.push(absoluteUrl)
              }
            }
          }
        }

        if (playlistContent.includes('#EXT-X-ENDLIST')) {
          stop = true
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, targetDuration) * 1000)
        )
      } catch (e) {
        logger('error', 'Twitch-HLS-Fetcher', `Error: ${e.message}`)
        stop = true
      }
    }
  }

  const segmentDownloader = async () => {
    while (!stop) {
      if (segmentQueue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }

      const segmentUrl = segmentQueue.shift()

      try {
        const {
          stream: segmentStream,
          error,
          statusCode
        } = await http1makeRequest(segmentUrl, { streamOnly: true })
        if (error || statusCode !== 200) {
          logger(
            'warn',
            'Twitch-HLS-Downloader',
            `Failed segment ${segmentUrl}: ${statusCode}`
          )
          continue
        }

        if (outputStream.destroyed) break

        await new Promise((resolve, reject) => {
          segmentStream.pipe(outputStream, { end: false })
          segmentStream.on('end', resolve)
          segmentStream.on('error', reject)
        })
      } catch (e) {
        logger(
          'error',
          'Twitch-HLS-Downloader',
          `Error processing segment ${segmentUrl}: ${e.message}`
        )
      }
    }

    if (!outputStream.destroyed) {
      outputStream.emit('finishBuffering')
      outputStream.end()
    }
  }

  playlistFetcher()
  segmentDownloader()
}

export default class TwitchSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.|go\.|m\.)?twitch\.tv\/(?:[\w_]+\/clip\/[\w%-_]+|videos\/\d+|[\w_]+)/
    ]
    this.priority = 70
    this.clientId = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
    this.deviceId = null
  }

  async setup() {
    try {
      const { body, headers, error, statusCode } = await http1makeRequest(
        'https://www.twitch.tv/',
        {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            Connection: 'keep-alive'
          }
        }
      )

      if (error || statusCode !== 200) {
        throw new Error(
          `Failed to fetch Twitch page: ${error?.message || statusCode}`
        )
      }

      const clientIdMatch = body.match(/clientId="(\w+)"/)
      if (clientIdMatch?.[1]) {
        this.clientId = clientIdMatch[1]
      } else {
        logger(
          'warn',
          'Twitch',
          'Failed to extract client ID from Twitch page, using default.'
        )
      }

      const setCookieHeader = headers['set-cookie']
      if (setCookieHeader) {
        const deviceIdCookie = Array.isArray(setCookieHeader)
          ? setCookieHeader.find((c) => c.includes('unique_id='))
          : setCookieHeader
        if (deviceIdCookie) {
          const deviceIdMatch = deviceIdCookie.match(/unique_id=([^;]+);/)
          if (deviceIdMatch?.[1]) {
            this.deviceId = deviceIdMatch[1]
          }
        }
      }

      if (!this.deviceId) {
        logger(
          'warn',
          'Twitch',
          'Failed to extract device ID from Twitch page.'
        )
      }

      logger(
        'info',
        'Sources',
        `Loaded Twitch source. Client ID: ${this.clientId}`
      )
      return true
    } catch (e) {
      logger('error', 'Sources', `Failed to setup Twitch source: ${e.message}`)
      return false
    }
  }

  async _gqlRequest(payload) {
    const headers = {
      'Client-ID': this.clientId,
      'Content-Type': 'application/json'
    }
    if (this.deviceId) {
      headers['X-Device-ID'] = this.deviceId
    }

    const { body, error, statusCode } = await http1makeRequest(
      'https://gql.twitch.tv/gql',
      {
        method: 'POST',
        headers,
        body: payload,
        disableBodyCompression: true
      }
    )

    if (error || statusCode !== 200) {
      throw new Error(`GQL request failed: ${error?.message || statusCode}`)
    }

    return body
  }

  _getChannelName(url) {
    const match = url.match(/twitch\.tv\/([\w_]+)/)
    return match ? match[1].toLowerCase() : null
  }

  _getClipSlug(url) {
    const match = url.match(/\/clip\/([\w%-_]+)/)
    return match ? match[1] : null
  }

  _getVodId(url) {
    const match = url.match(/\/videos\/(\d+)/)
    return match ? match[1] : null
  }

  async resolve(url) {
    const clipSlug = this._getClipSlug(url)
    if (clipSlug) return this._loadClip(clipSlug, url)

    const vodId = this._getVodId(url)
    if (vodId) return this._loadVod(vodId, url)

    const channelName = this._getChannelName(url)
    if (channelName) return this._loadChannel(channelName, url)

    return { loadType: 'empty', data: {} }
  }

  async _fetchClipMetadata(slug) {
    const payload = {
      operationName: 'ClipsView',
      query: `query ClipsView($slug: ID!) {
        clip(slug: $slug) {
          id
          slug
          title
          broadcaster {
            id
            displayName
            login
          }
          videoQualities {
            quality
            sourceURL
          }
          thumbnailURL
          durationSeconds
        }
      }`,
      variables: { slug },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            '0d6d8d951d3b5305a3f2a0f2661b8a6a6d25dc042b155d8df8586905f0a0f435'
        }
      }
    }
    const result = await this._gqlRequest(payload)
    return result?.data?.clip
  }

  async _loadClip(slug, originalUrl) {
    try {
      const clipData = await this._fetchClipMetadata(slug)
      if (!clipData) {
        return {
          exception: { message: 'Clip not found', severity: 'common' }
        }
      }

      const track = this.buildTrack({
        identifier: clipData.slug,
        uri: originalUrl,
        title: clipData.title || 'Twitch Clip',
        author: clipData.broadcaster.displayName,
        length: Math.floor(clipData.durationSeconds * 1000),
        isSeekable: true,
        isStream: false,
        artworkUrl: clipData.thumbnailURL
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _fetchVodMetadata(vodId) {
    const payload = {
      operationName: 'VideoMetadata',
      variables: { videoID: vodId, channelLogin: '' },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            '226edb3e692509f727fd56821f5653c05740242c82b0388883e0c0e75dcbf687'
        }
      }
    }
    const result = await this._gqlRequest(payload)
    return result?.data?.video
  }

  async _loadVod(vodId, originalUrl) {
    try {
      const vodData = await this._fetchVodMetadata(vodId)
      if (!vodData) {
        return {
          exception: { message: 'VOD not found', severity: 'common' }
        }
      }

      let thumbnail = vodData.previewThumbnailURL
      if (thumbnail) {
        thumbnail = thumbnail
          .replace('{width}', '320')
          .replace('{height}', '180')
      }

      const track = this.buildTrack({
        identifier: vodId,
        uri: originalUrl,
        title: vodData.title || 'Twitch VOD',
        author: vodData.owner.displayName,
        length: Math.floor(vodData.lengthSeconds * 1000),
        isSeekable: true,
        isStream: false,
        artworkUrl: thumbnail
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async _loadChannel(channelName, originalUrl) {
    try {
      const payload = {
        operationName: 'StreamMetadata',
        variables: { channelLogin: channelName },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash:
              '1c719a40e481453e5c48d9bb585d971b8b372f8ebb105b17076722264dfa5b3e'
          }
        }
      }
      const result = await this._gqlRequest(payload)
      const streamInfo = result?.data?.user?.stream

      if (!streamInfo || streamInfo.type !== 'live') {
        return {
          exception: {
            message: 'Live stream not found or not live.',
            severity: 'common'
          }
        }
      }

      const thumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channelName}-440x248.jpg`
      const track = this.buildTrack({
        identifier: channelName,
        uri: originalUrl,
        title: result.data.user.lastBroadcast.title || 'Live Stream',
        author: channelName,
        length: 0,
        isSeekable: false,
        isStream: true,
        artworkUrl: thumbnail
      })

      return { loadType: 'track', data: track }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault' }
      }
    }
  }

  async getTrackUrl(track) {
    const uri = track.uri
    const clipSlug = this._getClipSlug(uri)
    if (clipSlug) return this._getClipStreamUrl(clipSlug)

    const vodId = this._getVodId(uri)
    if (vodId) return this._getVodStreamUrl(vodId)

    const channelName = this._getChannelName(uri)
    if (channelName) return this._getLiveStreamUrl(channelName)

    return { exception: { message: 'Invalid Twitch URL', severity: 'common' } }
  }

  async _fetchLiveAccessToken(channel) {
    const payload = {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {
        streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
          value
          signature
          authorization {
            isForbidden
            forbiddenReasonCode
          }
          __typename
        }
        videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
          value
          signature
          __typename
        }
      }`,
      variables: {
        isLive: true,
        login: channel,
        isVod: false,
        vodID: '',
        playerType: 'site',
        platform: 'web'
      }
    }
    const result = await this._gqlRequest(payload)
    return result?.data?.streamPlaybackAccessToken
  }

  async _getLiveStreamUrl(channelName) {
    try {
      const token = await this._fetchLiveAccessToken(channelName)
      if (!token) {
        throw new Error('Failed to get access token')
      }

      const params = new URLSearchParams({
        player_type: 'site',
        token: token.value,
        sig: token.signature,
        allow_source: 'true',
        allow_audio_only: 'true'
      })

      const hlsUrl = `https://usher.ttvnw.net/api/channel/hls/${channelName}.m3u8?${params.toString()}`
      const { body: m3u8, error, statusCode } = await http1makeRequest(hlsUrl)

      if (error || statusCode !== 200) {
        throw new Error(
          `Failed to fetch HLS playlist: ${error?.message || statusCode}`
        )
      }

      const bestQuality = this._parseM3U8(m3u8)
      if (!bestQuality) {
        throw new Error('No playable streams found in M3U8 playlist')
      }

      return {
        url: bestQuality.url,
        protocol: 'hls',
        format: 'mpegts'
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _fetchClipAccessToken(slug) {
    const payload = {
      operationName: 'ClipAccessToken',
      query: `query ClipAccessToken($slug: ID!, $params: PlaybackAccessTokenParams!) {
        clip(slug: $slug) {
          playbackAccessToken(params: $params) {
            value
            signature
          }
        }
      }`,
      variables: {
        slug,
        params: {
          platform: 'web',
          playerBackend: 'mediaplayer',
          playerType: 'embed'
        }
      }
    }
    const result = await this._gqlRequest(payload)
    return result?.data?.clip?.playbackAccessToken
  }

  async _getClipStreamUrl(slug) {
    try {
      const clipData = await this._fetchClipMetadata(slug)
      if (!clipData || !clipData.videoQualities) {
        throw new Error('Failed to load clip metadata or no qualities found')
      }

      let bestQuality = null
      for (const quality of clipData.videoQualities) {
        if (
          !bestQuality ||
          Number.parseInt(quality.quality) >
            Number.parseInt(bestQuality.quality)
        ) {
          bestQuality = quality
        }
      }

      if (!bestQuality) {
        throw new Error('No playable sources found for clip')
      }

      const tokenData = await this._fetchClipAccessToken(slug)
      if (!tokenData) {
        throw new Error('Failed to fetch clip access token')
      }

      const params = new URLSearchParams({
        token: tokenData.value,
        sig: tokenData.signature
      })

      const finalUrl = `${bestQuality.sourceURL}?${params.toString()}`
      return { url: finalUrl, protocol: 'https', format: 'mp4' }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _fetchVodAccessToken(vodId) {
    const payload = {
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($isVod: Boolean!, $vodID: ID!, $playerType: String!, $platform: String!) {
        videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
          value
          signature
        }
      }`,
      variables: {
        isVod: true,
        vodID: vodId,
        playerType: 'site',
        platform: 'web'
      }
    }
    const result = await this._gqlRequest(payload)
    return result?.data?.videoPlaybackAccessToken
  }

  async _getVodStreamUrl(vodId) {
    try {
      const token = await this._fetchVodAccessToken(vodId)
      if (!token) {
        throw new Error('Failed to get VOD access token')
      }

      const params = new URLSearchParams({
        player_type: 'html5',
        token: token.value,
        sig: token.signature,
        allow_source: 'true',
        allow_audio_only: 'true'
      })

      const vodUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?${params.toString()}`
      return { url: vodUrl, protocol: 'hls', format: 'mpegts' }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  _parseM3U8(data) {
    const lines = data.split('\n')
    let bestBandwidth = 0
    let bestUrl = null

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/)
        if (bandwidthMatch) {
          const bandwidth = Number.parseInt(bandwidthMatch[1], 10)
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth
            bestUrl = lines[i + 1]
          }
        }
      }
    }

    if (bestUrl) return { url: bestUrl }

    bestBandwidth = 0
    bestUrl = null
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/)
        const bandwidth = bandwidthMatch
          ? Number.parseInt(bandwidthMatch[1], 10)
          : 0
        const uriMatch = line.match(/URI="([^"]+)"/)
        if (uriMatch && bandwidth >= bestBandwidth) {
          bestBandwidth = bandwidth
          bestUrl = uriMatch[1]
        }
      }
    }

    return bestUrl ? { url: bestUrl } : null
  }

  async loadStream(track, url, protocol) {
    if (protocol === 'hls') {
      const stream = new PassThrough()
      manageHlsStream(url, stream)
      return { stream, type: 'mpegts' }
    }

    const { stream, error, statusCode } = await http1makeRequest(url, {
      streamOnly: true
    })
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to load stream: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    return { stream, type: 'mp4' }
  }

  search(query) {
    return {
      exception: {
        message: 'Search is not supported for Twitch',
        severity: 'common'
      }
    }
  }

  buildTrack(partialInfo) {
    const track = {
      identifier: partialInfo.identifier,
      isSeekable: false,
      author: partialInfo.author,
      length: partialInfo.length,
      isStream: partialInfo.isStream,
      position: 0,
      title: partialInfo.title,
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: null,
      sourceName: 'twitch'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }
}
