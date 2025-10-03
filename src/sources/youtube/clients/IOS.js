import { logger, makeRequest } from '../../../utils.js'
import {
  BaseClient,
  YOUTUBE_CONSTANTS,
  buildTrack,
  checkURLType
} from '../common.js'

export default class IOS extends BaseClient {
  constructor(nodelink) {
    super(nodelink, 'IOS')
  }

  getClient(context) {
    return {
      ...context.client,
      clientName: 'IOS',
      clientVersion: '19.47.7',
      userAgent:
        'com.google.ios.youtube/19.47.7 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '17.5.1.21F90',
      utcOffsetMinutes: 0
    }
  }

  requirePlayerScript() {
    return false
  }

  async search(query, type, context) {
    const webClient = this.nodelink.sources.clients.Web
    if (webClient) {
      return webClient.search(query, type, context)
    }
    return { loadType: 'empty', data: {} }
  }

  async resolve(url, type, context, cipherManager) {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = 'https://youtubei.googleapis.com'

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger(
            'error',
            'youtube-ios',
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

        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(videoId, context, {}, cipherManager)

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'youtube-ios', message)
          return {
            loadType: 'error',
            data: { message, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger(
            'error',
            'youtube-ios',
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

        const { body: playlistResponse, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: { 'User-Agent': this.getClient(context).userAgent },
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

        if (statusCode !== 200) {
          const errMsg = `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            'youtube-ios',
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
          sourceName
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'youtube-ios',
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      {},
      cipherManager
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', 'youtube-ios', message)
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
