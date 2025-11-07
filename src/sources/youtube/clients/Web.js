import { logger, makeRequest } from '../../../utils.js'
import {
  BaseClient,
  YOUTUBE_CONSTANTS,
  buildTrack,
  checkURLType
} from '../common.js'

export default class Web extends BaseClient {
  constructor(nodelink, oauth) {
    super(nodelink, 'WEB', oauth)
  }

  getClient(context) {
    return {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20251030.01.00',
        platform: 'DESKTOP',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36,gzip(gfe)',
        hl: context.client.hl,
        gl: context.client.gl
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true }
    }
  }

  requirePlayerScript() {
    return true
  }

  async search(query, type, context) {
    const sourceName = 'youtube'

    const requestBody = {
      context: this.getClient(context),
      query: query,
      params: 'EgIQAQ%3D%3D'
    }

    const {
      body: searchResult,
      error,
      statusCode
    } = await makeRequest('https://www.youtube.com/youtubei/v1/search', {
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
      logger('error', 'YouTube-Web', message)
      return {
        exception: { message, severity: 'common', cause: 'Upstream' }
      }
    }
    if (searchResult.error) {
      logger(
        'error',
        'YouTube-Web',
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
        'YouTube-Web',
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
        'YouTube-Web',
        `No processable tracks found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    return { loadType: 'search', data: tracks }
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
            'youtube-web',
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
          logger('error', 'youtube-web', message)
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
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger(
            'error',
            'youtube-web',
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
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
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
            headers: {
              'User-Agent': this.getClient(context).client.userAgent,
              ...headers
            },
            body: requestBody,
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
            'youtube-web',
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

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    logger(
      'debug',
      'youtube-web',
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
      logger('error', 'youtube-web', message)
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
