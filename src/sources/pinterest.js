import { PassThrough } from 'node:stream'
import { encodeTrack, logger, http1makeRequest } from '../utils.js'

export default class PinterestSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/(?:[^/]+\.)?pinterest\.(?:com|fr|de|ch|jp|cl|ca|it|co\.uk|nz|ru|com\.au|at|pt|co\.kr|es|com\.mx|dk|ph|th|com\.uy|co|nl|info|kr|ie|vn|com\.vn|ec|mx|in|pe|co\.at|hu|co\.in|co\.nz|id|com\.ec|com\.py|tw|be|uk|com\.bo|com\.pe)\/pin\/(?:[\w-]+--)?(\d+)/i
    ]
    this.priority = 100
  }

  async setup() {
    return true
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    const videoId = match[1]
    try {
      const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(JSON.stringify({
        options: {
          field_set_key: 'unauth_react_main_pin',
          id: videoId
        }
      }))}`

      const { body, statusCode } = await http1makeRequest(apiUrl, {
        headers: { 'X-Pinterest-PWS-Handler': 'www/[username].js' }
      })

      if (statusCode !== 200 || !body.resource_response?.data) {
        return { loadType: 'empty', data: {} }
      }

      const data = body.resource_response.data
      const videoList = data.videos?.video_list || (data.story_pin_data?.pages?.[0]?.blocks?.find(b => b.video?.video_list)?.video?.video_list)

      if (!videoList) return { loadType: 'empty', data: {} }

      const bestFormat = videoList.V_720P || videoList.V_540P || videoList.V_360P || Object.values(videoList)[0]
      const artwork = data.images?.orig?.url || Object.values(data.images || {})[0]?.url

      const trackInfo = {
        identifier: videoId,
        isSeekable: true,
        author: data.closeup_attribution?.full_name || data.pinner?.full_name || 'Unknown Artist',
        length: Math.round(bestFormat.duration) || 0,
        isStream: false,
        position: 0,
        title: data.title || data.grid_title || 'Pinterest Video',
        uri: `https://www.pinterest.com/pin/${videoId}/`,
        artworkUrl: artwork || null,
        isrc: null,
        sourceName: 'pinterest'
      }

      return {
        loadType: 'track',
        data: { encoded: encodeTrack(trackInfo), info: trackInfo }
      }
    } catch (e) {
      logger('error', 'Pinterest', `Resolution failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    const videoId = decodedTrack.identifier
    try {
      const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?data=${encodeURIComponent(JSON.stringify({
        options: {
          field_set_key: 'unauth_react_main_pin',
          id: videoId
        }
      }))}`

      const { body, statusCode } = await http1makeRequest(apiUrl, {
        headers: { 'X-Pinterest-PWS-Handler': 'www/[username].js' }
      })

      if (statusCode !== 200 || !body.resource_response?.data) {
        throw new Error('Failed to fetch Pinterest video URL')
      }

      const data = body.resource_response.data
      const videoList = data.videos?.video_list || (data.story_pin_data?.pages?.[0]?.blocks?.find(b => b.video?.video_list)?.video?.video_list)
      
      const format = videoList?.V_720P || videoList?.V_540P || videoList?.V_360P || Object.values(videoList || {}).find(v => v.url?.endsWith('.mp4'))

      if (!format?.url) throw new Error('No MP4 format found for Pinterest video')

      return { url: format.url, protocol: 'http', format: 'mp4' }
    } catch (e) {
      logger('error', 'Pinterest', `Failed to get track URL: ${e.message}`)
      throw e
    }
  }

  async loadStream(decodedTrack, url) {
    try {
      const options = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
          Accept: '*/*'
        }
      }

      const response = await http1makeRequest(url, options)

      if (response.error || !response.stream) {
        throw response.error || new Error('Failed to get stream, no stream object returned.')
      }

      const stream = new PassThrough()

      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', (error) => {
        logger('error', 'Pinterest', `Upstream stream error: ${error.message}`)
        stream.emit('error', error)
        stream.emit('finishBuffering')
      })

      return { stream, type: 'mp4' }
    } catch (e) {
      logger('error', 'Pinterest', `Failed to load stream: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}