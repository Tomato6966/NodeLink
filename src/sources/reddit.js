import { encodeTrack, makeRequest, logger } from '../utils.js'
import { PassThrough } from 'node:stream'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'
const REDDIT_BASE = 'https://www.reddit.com'
const COMMENTS_REGEX = /\/comments\/([^/?]+)/
const VIDEO_REGEX = /\/video\/([^/?]+)/
const SHARE_REGEX = /\/r\/([^/]+)\/s\/([^/?]+)/

async function resolveRedirectingUrl(url, headers) {
  const res = await makeRequest(url, { method: 'HEAD', headers })
  const location = res?.headers?.location
  if (!location) return null

  const finalUrl = new URL(location, url).toString()
  const match = COMMENTS_REGEX.exec(finalUrl)
  return match ? match[1] : null
}

export default class RedditSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/,
      /^https?:\/\/(?:www\.)?reddit\.com\/video\/[^/]+/,
      /^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/s\/[^/]+/
    ]
    this.priority = 65
  }

  async setup() {
    return true
  }

  isLinkMatch(link) {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  async search() {
    return {
      exception: {
        message: 'Search not supported for Reddit',
        severity: 'common'
      }
    }
  }

  async resolve(url) {
    const params = this._parseUrl(url)
    const result = await this._getRedditTrack(params)

    if (result.error) {
      return {
        exception: { message: result.error, severity: 'fault' }
      }
    }

    const track = this._buildTrack({
      identifier: params.id || params.shortId || params.shareId,
      title: result.title || 'Reddit Video',
      author: result.author || params.sub || 'Reddit',
      uri: url,
      length: result.duration || -1,
      isSeekable: true,
      isStream: false,
      artworkUrl: result.thumbnail,
      pluginInfo: result
    })

    return { loadType: 'track', data: track }
  }

  _parseUrl(url) {
    let match = VIDEO_REGEX.exec(url)
    if (match) return { shortId: match[1] }

    match = COMMENTS_REGEX.exec(url)
    if (match) return { id: match[1] }

    match = SHARE_REGEX.exec(url)
    if (match) return { sub: match[1], shareId: match[2] }

    return {}
  }

  async _getRedditTrack(params) {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' }
    let currentParams = { ...params }

    if (currentParams.shortId) {
      const id = await resolveRedirectingUrl(
        `${REDDIT_BASE}/video/${currentParams.shortId}`,
        headers
      )
      if (id) currentParams = { id }
    }

    if (!currentParams.id && currentParams.shareId) {
      const id = await resolveRedirectingUrl(
        `${REDDIT_BASE}/r/${currentParams.sub}/s/${currentParams.shareId}`,
        headers
      )
      if (id) currentParams = { ...currentParams, id }
    }

    if (!currentParams.id) return { error: 'fetch.short_link' }

    const res = await makeRequest(
      `${REDDIT_BASE}/comments/${currentParams.id}.json`,
      { method: 'GET', headers }
    )

    if (res.error || res.statusCode !== 200 || !Array.isArray(res.body)) {
      return { error: 'fetch.fail' }
    }

    const data = res.body[0]?.data?.children?.[0]?.data
    if (!data) return { error: 'fetch.fail' }

    const sourceId = currentParams.sub
      ? `${currentParams.sub.toLowerCase()}_${currentParams.id}`
      : currentParams.id

    // Handle GIF redirects
    if (data.url?.endsWith('.gif')) return { error: 'gifs are not supported' }

    const redditVideo = data.secure_media?.reddit_video
    if (!redditVideo) return { error: 'fetch.empty' }

    const video = redditVideo.fallback_url?.split('?')[0]
    if (!video) return { error: 'fetch.empty' }

    const audioUrl = await this._findAudioUrl(video)
    const commonData = {
      title: data.title || 'Reddit Video',
      author: `u/${data.author}` || 'Reddit',
      thumbnail:
        data.thumbnail || data.preview?.images?.[0]?.source?.url || null,
      duration: (redditVideo.duration || 0) * 1000
    }

    if (!audioUrl) {
      return {
        typeId: 'redirect',
        urls: video,
        ...commonData
      }
    }

    return {
      typeId: 'tunnel',
      type: 'merge',
      urls: [video, audioUrl],
      audioFilename: `reddit_${sourceId}_audio`,
      filename: `reddit_${sourceId}.mp4`,
      ...commonData
    }
  }

  async _findAudioUrl(videoUrl) {
    const baseUrl = videoUrl.split('_')[0]
    const audioVariants = [
      videoUrl.includes('.mp4')
        ? `${baseUrl}_audio.mp4`
        : `${videoUrl.split('DASH')[0]}audio`,
      `${baseUrl}_AUDIO_128.mp4`,
      `${baseUrl}_audio.mp3`,
      `${baseUrl}_AUDIO_128.mp3`
    ]

    for (const audioUrl of audioVariants) {
      const res = await makeRequest(audioUrl, { method: 'HEAD' })
      if (res.statusCode === 200) return audioUrl
    }

    return null
  }

  _buildTrack(partialInfo) {
    const track = {
      identifier: partialInfo.identifier,
      isSeekable: false,
      author: partialInfo.author,
      length: partialInfo.length,
      isStream: partialInfo.isStream,
      position: 0,
      title: partialInfo.title,
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: null,
      sourceName: 'reddit'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: partialInfo.pluginInfo || {}
    }
  }

  async getTrackUrl(track) {
    const params = this._parseUrl(track.uri)
    const result = await this._getRedditTrack(params)

    if (result.error) {
      return { exception: { message: result.error, severity: 'fault' } }
    }

    const url = result.typeId === 'tunnel' ? result.urls[1] : result.urls
    const format = result.typeId === 'tunnel' ? 'mp3' : 'mp4'

    return { url, protocol: 'https', format }
  }
  async loadStream(decodedTrack, url) {
    logger(
      'debug',
      'Sources',
      `Loading Reddit stream for "${decodedTrack.title}"`
    )
    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      const type = url.endsWith('.mp3') ? 'mp3' : 'mp4'
      return { stream, type }
    } catch (err) {
      logger('error', 'Sources', `Failed to load Reddit stream: ${err.message}`)
      return {
        exception: {
          message: err.message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }
}
