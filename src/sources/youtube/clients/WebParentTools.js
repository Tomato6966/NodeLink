import { makeRequest } from '../../../utils.ts'
import { BaseClient, checkURLType, YOUTUBE_CONSTANTS } from '../common.js'

export default class WebParentTools extends BaseClient {
  constructor(nodelink, oauth) {
    super(nodelink, 'WEB_PARENT_TOOLS', oauth)
  }

  getClient(context) {
    return {
      client: {
        clientName: 'WEB_PARENT_TOOLS',
        clientVersion: '1.20220918',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36,gzip(gfe)'
      },
      thirdParty: {
        embedUrl: 'https://www.youtube.com/'
      }
    }
  }

  async resolve(url, _type, context, cipherManager) {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          return {
            exception: {
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
          return {
            exception: {
              message: `Failed to load video data. Status: ${statusCode}`,
              severity: 'common',
              cause: 'Upstream'
            }
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

  async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      {},
      cipherManager,
      proxy
    )

    if (statusCode !== 200) {
      return {
        exception: {
          message: `Failed to get player data. Status: ${statusCode}`,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager,
      itag
    )
  }

  requirePlayerScript() {
    return true
  }

  async _makePlayerRequest(videoId, context, headers, cipherManager, proxy) {
    const requestBody = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }

    if (this.requirePlayerScript() && cipherManager) {
      const playerScript = await cipherManager.getCachedPlayerScript()
      if (playerScript?.url) {
        const signatureTimestamp = await cipherManager.getTimestamp(
          playerScript.url
        )
        requestBody.playbackContext = {
          contentPlaybackContext: {
            signatureTimestamp
          }
        }
      }
    }

    const response = await makeRequest(
      'https://www.youtube.com/youtubei/v1/player',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getClient(context).client.userAgent,
          'X-YouTube-Client-Name': '88',
          'X-YouTube-Client-Version': '1.20220918',
          'X-Goog-Visitor-Id': context.client.visitorData,
          Origin: 'https://www.youtube.com',
          Referer: 'https://www.youtube.com/',
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true,
        proxy: proxy || this.getProxy()
      }
    )

    return response
  }
}
