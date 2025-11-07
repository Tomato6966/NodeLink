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
        clientVersion: '7.27.52',
        userAgent:
          'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14 gzip)',
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
    const tracks = []
    let videos =
      searchResult.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content?.musicSplitViewRenderer?.mainContent?.sectionListRenderer
        ?.contents?.[0]?.musicShelfRenderer?.contents

    if (!videos || videos.length === 0) {
      logger(
        'debug',
        'YouTube-Music',
        `No matches found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    const maxResults = this.config.maxSearchResults || 10
    if (videos.length > maxResults) {
      let count = 0
      videos = videos.filter((video) => {
        const isValid = video.musicTwoColumnItemRenderer
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
        'YouTube-Music',
        `No processable tracks found on ${sourceName} for: ${query}`
      )
      return { loadType: 'empty', data: {} }
    }

    return { loadType: 'search', data: tracks }
  }

  async resolve(url, type, context) {
    return { loadType: 'empty', data: {} }
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
