import {
  encodeTrack,
  logger,
  makeRequest,
  http1makeRequest,
  generateRandomLetters,
  loadHLSPlaylist
} from '../utils.js'
import { PassThrough } from 'node:stream'

const YOUTUBE_CONSTANTS = {
  VIDEO: 0,
  PLAYLIST: 1,
  SHORTS: 2,
  UNKNOWN: -1
}

export default class YouTubeSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['youtube', 'ytsearch', 'ytmsearch']
    this.patterns = [
      /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+)|youtu\.be\/[\w-]+)/,
      /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^https?:\/\/music\.youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+)/
    ]

    this.ytContext = {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.03.35',
        userAgent: 'com.google.android.youtube/20.03.35 (Linux; U; Android 14 gzip)',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        hl: this.config.sources.youtube.hl || 'en',
        gl: this.config.sources.youtube.gl || 'US',
        androidSdkVersion: '30',
        screenDensityFloat: 1,
        screenHeightPoints: 1080,
        screenPixelDensity: 1,
        screenWidthPoints: 1920,
        visitorData: null
      }
    }
    this.visitorDataInterval = null
  }

  async setup() {
    logger('info', 'youtube', 'Setting up YouTube source...')
    await this._fetchVisitorData()

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
    }
    this.visitorDataInterval = setInterval(() => this._fetchVisitorData(), 3600000)
    logger('info', 'youtube', 'YouTube source setup complete.')
    return true
  }

  cleanup() {
    logger('info', 'youtube', 'Cleaning up YouTube source...')
    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }
  }

  _switchClient(clientName) {
    logger('debug', 'youtube', `Switching YouTube client to: ${clientName}`)
    const { hl, gl, visitorData } = this.ytContext.client

    const clientConfigs = {
      ANDROID: {
        clientName: 'ANDROID',
        clientVersion: '20.03.35',
        userAgent: 'com.google.android.youtube/20.03.35 (Linux; U; Android 14 gzip)',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        androidSdkVersion: '30'
      },
      ANDROID_MUSIC: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '6.37.50',
        userAgent: 'com.google.android.apps.youtube.music/6.37.50 (Linux; U; Android 14 gzip)',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        androidSdkVersion: '30'
      },
      IOS: {
        clientName: 'IOS',
        clientVersion: '19.47.7',
        userAgent: 'com.google.ios.youtube/19.47.7 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '17.5.1.21F90',
        utcOffsetMinutes: 0
      }
    }

    if (clientConfigs[clientName]) {
      this.ytContext.client = {
        ...clientConfigs[clientName],
        hl,
        gl,
        visitorData,
        screenDensityFloat: 1,
        screenHeightPoints: 1080,
        screenPixelDensity: 1,
        screenWidthPoints: 1920
      }
    } else {
      logger('warn', 'youtube', `Attempted to switch to unknown client: ${clientName}`)
    }
  }

  async _fetchVisitorData() {
    logger('debug', 'youtube', 'Fetching visitor data...')
    try {
      const {
        body: data,
        error,
        statusCode
      } = await makeRequest('https://www.youtube.com', { method: 'GET' })
      let visitorFound = false

      if (!error && statusCode === 200) {
        const visitorMatch = data?.match(/"VISITOR_DATA":"([^"]+)"/)
        //biome-ignore lint:
        if (visitorMatch && visitorMatch[1]) {
          this.ytContext.client.visitorData = visitorMatch[1]
          logger(
            'debug',
            'youtube',
            `Successfully fetched visitor data: ${this.ytContext.client.visitorData}`
          )
          visitorFound = true
        }
      }

      if (!visitorFound) {
        logger(
          'warn',
          'youtube',
          `Failed to fetch initial page for visitor data: ${error?.message || `Status ${statusCode}`}`
        )
        const {
          body: guideData,
          error: guideError,
          statusCode: guideStatusCode
        } = await makeRequest('https://www.youtube.com/youtubei/v1/guide', {
          method: 'POST',
          body: { context: this.ytContext },
          disableBodyCompression: true
        })

        if (!guideError && guideStatusCode === 200 && guideData.responseContext?.visitorData) {
          this.ytContext.client.visitorData = guideData.responseContext.visitorData
          logger(
            'debug',
            'youtube',
            `Successfully fetched visitor data from guide endpoint: ${this.ytContext.client.visitorData}`
          )
        } else {
          logger(
            'warn',
            'youtube',
            'Could not extract visitor data from YouTube page or guide endpoint.'
          )
        }
      }
    } catch (e) {
      logger('error', 'youtube', `Error fetching visitor data: ${e.message}`)
    }
  }

  _getBaseUrl(type, path = 'youtubei/v1') {
    const clientName = this.ytContext.client.clientName
    if (clientName.startsWith('ANDROID_MUSIC') || type === 'ytmusic') {
      return `https://music.youtube.com/${path}`
    }
    if (clientName.startsWith('ANDROID') || clientName.startsWith('IOS')) {
      return `https://youtubei.googleapis.com/${path}`
    }
    return `https://www.youtube.com/${path}`
  }

  _getWebBaseUrl(type) {
    return type === 'ytmusic' ? 'https://music.youtube.com' : 'https://www.youtube.com'
  }

  _getSourceName(type) {
    return type === 'ytmusic' ? 'ytmusic' : 'youtube'
  }

  checkURLType(url, type) {
    const source = type === 'ytmusic' ? 'music' : 'www'
    const videoRegex = new RegExp(
      `^https?://${source === 'music' ? 'music' : '(?:www\\.)?'}youtube\\.com/watch\\?v=[\\w-]+`
    )
    const playlistRegex = new RegExp(
      `^https?://${source === 'music' ? 'music' : '(?:www\\.)?'}youtube\\.com/playlist\\?list=[\\w-]+`
    )
    const shortUrlRegex = /^https?:\/\/youtu\.be\/[\w-]+/
    const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/

    if (playlistRegex.test(url) || (videoRegex.test(url) && url.includes('&list='))) {
      return YOUTUBE_CONSTANTS.PLAYLIST
    }
    if (videoRegex.test(url)) {
      return YOUTUBE_CONSTANTS.VIDEO
    }
    if (type !== 'ytmusic') {
      if (shortsRegex.test(url)) return YOUTUBE_CONSTANTS.SHORTS
      if (shortUrlRegex.test(url)) return YOUTUBE_CONSTANTS.VIDEO
    }
    return YOUTUBE_CONSTANTS.UNKNOWN
  }
  buildTrack(itemData, itemType, sourceNameOverride = null, fullApiResponse = null) {
    // biome-ignore lint: declare-separate-vars
    let videoId,
      title,
      author,
      lengthMs = 0,
      isStream = true,
      artworkUrl,
      uri

    const getItemValue = (obj, paths, defaultValue = null) => {
      for (const path of paths) {
        //biome-ignore lint: Change to an optional chain.
        const value = path.split('.').reduce((o, k) => (o || {})[k], obj)
        if (value !== undefined && value !== null) return value
      }
      return defaultValue
    }

    const getRunsText = (runsArray, defaultValue = 'Unknown') => {
      if (Array.isArray(runsArray) && runsArray.length > 0) {
        return runsArray.map(run => run.text).join('')
      }
      return defaultValue
    }

    if (itemType === 'ytmusic') {
      const renderer = getItemValue(itemData, [
        'musicResponsiveListItemRenderer',
        'playlistPanelVideoRenderer',
        'musicTwoColumnItemRenderer'
      ])
      if (!renderer) return null

      videoId = getItemValue(
        renderer,
        ['playlistItemData.videoId', 'navigationEndpoint.watchEndpoint.videoId', 'videoId'],
        itemData.videoId
      )
      title = getRunsText(
        getItemValue(renderer, [
          'flexColumns.0.musicResponsiveListItemFlexColumnRenderer.text.runs',
          'title.runs'
        ]),
        getItemValue(itemData, ['title.simpleText'], 'Unknown Title')
      )
      author = getRunsText(
        getItemValue(renderer, [
          'flexColumns.1.musicResponsiveListItemFlexColumnRenderer.text.runs',
          'longBylineText.runs',
          'shortBylineText.runs'
        ]),
        getItemValue(itemData, ['ownerText.runs.0.text'], 'Unknown Artist')
      )

      const lengthText = getRunsText(
        getItemValue(renderer, [
          'fixedColumns.0.musicResponsiveListItemFixedColumnRenderer.text.runs',
          'lengthText.runs'
        ]),
        getItemValue(itemData, ['lengthText.simpleText'])
      )
      if (lengthText && /[:\d]+/.test(lengthText)) {
        const parts = lengthText.split(':').map(Number)
        lengthMs = parts.reduce((acc, val) => acc * 60 + val, 0) * 1000
        isStream = false
      } else if (itemData.lengthSeconds) {
        lengthMs = Number.parseInt(itemData.lengthSeconds, 10) * 1000
        isStream = !!itemData.isLive
      }

      artworkUrl = getItemValue(
        renderer,
        ['thumbnail.musicThumbnailRenderer.thumbnail.thumbnails.pop.url'],
        itemData.thumbnail?.thumbnails?.pop()?.url
      )
      uri = `https://music.youtube.com/watch?v=${videoId}`
    } else {
      let renderer = getItemValue(itemData, [
        'videoRenderer',
        'compactVideoRenderer',
        'playlistPanelVideoRenderer',
        'gridVideoRenderer'
      ])
      if (!renderer && itemData.videoId) renderer = itemData
      if (!renderer) return null

      videoId = renderer.videoId
      if (typeof renderer.title === 'string') {
        title = renderer.title
      } else {
        title = getRunsText(
          renderer.title?.runs,
          getItemValue(renderer, ['title.simpleText'], 'Unknown Title')
        )
      }
      author =
        renderer.author ||
        getRunsText(
          getItemValue(renderer, ['longBylineText.runs', 'shortBylineText.runs', 'ownerText.runs']),
          'Unknown Channel'
        )
      const lengthText = getItemValue(
        renderer,
        ['lengthText.simpleText'],
        getRunsText(renderer.lengthText?.runs)
      )
      if (lengthText && /[:\d]+/.test(lengthText)) {
        const parts = lengthText.split(':').map(Number)
        lengthMs = parts.reduce((acc, val) => acc * 60 + val, 0) * 1000
        isStream = false
      } else if (renderer.lengthSeconds) {
        lengthMs = Number.parseInt(renderer.lengthSeconds, 10) * 1000
        isStream = !!renderer.isLive
      }
      artworkUrl = renderer.thumbnail?.thumbnails?.pop()?.url
      uri = `https://www.youtube.com/watch?v=${videoId}`
    }

    if (!videoId) return null
    if (artworkUrl?.includes('?')) {
      artworkUrl = artworkUrl.split('?')[0]
    }

    const trackInfo = {
      identifier: videoId,
      isSeekable: !isStream,
      author,
      length: lengthMs,
      isStream,
      position: 0,
      title,
      uri,
      artworkUrl: artworkUrl || null,
      isrc: null,
      sourceName: sourceNameOverride || this._getSourceName(itemType)
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {
        captions: fullApiResponse?.captions
      }
    }
  }

  async search(query, type) {
    const sourceName = this._getSourceName(type)

    this._switchClient(type === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')

    const requestBody = {
      context: this.ytContext,
      query: query,
      params: type === 'ytmusic' ? 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D' : 'EgIQAQ%3D%3D'
    }

    const {
      body: searchResult,
      error,
      statusCode
    } = await makeRequest(this._getBaseUrl(type, 'youtubei/v1/search'), {
      method: 'POST',
      headers: {
        'User-Agent': this.ytContext.client.userAgent,
        'X-Goog-Api-Format-Version': '2'
      },
      body: requestBody,
      disableBodyCompression: true
    })

    if (error || statusCode !== 200) {
      const message =
        error?.message || `Failed to load results from ${sourceName}. Status: ${statusCode}`
      logger('error', 'youtube', message)
      return { loadType: 'error', data: { message, severity: 'common', cause: 'Upstream' } }
    }

    if (searchResult.error) {
      logger(
        'error',
        'youtube',
        `Error from ${sourceName} search API: ${searchResult.error.message}`
      )
      return {
        loadType: 'error',
        data: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const tracks = []
    let videos = null

    if (type === 'ytmusic') {
      videos =
        searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
          ?.musicSplitViewRenderer?.mainContent?.sectionListRenderer?.contents?.[0]
          ?.musicShelfRenderer?.contents
    } else {
      const allSections = searchResult.contents?.sectionListRenderer?.contents
      const lastIdx = allSections?.length - 1
      videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents
    }

    if (!videos || videos.length === 0) {
      logger('info', 'youtube', `No matches found on ${sourceName} for: ${query}`)
      return { loadType: 'empty', data: {} }
    }

    const maxResults = this.config.maxSearchResults || config.options.maxSearchResults
    if (videos.length > maxResults) {
      let count = 0
      videos = videos.filter(video => {
        const isValid =
          video.compactVideoRenderer || video.videoRenderer || video.musicTwoColumnItemRenderer
        if (isValid && count < maxResults) {
          count++
          return true
        }
        return false
      })
    }

    for (const videoData of videos) {
      let itemContainer = null
      if (videoData.compactVideoRenderer) {
        itemContainer = { compactVideoRenderer: videoData.compactVideoRenderer }
      } else if (videoData.videoRenderer) {
        itemContainer = { videoRenderer: videoData.videoRenderer }
      } else if (videoData.musicTwoColumnItemRenderer) {
        itemContainer = { musicTwoColumnItemRenderer: videoData.musicTwoColumnItemRenderer }
      }

      if (itemContainer) {
        const track = this.buildTrack(itemContainer, type)
        if (track) {
          tracks.push(track)
          if (tracks.length >= maxResults) break
        }
      }
    }

    if (tracks.length === 0) {
      logger('info', 'youtube', `No processable tracks found on ${sourceName} for: ${query}`)
      return { loadType: 'empty', data: {} }
    }

    return { loadType: 'search', data: tracks }
  }

  async resolve(url, type) {
    const sourceName = this._getSourceName(type)
    logger('info', 'youtube', `Resolving ${sourceName} URL: ${url}`)

    this._switchClient(type === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')
    const urlType = this.checkURLType(url, type)

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern =
          type === 'ytmusic' ? /[?&]v=([^&]+)/ : /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger('error', 'youtube', `Could not parse video ID from URL: ${url}`)
          return {
            loadType: 'error',
            data: { message: 'Invalid video URL.', severity: 'common', cause: 'Input' }
          }
        }
        const videoId = videoIdMatch[1]

        logger(
          'debug',
          'youtube',
          `Loading ${urlType === YOUTUBE_CONSTANTS.SHORTS ? 'short' : 'track'}: ${videoId}`
        )

        const { body: playerResponse, statusCode } = await makeRequest(
          this._getBaseUrl(type, 'youtubei/v1/player'),
          {
            method: 'POST',
            headers: { 'User-Agent': this.ytContext.client.userAgent },
            body: {
              context: this.ytContext,
              videoId: videoId,
              contentCheckOk: true,
              racyCheckOk: true
            },
            disableBodyCompression: true
          }
        )
        if (statusCode !== 200) {
          const message =
            error?.message || `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'youtube', message)
          return { loadType: 'error', data: { message, severity: 'common', cause: 'Upstream' } }
        }

        if (playerResponse.error) {
          logger(
            'error',
            'youtube',
            `API error for video/short ${videoId}: ${playerResponse.error.message}`
          )
          return {
            loadType: 'error',
            data: { message: playerResponse.error.message, severity: 'fault', cause: 'Upstream' }
          }
        }

        if (playerResponse.playabilityStatus?.status !== 'OK') {
          const message =
            playerResponse.playabilityStatus?.reason ||
            playerResponse.playabilityStatus?.messages?.[0] ||
            'Video not playable.'
          logger('warn', 'youtube', `Video/short ${videoId} not playable: ${message}`)
          return {
            loadType: 'error',
            data: { message, severity: 'common', cause: 'UpstreamPlayability' }
          }
        }
        const track = this.buildTrack(playerResponse.videoDetails, type, sourceName, playerResponse)
        if (!track) {
          logger('error', 'youtube', `Failed to build track for video/short ${videoId}`)
          return {
            loadType: 'error',
            data: { message: 'Failed to process video data.', severity: 'fault', cause: 'Internal' }
          }
        }

        logger(
          'info',
          'youtube',
          `Successfully loaded ${urlType === YOUTUBE_CONSTANTS.SHORTS ? 'short' : 'track'}: ${track.info.title}`
        )
        return { loadType: 'track', data: track }
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger('error', 'youtube', `Could not parse playlist ID from URL: ${url}`)
          return {
            loadType: 'error',
            data: { message: 'Invalid playlist URL.', severity: 'common', cause: 'Input' }
          }
        }

        const playlistId = playlistIdMatch[1]
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
        const currentVideoId = videoIdMatch?.[1] ?? null
        logger('debug', 'youtube', `Fetching playlist: ${playlistId}`)
        const { body: playlist } = await makeRequest(this._getBaseUrl(type, 'youtubei/v1/next'), {
          headers: { 'User-Agent': this.ytContext.client.userAgent },
          body: {
            context: this.ytContext,
            playlistId,
            contentCheckOk: true,
            racyCheckOk: true
          },
          method: 'POST',
          disableBodyCompression: true
        })

        if (playlist?.error) {
          const errMsg =
            playlist?.error?.message || `Failed to fetch playlist. Status: ${statusCode}`
          logger('error', 'youtube', `Error loading playlist ${playlistId}: ${errMsg}`)
          return {
            loadType: 'error',
            data: { message: errMsg, severity: 'common', cause: 'Upstream' }
          }
        }

        let contentsRoot
        try {
          contentsRoot =
            type === 'ytmusic'
              ? playlist.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer
                  .watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer
              : playlist.contents.singleColumnWatchNextResults
        } catch (e) {
          logger('error', 'youtube', `Failed to parse playlist contents: ${e.message}`)
          return {
            loadType: 'error',
            data: {
              message: 'Could not parse playlist contents.',
              severity: 'fault',
              cause: 'Internal'
            }
          }
        }

        const playlistContent =
          type === 'ytmusic'
            ? contentsRoot?.content?.playlistPanelRenderer?.contents
            : contentsRoot?.playlist?.playlist?.contents

        if (!playlistContent || playlistContent.length === 0) {
          logger('info', 'youtube', `Playlist ${playlistId} is empty or inaccessible.`)
          return { loadType: 'empty', data: {} }
        }

        const tracks = []
        let selectedTrack = 0
        const maxLength = this.config.maxAlbumPlaylistLength || 100

        for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
          const item = playlistContent[i]
          const track = this.buildTrack(item, type, 'youtube')
          if (track) {
            tracks.push(track)
            if (currentVideoId && track.info.identifier === currentVideoId) {
              selectedTrack = i
            }
          }
        }

        if (tracks.length === 0) {
          logger('info', 'youtube', `No valid tracks parsed from playlist ${playlistId}.`)
          return { loadType: 'empty', data: {} }
        }

        let playlistTitle = 'Unknown Playlist'
        try {
          playlistTitle =
            type === 'ytmusic'
              ? contentsRoot.header.musicQueueHeaderRenderer.subtitle.runs[0].text
              : contentsRoot.playlist?.playlist?.title
        } catch (_) {}

        logger(
          'info',
          'youtube',
          `Loaded playlist "${playlistTitle}" with ${tracks.length} tracks.`
        )

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: playlistTitle,
              selectedTrack
            },
            pluginInfo: {},
            tracks
          }
        }
      }

      default:
        logger('warn', 'youtube', `Unknown URL type for: ${url}`)
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'youtube',
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    this._switchClient('IOS')

    const {
      body: playerResponse,
      error,
      statusCode
    } = await makeRequest(this._getBaseUrl(sourceName, 'youtubei/v1/player'), {
      method: 'POST',
      headers: { 'User-Agent': this.ytContext.client.userAgent },
      body: {
        context: this.ytContext,
        videoId: decodedTrack.identifier,
        contentCheckOk: true,
        racyCheckOk: true
      },
      disableBodyCompression: true
    })

    if (error || statusCode !== 200) {
      const message =
        error?.message || `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', 'youtube', message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }

    if (playerResponse.error) {
      logger(
        'error',
        'youtube',
        `API error for stream ${decodedTrack.identifier}: ${playerResponse.error.message}`
      )
      return {
        exception: { message: playerResponse.error.message, severity: 'fault', cause: 'Upstream' }
      }
    }

    if (playerResponse.playabilityStatus?.status !== 'OK') {
      const message =
        playerResponse.playabilityStatus?.reason ||
        playerResponse.playabilityStatus?.messages?.[0] ||
        'Track not playable for streaming.'
      logger(
        'warn',
        'youtube',
        `Track ${decodedTrack.identifier} not playable for streaming: ${message}`
      )
      return { exception: { message, severity: 'common', cause: 'UpstreamPlayability' } }
    }

    const streamingData = playerResponse.streamingData
    if (!streamingData) {
      logger('error', 'youtube', `No streaming data found for ${decodedTrack.identifier}`)
      return {
        exception: {
          message: 'No streaming data available.',
          severity: 'common',
          cause: 'UpstreamNoStream'
        }
      }
    }

    const qualityPriority = {
      high: [251],
      medium: [250],
      low: [249],
      lowest: [249]
    }
    const targetItags = qualityPriority[this.config.audio.quality || 'high']

    let audioFormat = null
    if (streamingData.adaptiveFormats) {
      for (const itag of targetItags) {
        audioFormat = streamingData.adaptiveFormats.find(f => f.itag === itag && f.url)
        if (audioFormat) break
      }
      if (!audioFormat) {
        audioFormat = streamingData.adaptiveFormats.find(
          f => f.mimeType?.startsWith('audio/') && f.url
        )
      }
    }

    if (audioFormat?.url && !decodedTrack.isStream) {
      let streamUrl = audioFormat.url
      streamUrl += `&rn=1&cpn=${generateRandomLetters(16)}&ratebypass=yes&range=0-`

      logger(
        'debug',
        'youtube',
        `Found direct audio stream for ${decodedTrack.identifier}: ${audioFormat.mimeType}`
      )
      return {
        url: streamUrl,
        protocol: 'http',
        format: audioFormat.mimeType.includes('opus') ? 'webm/opus' : 'arbitrary'
      }
    }

    if (streamingData.hlsManifestUrl) {
      logger('debug', 'youtube', `Using HLS manifest for ${decodedTrack.identifier}`)
      return {
        url: streamingData.hlsManifestUrl,
        protocol: 'hls',
        format: 'arbitrary'
      }
    }

    logger(
      'error',
      'youtube',
      `No suitable audio stream or HLS manifest found for ${decodedTrack.identifier}`
    )
    return {
      exception: {
        message: 'No suitable audio stream found.',
        severity: 'common',
        cause: 'Upstream'
      }
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    logger(
      'debug',
      'youtube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )
    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        loadHLSPlaylist(url, stream)
        return { stream }
      }

      if (!url) throw new Error('No direct URL')
      const response = await http1makeRequest(url, { method: 'GET', streamOnly: true })
      if (response.statusCode !== 200) throw new Error(`HTTP status ${response.statusCode}`)
      const stream = new PassThrough()

      response.stream.on('data', chunk => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', error => {
        stream.emit('finishBuffering')
      })
      return { stream }
    } catch (e) {
      logger(
        'error',
        'youtube',
        `Error loading stream for ${decodedTrack.identifier}: ${e.message}`
      )
      return { exception: { message: e.message, severity: 'fault', cause: 'Upstream' } }
    }
  }
}
