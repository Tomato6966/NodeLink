import {
  encodeTrack,
  generateRandomLetters,
  logger,
  makeRequest
} from '../../utils.js'

export const YOUTUBE_CONSTANTS = {
  VIDEO: 0,
  PLAYLIST: 1,
  SHORTS: 2,
  UNKNOWN: -1
}

export function checkURLType(url, type) {
  const source = type === 'ytmusic' ? 'music' : 'www'
  const videoRegex = new RegExp(
    `^https?://${source === 'music' ? 'music' : '(?:www\\.)?'}youtube\.com/watch\\?v=[\\w-]+`
  )
  const playlistRegex = new RegExp(
    `^https?://${source === 'music' ? 'music' : '(?:www\\.)?'}youtube\.com/playlist\\?list=[\\w-]+`
  )
  const shortUrlRegex = /^https?:\/\/youtu\.be\/[\w-]+/
  const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/

  if (
    playlistRegex.test(url) ||
    (videoRegex.test(url) && url.includes('&list='))
  ) {
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

export function buildTrack(
  itemData,
  itemType,
  sourceNameOverride = null,
  fullApiResponse = null
) {
  let videoId
  let title
  let author
  let lengthMs = 0
  let isStream = true
  let artworkUrl
  let uri

  const getItemValue = (obj, paths, defaultValue = null) => {
    for (const path of paths) {
      const value = path.split('.').reduce((o, k) => o?.[k], obj)
      if (value !== undefined && value !== null) return value
    }
    return defaultValue
  }

  const getRunsText = (runsArray, defaultValue = 'Unknown') => {
    if (Array.isArray(runsArray) && runsArray.length > 0) {
      return runsArray.map((run) => run.text).join('')
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
      [
        'playlistItemData.videoId',
        'navigationEndpoint.watchEndpoint.videoId',
        'videoId'
      ],
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
      if (!Number.isFinite(lengthMs)) {
        lengthMs = 0
        isStream = true
      } else {
        isStream = false
      }
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
        getItemValue(renderer, [
          'longBylineText.runs',
          'shortBylineText.runs',
          'ownerText.runs'
        ]),
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
      if (!Number.isFinite(lengthMs)) {
        lengthMs = 0
        isStream = true
      } else {
        isStream = false
      }
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
    sourceName:
      sourceNameOverride || (itemType === 'ytmusic' ? 'ytmusic' : 'youtube')
  }

  return {
    encoded: encodeTrack(trackInfo),
    info: trackInfo,
    pluginInfo: {
      captions: fullApiResponse?.captions
    }
  }
}

export class BaseClient {
  constructor(nodelink, name, oauth) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.name = name
    this.oauth = oauth
  }

  getClient() {
    throw new Error('Not implemented')
  }

  requirePlayerScript() {
    return false
  }

  getApiEndpoint() {
    return 'https://youtubei.googleapis.com'
  }

  getPlayerParams() {
    return null
  }

  isEmbedded() {
    return false
  }

  async getAuthHeaders() {
    return {}
  }

  async search(query, type) {
    return { loadType: 'empty', data: {} }
  }

  async _makePlayerRequest(videoId, context, headers, cipherManager) {
    const apiEndpoint = this.getApiEndpoint()
    const requestBody = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }

    const playerParams = this.getPlayerParams()
    if (playerParams) {
      requestBody.params = playerParams
    }

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const playerScript = await cipherManager.getCachedPlayerScript()
        const signatureTimestamp = await cipherManager.getTimestamp(
          playerScript.url
        )
        requestBody.playbackContext = {
          contentPlaybackContext: {
            signatureTimestamp: signatureTimestamp
          }
        }
      } catch (e) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to get signature timestamp for player request: ${e.message}`
        )
      }
    }
    const response = await makeRequest(`${apiEndpoint}/youtubei/v1/player?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'User-Agent': this.getClient(context).client.userAgent,
        ...(this.getClient(context).client.visitorData
          ? { 'X-Goog-Visitor-Id': this.getClient(context).client.visitorData }
          : {}),
        ...(this.isEmbedded() ? { Referer: 'https://www.youtube.com' } : {}),
        ...headers
      },
      body: requestBody,
      disableBodyCompression: true
    })
    if (response.statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${response.statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }
    return response
  }

  async _handlePlayerResponse(playerResponse, sourceName, videoId, context) {
    if (playerResponse.error) {
      logger(
        'error',
        `youtube-${this.name}`,
        `API error for video/short ${videoId}: ${playerResponse.error.message}`
      )
      return {
        loadType: 'error',
        data: {
          message: playerResponse.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    if (playerResponse.playabilityStatus?.status !== 'OK') {
      const message =
        playerResponse.playabilityStatus?.reason || 'Video not playable.'
      logger(
        'warn',
        `youtube-${this.name}`,
        `Video/short ${videoId} not playable: ${message}`
      )
      return {
        loadType: 'error',
        data: { message, severity: 'common', cause: 'UpstreamPlayability' }
      }
    }

    logger('debug', `youtube-${this.name}`, `Player response for ${videoId}: ${JSON.stringify(playerResponse, null, 2)}`)

    const track = buildTrack(
      playerResponse.videoDetails,
      sourceName,
      null,
      playerResponse
    )
    if (!track) {
      return {
        loadType: 'error',
        data: {
          message: 'Failed to process video data.',
          severity: 'fault',
          cause: 'Internal'
        }
      }
    }
    return { loadType: 'track', data: track }
  }

  async _handlePlaylistResponse(
    playlistId,
    currentVideoId,
    playlistResponse,
    sourceName,
    context
  ) {
    if (playlistResponse?.error) {
      const errMsg =
        playlistResponse?.error?.message || 'Failed to fetch playlist.'
      logger(
        'error',
        `youtube-${this.name}`,
        `Error loading playlist ${playlistId}: ${errMsg}`
      )
      return {
        loadType: 'error',
        data: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contentsRoot = playlistResponse.contents.singleColumnWatchNextResults
    const playlistContent = contentsRoot?.playlist?.playlist?.contents

    if (!playlistContent || playlistContent.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `Playlist ${playlistId} is empty or inaccessible.`
      )
      return { loadType: 'empty', data: {} }
    }

    const tracks = []
    let selectedTrack = 0
    const maxLength = this.config.maxAlbumPlaylistLength || 100

    for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
      const item = playlistContent[i]
      const track = buildTrack(item, 'youtube')
      if (track) {
        tracks.push(track)
        if (currentVideoId && track.info.identifier === currentVideoId) {
          selectedTrack = i
        }
      }
    }

    if (tracks.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `No valid tracks parsed from playlist ${playlistId}.`
      )
      return { loadType: 'empty', data: {} }
    }

    const playlistTitle =
      contentsRoot.playlist?.playlist?.title || 'Unknown Playlist'

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack },
        pluginInfo: {},
        tracks
      }
    }
  }

  async _extractStreamData(
    playerResponse,
    decodedTrack,
    context,
    cipherManager
  ) {
    const streamingData = playerResponse.streamingData

    if (!streamingData) {
      logger(
        'error',
        `youtube-${this.name}`,
        `No streaming data found for ${decodedTrack.identifier}`
      )
      return {
        exception: {
          message: 'No streaming data available.',
          severity: 'common',
          cause: 'UpstreamNoStream'
        }
      }
    }

    const qualityPriority = this._getQualityPriority()
    const targetItags = qualityPriority[this.config.audio.quality || 'high']

    const allFormats = [
      ...(streamingData.adaptiveFormats || []),
      ...(streamingData.formats || [])
    ]

    const filteredFormats = allFormats.filter(format => targetItags.includes(format.itag))

    if (this.requirePlayerScript()) {
      const playerScript = await cipherManager.getCachedPlayerScript()

      for (const format of filteredFormats) {
        let currentStreamUrl = format.url
        let currentEncryptedSignature = undefined
        let currentNParam = undefined
        let currentSignatureKey = undefined

        if (format.signatureCipher) {
          const cipher = new URLSearchParams(format.signatureCipher)
          currentStreamUrl = cipher.get('url')
          currentEncryptedSignature = cipher.get('s')
          currentSignatureKey = cipher.get('sp') || 'sig'
          currentNParam = cipher.get('n')
        }

        if (currentStreamUrl) {
          try {
            const decipheredUrl = await cipherManager.resolveUrl(
              currentStreamUrl,
              currentEncryptedSignature,
              currentNParam,
              currentSignatureKey,
              playerScript,
              context
            )
            format.url = decipheredUrl
          } catch (e) {
            logger(
              'warn',
              `youtube-${this.name}`,
              `Failed to resolve format URL for itag ${format.itag}: ${e.message}`
            )
          }
        }
      }
    }

    let audioFormat = null
    if (filteredFormats.length > 0) {
      audioFormat = filteredFormats[0] // Pick the first one after filtering
    }

    const directUrl = audioFormat?.url && !decodedTrack.isStream ? audioFormat.url : undefined

    if (!directUrl && !streamingData.hlsManifestUrl) {
      logger(
        'debug',
        `youtube-${this.name}`,
        `No suitable audio stream found. Available streamingData: ${JSON.stringify(streamingData)}`
      )
      return {
        exception: {
          message: 'No suitable audio stream found.',
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    return {
      url: directUrl,
      protocol: directUrl ? 'http' : null,
      format: directUrl
        ? audioFormat.mimeType.includes('opus')
          ? 'webm/opus'
          : 'mpegts'
        : null,
      hlsUrl: streamingData.hlsManifestUrl || null
    }
  }

  _getQualityPriority() {
    return { high: [251], medium: [250], low: [249], lowest: [249] }
  }

  async resolve(url, type, context, cipherManager) {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|ossovershorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
            `Could not parse video ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            data: {
              message: 'Invalid video URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }
        const videoId = videoIdMatch[1]

        const headers = this.oauth ? await this.getAuthHeaders() : {}
        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(
            videoId,
            context,
            headers,
            cipherManager
          )

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', `youtube-${this.name}`, message)
          return {
            loadType: 'error',
            data: { message, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId,
          context
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
            `Could not parse playlist ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            data: {
              message: 'Invalid playlist URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }

        const playlistId = playlistIdMatch[1]
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
        const currentVideoId = videoIdMatch?.[1] ?? null

        const headers = this.oauth ? await this.getAuthHeaders() : {}
        const { body: playlistResponse, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: {
              'User-Agent': this.getClient(context).userAgent,
              ...headers
            },
            body: {
              context: { client: this.getClient(context) },
              playlistId,
              contentCheckOk: true,
              racyCheckOk: true
            },
            method: 'POST',
            disableBodyCompression: true
          }
        )

        if (statusCode !== 200 || playlistResponse?.error) {
          const errMsg =
            playlistResponse?.error?.message ||
            `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            `youtube-${this.name}`,
            `Error loading playlist ${playlistId}: ${errMsg}`
          )
          return {
            loadType: 'error',
            data: { message: errMsg, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          playlistResponse,
          sourceName,
          context
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    const apiEndpoint = this.getApiEndpoint()
    logger(
      'debug',
      `youtube-${this.name}`,
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const headers = this.oauth ? await this.getAuthHeaders() : {}
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager
    )
  }
}
