import { logger, makeRequest } from '../../../utils.js'
import {
  BaseClient,
  YOUTUBE_CONSTANTS,
  buildTrack,
  checkURLType
} from '../common.js'

export default class Music extends BaseClient {
  constructor(nodelink, oauth) {
    super(nodelink, 'ANDROID_MUSIC', oauth)
  }

  getClient(context) {
    return {
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '8.47.54',
        userAgent:
          'com.google.android.apps.youtube.music/8.47.54 (Linux; U; Android 14 gzip)',
        deviceMake: 'Google',
        deviceModel: 'Pixel 6',
        osName: 'Android',
        osVersion: '14',
        androidSdkVersion: '30',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  async search(query, type, context) {
    const sourceName = 'ytmusic'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params: 'EgWKAQIIAWoQEAMQBBAJEAoQBRAREBAQFQ%3D%3D'
    }

    const {
      body: searchResult,
      error,
      statusCode
    } = await makeRequest('https://music.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: {
        'User-Agent': this.getClient(context).client.userAgent,
        'X-Goog-Api-Format-Version': '2'
      },
      body: requestBody,
      disableBodyCompression: true
    })

    if (error || statusCode !== 200) {
      const message =
        error?.message ||
        `Failed to load results from ${sourceName}. Status: ${statusCode}`
      logger('error', 'YouTube-Music', message)
      return {
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }
    if (searchResult.error) {
      logger(
        'error',
        'YouTube-Music',
        `Error from ${sourceName} search API: ${searchResult.error.message}`
      )
      return {
        exception: {
          message: searchResult.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }

    const tabContent = searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
    
    let loggedVideoData = false
    const tracks = []
    let videos = null

    const findShelf = (contents) => {
      if (!Array.isArray(contents)) return null
      for (const section of contents) {
        if (section.musicShelfRenderer) {
          return section.musicShelfRenderer.contents
        }
      }
      return null
    }

    if (tabContent?.sectionListRenderer) {
      videos = findShelf(tabContent.sectionListRenderer.contents)
    }

    if (!videos && tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer) {
      videos = findShelf(tabContent.musicSplitViewRenderer.mainContent.sectionListRenderer.contents)
    }
    
    if (!videos || videos.length === 0) {
      logger(
        'debug',
        'YouTube-Music',
        `No matches found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    for (const video of videos) {
      const renderer = video.musicResponsiveListItemRenderer || video.musicTwoColumnItemRenderer
      if (!renderer) {
        continue
      }

      const track = await buildTrack(video, 'ytmusic', 'ytmusic', searchResult)
      if (track) {
        tracks.push(track)
      }
    }

    return { loadType: 'search', data: tracks }
  }

  async resolve(url, type, context, cipherManager) {
    const sourceName = 'ytmusic'
    const urlType = checkURLType(url, sourceName)
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger(
            'error',
            'YouTube-Music',
            `Could not parse video ID from URL: ${url}`
          )
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
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', 'YouTube-Music', message)
          return {
            exception: { message, severity: 'common', cause: 'Upstream' }
          }
        }
        
        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        return {
          exception: {
            message: 'Music client does not support playlists',
            severity: 'common',
            cause: 'UpstreamPlayability'
          }
        }
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    return {
      exception: {
        message: 'Music client does not provide direct track URLs.',
        severity: 'common'
      }
    }
  }
}
