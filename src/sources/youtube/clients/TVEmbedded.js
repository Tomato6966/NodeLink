import { logger } from '../../../utils.js'
import {
  BaseClient,
  YOUTUBE_CONSTANTS,
  buildTrack,
  checkURLType
} from '../common.js'

export default class TVEmbedded extends BaseClient {
  constructor(nodelink, oauth) {
    super(nodelink, 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', oauth)
  }

  getClient(context) {
    return {
      ...context.client,
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      userAgent: 'Mozilla/5.0 (TV; rv:10.0) Gecko/20100101 Firefox/10.0', // Added User-Agent
      thirdParty: {
        embedUrl: 'https://www.youtube.com'
      },
      clientScreen: 'EMBED'
    }
  }

  getPlayerParams() {
    return '2AMB'
  }

  isEmbedded() {
    return true
  }

  requirePlayerScript() {
    return true
  }

  async getAuthHeaders() {
    if (this.oauth) {
      const accessToken = await this.oauth.getAccessToken()
      if (accessToken) {
        return {
          Authorization: `Bearer ${accessToken}`
        }
      }
    }
    return {}
  }

  async resolve(url, type, context, cipherManager) {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger(
            'error',
            'youtube-tvembedded',
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

        const headers = await this.getAuthHeaders()
        const { body: playerResponse, statusCode } = await this._makePlayerRequest(
          videoId,
          context,
          headers,
          cipherManager
        )

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'youtube-tvembedded', message)
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

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'youtube-tvembedded',
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const headers = await this.getAuthHeaders()

    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', 'youtube-tvembedded', message)
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
