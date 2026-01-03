import { logger, makeRequest } from '../../../utils.js'
import {
  BaseClient,
  YOUTUBE_CONSTANTS,
  buildTrack,
  checkURLType
} from '../common.js'

export default class AndroidVR extends BaseClient {
  constructor(nodelink, oauth, youtubeInstance) {
    super(nodelink, 'ANDROID_VR', oauth, youtubeInstance)
  }

  getClient(context) {
    return {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.71.26',
        userAgent:
          'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 15; eureka-user Build/AP4A.250205.002) gzip',
        deviceMake: 'Google',
        osName: 'Android',
        osVersion: '15',
        androidSdkVersion: '35',
        hl: context.client.hl,
        gl: context.client.gl,
        visitorData: context.client.visitorData
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  requirePlayerScript() {
    return false
  }

  async search(query, type, context) {
    const sourceName = 'youtube'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params: 'EgIQAQ%3D%3D'
    }

    try {
      const {
        body: searchResult,
        error,
        statusCode
      } = await makeRequest(
        'https://youtubei.googleapis.com/youtubei/v1/search',
        {
          method: 'POST',
          headers: {
            'User-Agent': this.getClient(context).client.userAgent,
            'X-Goog-Api-Format-Version': '2'
          },
          body: requestBody,
          disableBodyCompression: true
        }
      )

      if (error || statusCode !== 200) {
        const message =
          error?.message ||
          `Failed to load results from ${sourceName}. Status: ${statusCode}`
        logger('error', 'YouTube-AndroidVR', message)
        return {
          exception: { message, severity: 'common', cause: 'Upstream' }
        }
      }

      if (!searchResult) {
        logger(
          'debug',
          'YouTube-AndroidVR',
          `Empty search result for '${query}'.`
        )
        return { loadType: 'empty', data: {} }
      }

      if (searchResult.error) {
        logger(
          'error',
          'YouTube-AndroidVR',
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

      const tracks = []
      const allSections = searchResult.contents?.sectionListRenderer?.contents
      const lastIdx = allSections?.length - 1
      let videos = allSections?.[lastIdx]?.itemSectionRenderer?.contents

      if (!videos || videos.length === 0) {
        logger(
          'debug',
          'YouTube-AndroidVR',
          `No matches found on ${sourceName} for: ${query}`
        )
        return { loadType: 'empty', data: {} }
      }

      const maxResults = this.config.maxSearchResults || 10
      if (videos.length > maxResults) {
        let count = 0
        videos = videos.filter((video) => {
          const isValid = video.videoRenderer || video.compactVideoRenderer
          if (isValid && count < maxResults) {
            count++
            return true
          }
          return false
        })
      }

      for (const videoData of videos) {
        const track = await buildTrack(
          videoData,
          sourceName,
          null,
          null,
          this.config.enableHoloTracks
        )
        if (track) {
          tracks.push(track)
        }
      }

      if (tracks.length === 0) {
        logger(
          'debug',
          'YouTube-AndroidVR',
          `No processable tracks found on ${sourceName} for: ${query}`
        )
        return { loadType: 'empty', data: {} }
      }

      return { loadType: 'search', data: tracks }
    } catch (e) {
      logger(
        'error',
        'YouTube-AndroidVR',
        `Exception during search for '${query}': ${e.message}`
      )
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
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
            'YouTube-AndroidVR',
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
          logger('error', 'YouTube-AndroidVR', message)
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
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/) // Corrected escaping for \

        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger(
            'error',
            'YouTube-AndroidVR',
            `Could not parse playlist ID from URL: ${url}`
          )
          return {
            exception: {
              message: 'Invalid playlist URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }

        const playlistId = playlistIdMatch[1]
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/) // Corrected escaping for \

        const currentVideoId = videoIdMatch?.[1] ?? null

        const requestBody = {
          context: this.getClient(context),
          playlistId,
          contentCheckOk: true,
          racyCheckOk: true
        }
        if (playlistId.startsWith('RD') && currentVideoId) {
          requestBody.videoId = currentVideoId
        }
        const { body: playlistResponse, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: { 'User-Agent': this.getClient(context).client.userAgent },
            body: requestBody,
            method: 'POST',
            disableBodyCompression: true
          }
        )

        if (statusCode !== 200) {
          const errMsg = `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            'YouTube-AndroidVR',
            `Error loading playlist ${playlistId}: ${errMsg}`
          )
          return {
            exception: {
              message: errMsg,
              severity: 'common',
              cause: 'Upstream'
            }
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

  async getTrackUrl(decodedTrack, context, cipherManager, itag) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'YouTube-AndroidVR',
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
      logger('error', 'YouTube-AndroidVR', message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager,
      itag
    )
  }
}
