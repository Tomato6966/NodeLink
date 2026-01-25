import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest, http1makeRequest } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.js'

export default class BlueskySource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['bksearch']
    this.patterns = [
      /https?:\/\/(?:www\.)?(?:bsky\.app|main\.bsky\.dev)\/profile\/(?<handle>[\w.:%-]+)\/post\/(?<id>\w+)/,
      /at:\/\/(?<handle>[\w.:%-]+)\/app\.bsky\.feed\.post\/(?<id>\w+)/
    ]
  }

  async setup() {
    return true
  }

  async _getServiceEndpoint(did) {
    let url = did.startsWith('did:web:') 
      ? `https://${did.slice(8)}/.well-known/did.json`
      : `https://plc.directory/${did}`

    const { body, error } = await makeRequest(url, { method: 'GET' })
    if (error || !body || !body.service) return 'https://bsky.social'

    const pds = body.service.find(s => s.type === 'AtprotoPersonalDataServer')
    return pds?.serviceEndpoint || 'https://bsky.social'
  }

  async search(query) {
    logger('debug', 'Bluesky', `Searching for: ${query}`)
    const searchUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${this.config.maxSearchResults || 10}`
    
    const { body, error } = await makeRequest(searchUrl, { method: 'GET' })
    if (error || !body || !body.posts) return { loadType: 'empty', data: {} }

    const tracks = body.posts
      .map(post => this.buildTrack(post))
      .filter(track => track !== null)

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

    if (!track) return { loadType: 'empty', data: {} }

    return {
      loadType: 'track',
      data: track
    }
  }

  async getTrackUrl(decodedTrack) {
    // Parse handle and id from URI
    const match = decodedTrack.uri.match(this.patterns[0]) || decodedTrack.uri.match(this.patterns[1])
    if (!match) {
        throw new Error('Invalid Bluesky track URI')
    }

    const { handle, id } = match.groups
    const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${handle}/app.bsky.feed.post/${id}&depth=0`
    const { body, error } = await makeRequest(apiUrl, { method: 'GET' })

    if (error || !body || !body.thread || !body.thread.post) {
      throw new Error('Failed to fetch Bluesky post for streaming')
    }

    const post = body.thread.post
    const embed = post.embed?.media || post.embed
    if (!embed) throw new Error('No media found in Bluesky post')

    const playlistUrl = embed.playlist
    const videoCid = embed.cid || (embed.video && embed.video.ref ? embed.video.ref.$link : null)

    if (playlistUrl) {
        return {
            url: playlistUrl,
            protocol: 'hls',
            format: 'mpegts'
        }
    }

    if (videoCid && post.author?.did) {
        const endpoint = await this._getServiceEndpoint(post.author.did)
        return {
            url: `${endpoint}/xrpc/com.atproto.sync.getBlob?did=${post.author.did}&cid=${videoCid}`,
            protocol: 'https',
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

      return { stream, type: 'mpegts' }
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
    
    if (!playlistUrl && !videoCid) return null

    const handle = post.author?.handle
    const id = post.uri.split('/').pop()
    const title = (post.record?.text || post.value?.text || 'Bluesky Media').split('\n')[0].slice(0, 72)
    const author = post.author?.displayName || handle

    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: author,
      length: 0,
      isStream: false,
      position: 0,
      title: title,
      uri: `https://bsky.app/profile/${handle}/post/${id}`,
      artworkUrl: embed.thumbnail || post.author?.avatar,
      isrc: null,
      sourceName: 'bluesky'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }
}
