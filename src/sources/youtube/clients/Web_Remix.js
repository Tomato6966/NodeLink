import { logger, makeRequest } from '../../../utils.js'
import {
  BaseClient,
  buildTrack,
  checkURLType,
  YOUTUBE_CONSTANTS
} from '../common.js'

export default class Music extends BaseClient {
  constructor(nodelink, oauth) {
    super(nodelink, 'WEB_REMIX', oauth)
  }

  getClient(context) {
    return {
      client: {
        clientName: 'WEB_REMIX',
        clientVersion: '1.20260121.03.00',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  async search(query, type, context) {
    const sourceName = 'ytmusic'

    let params = 'EgWKAQIIAWoQEAMQBBAFEBAQCRAKEBUQEQ%3D%3D' // Default (Tracks)
    if (type === 'playlist') params = 'EgeKAQQoAEABahAQAxAEEAUQEBAJEAoQFRAR'
    if (type === 'album') params = 'EgWKAQIYAWoQEAMQBBAFEBAQCRAKEBUQEQ%3D%3D'
    if (type === 'artist') params = 'EgWKAQIgAWoQEAMQBBAFEBAQCRAKEBUQEQ%3D%3D'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params
    }

    const {
      body: searchResult,
      error,
      statusCode
    } = await makeRequest('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
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

    const tabContent =
      searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content
    const _loggedVideoData = false
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

    if (
      !videos &&
      tabContent?.musicSplitViewRenderer?.mainContent?.sectionListRenderer
    ) {
      videos = findShelf(
        tabContent.musicSplitViewRenderer.mainContent.sectionListRenderer
          .contents
      )
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
      const renderer =
        video.musicResponsiveListItemRenderer ||
        video.musicTwoColumnItemRenderer
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

  async resolve(url, _type, context, cipherManager) {
    const sourceName = 'ytmusic'
    const urlType = checkURLType(url, sourceName)
    const _apiEndpoint = this.getApiEndpoint()

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
        const listIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!listIdMatch || !listIdMatch[1]) {
          return { loadType: 'empty', data: {} }
        }
        const playlistId = listIdMatch[1]

        const body = {
          context: this.getClient(context),
          playlistId,
          enablePersistentPlaylistPanel: true,
          isAudioOnly: true
        }

        const { body: res, statusCode } = await makeRequest(
          'https://music.youtube.com/youtubei/v1/next',
          {
            method: 'POST',
            body,
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              'X-Goog-Api-Format-Version': '2'
            },
            disableBodyCompression: true
          }
        )

        if (statusCode !== 200 || !res) {
          return { loadType: 'empty', data: {} }
        }

        return await this._handlePlaylistResponse(
          playlistId,
          null,
          res,
          sourceName,
          context
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(_decodedTrack, _context, _cipherManager) {
    return {
      exception: {
        message: 'Music client does not provide direct track URLs.',
        severity: 'common'
      }
    }
  }
}
