import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest, http1makeRequest } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.js'

export default class BlueskySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['bksearch']
    this.patterns = [
      /https?:\/\/(?:play\.|www\.)?(?:bsky\.app|main\.bsky\.dev)\/profile\/(?<handle>[\w.:%-]+)\/post\/(?<id>\w+)/,
      /at:\/\/(?<handle>[\w.:%-]+)\/app\.bsky\.feed\.post\/(?<id>\w+)/
    ]
  }

  async setup() {
    return true
  }

  async search(query) {
    logger('debug', 'Bluesky', `Searching for: ${query}`)
    const searchUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${this.config.maxSearchResults || 10}`
    
    const { body, error } = await makeRequest(searchUrl, { method: 'GET' })
    if (error || !body || !body.posts) return { loadType: 'empty', data: {} }

    const tracks = body.posts
      .map(post => this.buildTrack(post))
      .filter(track => track && (track.info.uri.includes('.m3u8') || track.info.uri.includes('getBlob')))

    return {
      loadType: 'search',
      data: tracks
    }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0]) || url.match(this.patterns[1])
    if (!match) return { loadType: 'empty', data: {} }

    const { handle, id } = match.groups
    logger('debug', 'Bluesky', `Resolving post: ${id} by ${handle}`)

    const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${id}&depth=0`
    const { body, error } = await makeRequest(apiUrl, { method: 'GET' })

    if (error || !body || !body.thread || !body.thread.post) {
      return { loadType: 'empty', data: {} }
    }

    const post = body.thread.post
    const track = this.buildTrack(post)

    if (!track || (!track.info.uri.includes('.m3u8') && !track.info.uri.includes('getBlob'))) {
        return { loadType: 'empty', data: {} }
    }

    return {
      loadType: 'track',
      data: track
    }
  }

  async getTrackUrl(decodedTrack) {
    if (decodedTrack.uri.includes('.m3u8') || decodedTrack.uri.includes('getBlob')) {
        return {
            url: decodedTrack.uri,
            protocol: decodedTrack.uri.includes('.m3u8') ? 'hls' : 'https',
            format: 'mp4'
        }
    }

    return { exception: { message: 'This Bluesky post does not contain a direct video or audio stream.', severity: 'common' } }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    logger('debug', 'Bluesky', `Loading stream for ${decodedTrack.identifier} via ${protocol}`)

    if (protocol === 'hls') {
      const stream = new HLSHandler(url, {
        startTime: additionalData?.startTime,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
        }
      })

      return { stream }
    }

    const { stream: resStream, error } = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
      }
    })

    if (error) {
      throw new Error(`Failed to load Bluesky stream: ${error.message}`)
    }

    const pass = new PassThrough()

    resStream.on('data', (chunk) => {
      if (!pass.write(chunk)) resStream.pause()
    })

    pass.on('drain', () => {
      if (!resStream.destroyed) resStream.resume()
    })

    resStream.on('end', () => {
      if (!pass.writableEnded) {
        pass.emit('finishBuffering')
        pass.end()
      }
    })

    resStream.on('error', (err) => {
      logger('error', 'Bluesky', `Upstream stream error: ${err.message}`)
      if (!pass.destroyed) pass.destroy(err)
    })

    return { stream: pass, type: 'mp4' }
  }

  buildTrack(post) {
    const embed = post.embed?.media || post.embed
    if (!embed) return null

    const videoCid = embed.cid || (embed.video && embed.video.ref ? embed.video.ref.$link : null)
    const playlistUrl = embed.playlist
    const thumbnail = embed.thumbnail
    
    let streamUrl = playlistUrl

    if (!streamUrl && videoCid && post.author?.did) {
        streamUrl = `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${post.author.did}&cid=${videoCid}`
    }

    if (!streamUrl) return null

    const title = (post.record?.text || post.value?.text || 'Bluesky Media').split('\n')[0].slice(0, 72)
    const author = post.author?.displayName || post.author?.handle

    const trackInfo = {
      identifier: post.uri.split('/').pop(),
      isSeekable: true,
      author: author,
      length: 0,
      isStream: false,
      position: 0,
      title: title,
      uri: streamUrl,
      artworkUrl: thumbnail || post.author?.avatar,
      isrc: null,
      sourceName: 'bluesky'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {
          postUri: post.uri,
          did: post.author?.did,
          videoCid: videoCid
      }
    }
  }
}