import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

export default class TumblrSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/([^/?#&]+)\.tumblr\.com\/(?:post|video|([a-zA-Z\d-]+))\/(\d+)/i,
      /https?:\/\/(?:www\.)?tumblr\.com\/([^/]+)\/(\d+)/i
    ]
    this.priority = 60
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Tumblr source.')
    return true
  }

  _extractInfo(url) {
    for (const pattern of this.patterns) {
      const match = url.match(pattern)
      if (match) {
        if (match.length === 4) {
          return { blog: match[2] || match[1], id: match[3] }
        }
        return { blog: match[1], id: match[2] }
      }
    }
    return null
  }

  async resolve(url) {
    const info = this._extractInfo(url)
    if (!info) return { loadType: 'empty', data: {} }

    try {
      const { body: html, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': 'WhatsApp/2.0' }
      })

      if (statusCode !== 200) return { loadType: 'empty', data: {} }

      const initialStateMatch = html.match(/id="___INITIAL_STATE___">\s*({.*?})\s*<\/script>/)
      if (initialStateMatch) {
        try {
          const state = JSON.parse(initialStateMatch[1])
          const post = state.PeeprRoute?.initialTimeline?.objects?.find(obj => obj.objectType === 'post')
          
          if (post) {
            const videoContent = post.content?.find(c => c.type === 'video')
            const audioContent = post.content?.find(c => c.type === 'audio')
            const media = videoContent || audioContent

            if (media) {
              const directUrl = media.url || media.media?.url
              if (directUrl) {
                const trackInfo = {
                  identifier: post.idString || post.id,
                  isSeekable: true,
                  author: post.blogName || info.blog,
                  length: (post.duration || 0) * 1000,
                  isStream: false,
                  position: 0,
                  title: post.summary || 'Tumblr Content',
                  uri: post.postUrl || url,
                  artworkUrl: post.poster?.[0]?.url || post.thumbnail || null,
                  isrc: null,
                  sourceName: 'tumblr'
                }

                return {
                  loadType: 'track',
                  data: {
                    encoded: encodeTrack(trackInfo),
                    info: trackInfo,
                    pluginInfo: { directUrl }
                  }
                }
              }
            }
          }
        } catch (e) {
          logger('debug', 'Tumblr', `Failed to parse initial state: ${e.message}`)
        }
      }

      const youtubeMatch = html.match(/https?:\/\/(?:www\.)?youtube\.com\/embed\/([^"?]+)/) || 
                           html.match(/https?:\/\/www\.youtube\.com\/watch\?v=([^"&?]+)/)
      if (youtubeMatch) {
        return await this.nodelink.sources.resolve(`https://www.youtube.com/watch?v=${youtubeMatch[1]}`)
      }

      const vimeoMatch = html.match(/https?:\/\/player\.vimeo\.com\/video\/(\d+)/)
      if (vimeoMatch) {
        return await this.nodelink.sources.resolve(`https://vimeo.com/${vimeoMatch[1]}`)
      }

      const titleMatch = html.match(/<title data-rh="true">(.*?)<\/title>/i) || html.match(/<title>(.*?)<\/title>/i)
      const title = (titleMatch ? titleMatch[1].replace(' – @', ' by @').replace(' on Tumblr', '').trim() : 'Tumblr Content')
      
      const videoUrl = html.match(/<meta data-rh="" content="(.*?)" property="og:video"/i)?.[1] || 
                       html.match(/<meta property="og:video" content="(.*?)"/i)?.[1]

      if (videoUrl) {
        const trackInfo = {
          identifier: info.id,
          isSeekable: true,
          author: info.blog,
          length: 0,
          isStream: false,
          position: 0,
          title: title,
          uri: url,
          artworkUrl: html.match(/<meta property="og:image" content="(.*?)"/i)?.[1] || null,
          isrc: null,
          sourceName: 'tumblr'
        }

        return {
          loadType: 'track',
          data: { 
            encoded: encodeTrack(trackInfo), 
            info: trackInfo,
            pluginInfo: { directUrl: videoUrl }
          }
        }
      }

      logger('debug', 'Tumblr', `No native media or supported embed found in ${url}`)
      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Tumblr', `Resolution failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    if (decodedTrack.pluginInfo?.directUrl) {
      return { 
        url: decodedTrack.pluginInfo.directUrl, 
        protocol: 'https', 
        format: decodedTrack.pluginInfo.directUrl.includes('.mp3') ? 'mp3' : 'mp4' 
      }
    }

    const res = await this.resolve(decodedTrack.uri)
    if (res.loadType === 'track') {
      return { 
        url: res.data.pluginInfo.directUrl, 
        protocol: 'https', 
        format: res.data.pluginInfo.directUrl.includes('.mp3') ? 'mp3' : 'mp4' 
      }
    }

    throw new Error('Failed to extract Tumblr media URL')
  }

  async loadStream(_decodedTrack, url, _protocol, _additionalData) {
    try {
      const options = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.tumblr.com/'
        }
      }

      const response = await http1makeRequest(url, options)
      if (response.error || !response.stream) throw response.error || new Error('Failed to get stream')

      const stream = new PassThrough()

      response.stream.on('data', (chunk) => {
        if (!stream.destroyed) stream.write(chunk)
      })

      response.stream.on('end', () => {
        if (!stream.destroyed) {
          stream.emit('finishBuffering')
          stream.end()
        }
      })

      response.stream.on('error', (err) => {
        logger('error', 'Tumblr', `External stream error: ${err.message}`)
        if (!stream.destroyed) {
          stream.destroy(err)
        }
      })

      return { stream, type: url.includes('.mp3') ? 'audio/mpeg' : 'video/mp4' }
    } catch (e) {
      logger('error', 'Tumblr', `Failed to load stream: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}