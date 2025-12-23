import { encodeTrack, logger, http1makeRequest } from '../utils.js'

export default class TelegramSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /https?:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/([^/]+)\/(\d+)/
    ]
    this.searchTerms = []
    this.priority = 80
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Telegram source.')
    return true
  }

  async search(_query) {
    return { loadType: 'empty', data: {} }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    const [, channelId, msgId] = match
    const embedUrl = new URL(url)
    embedUrl.searchParams.set('embed', '1')

    try {
      const { body, error, statusCode } = await http1makeRequest(embedUrl.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Encoding': 'identity'
        }
      })

      if (error || statusCode !== 200) {
        return {
          exception: {
            message: error?.message || `Status code ${statusCode}`,
            severity: 'fault'
          }
        }
      }

      const authorMatch = body.match(/class="tgme_widget_message_author[^>]*>[\s\S]*?<span dir="auto">([^<]+)<\/span>/)
      const author = authorMatch ? authorMatch[1].trim() : 'Telegram Channel'

      const textMatch = body.match(/class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)
      const description = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : ''
      const title = description.split('\n')[0] || `Telegram Video ${msgId}`

      const videoRegex = /<a class="tgme_widget_message_video_player([\s\S]*?)<\/time>/g
      const videoBlocks = [...body.matchAll(videoRegex)]

      if (videoBlocks.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = []
      for (const block of videoBlocks) {
        const content = block[0]
        const videoUrlMatch = content.match(/<video[^>]+src="([^"]+)"/) 
        if (!videoUrlMatch) continue

        const videoUrl = videoUrlMatch[1]
        
        let durationMs = 0
        const durationMatch = content.match(/<time[^>]+duration[^>]*>([\d:]+)<\/time>/) || content.match(/class="tgme_widget_message_video_duration">([\d:]+)<\/time>/)
        
        if (durationMatch) {
          const durationStr = durationMatch[1]
          const durationParts = durationStr.split(':').map(Number)
          if (durationParts.length === 2) durationMs = (durationParts[0] * 60 + durationParts[1]) * 1000
          else if (durationParts.length === 3) durationMs = (durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]) * 1000
        }

        const thumbMatch = content.match(/tgme_widget_message_video_thumb"[^>]+background-image:url\('([^']+)'\)/)
        const artworkUrl = thumbMatch ? thumbMatch[1] : null

        const trackInfo = {
          identifier: `${channelId}/${msgId}/${tracks.length}`,
          isSeekable: true,
          author,
          length: durationMs,
          isStream: false,
          position: 0,
          title: tracks.length === 0 ? title : `${title} (Video ${tracks.length + 1})`,
          uri: url,
          artworkUrl,
          isrc: null,
          sourceName: 'telegram'
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {
            directUrl: videoUrl
          }
        })
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }
      
      const isSingle = url.includes('?single') || url.includes('&single')
      if (isSingle && tracks.length > 0) {
        return { loadType: 'track', data: tracks[0] }
      }

      if (tracks.length === 1) return { loadType: 'track', data: tracks[0] }

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: title,
            selectedTrack: 0
          },
          pluginInfo: {},
          tracks
        }
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(track) {
    const result = await this.resolve(track.uri)
    if (result.loadType === 'track') {
      return {
        url: result.data.pluginInfo.directUrl,
        protocol: 'https',
        format: 'mp4'
      }
    }
    if (result.loadType === 'playlist') {
      const parts = track.identifier.split('/')
      const index = parseInt(parts[parts.length - 1])
      const selectedTrack = result.data.tracks[index] || result.data.tracks[0]
      return {
        url: selectedTrack.pluginInfo.directUrl,
        protocol: 'https',
        format: 'mp4'
      }
    }
    return {
      exception: { message: 'Failed to get track URL', severity: 'fault' }
    }
  }

  async loadStream(decodedTrack, url) {
    try {
      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw response.error || new Error('Failed to get stream')
      }

      const stream = new PassThrough()
      
      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', (err) => stream.destroy(err))

      return { stream: stream, type: 'video/mp4' }
    } catch (err) {
      return { exception: { message: err.message, severity: 'common' } }
    }
  }

  async search(query) {
    return { loadType: 'empty', data: {} }
  }
}
