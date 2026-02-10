import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger } from '../utils.js'
import HLSHandler from '../playback/hls/HLSHandler.ts'

const AUTH = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

export default class TwitterSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/(?:(?:www|m(?:obile)?)\.)?(?:twitter|x)\.com\/(?:[^/]+)\/status\/(\d+)/i
    ]
    this.priority = 70
    this.guestToken = null
    this.tokenExpiry = 0
  }

  async setup() {
    await this._refreshGuestToken()
    logger('info', 'Sources', 'Loaded Twitter (X) source.')
    return true
  }

  async _refreshGuestToken() {
    try {
      const { body, statusCode } = await http1makeRequest('https://api.twitter.com/1.1/guest/activate.json', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (statusCode === 200 && body.guest_token) {
        this.guestToken = body.guest_token
        this.tokenExpiry = Date.now() + 10800000
        return true
      }
    } catch (e) {
      logger('error', 'Twitter', `Guest token activation failed: ${e.message}`)
    }
    return false
  }

  _generateSyndicationToken(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/[0.]/g, '')
  }

  async _callGraphQL(operation, variables, features) {
    if (!this.guestToken || Date.now() > this.tokenExpiry) {
      await this._refreshGuestToken()
    }

    const url = `https://twitter.com/i/api/graphql/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`

    return await http1makeRequest(url, {
      headers: {
        Authorization: `Bearer ${AUTH}`,
        'x-guest-token': this.guestToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://twitter.com/'
      }
    })
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    const id = match[1]
    try {
      const features = {
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true
      }

      const { body, statusCode: _statusCode } = await this._callGraphQL('2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId', {
        tweetId: id,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: true
      }, features)

      let result = body?.data?.tweetResult?.result
      if (result?.__typename === 'TweetWithVisibilityResults') result = result.tweet
      const legacy = result?.legacy

      if (legacy) {
        const media = legacy.extended_entities?.media?.find(m => m.type === 'video' || m.type === 'animated_gif')
        if (media) return this._buildTrackResponse(id, legacy, media, result, url)
      }

      const syndToken = this._generateSyndicationToken(id)
      const syndRes = await http1makeRequest(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndToken}&lang=en`, {
        headers: { 'User-Agent': 'Googlebot' }
      })

      if (syndRes.statusCode === 200 && (syndRes.body.video || syndRes.body.mediaDetails)) {
        const media = syndRes.body.video || syndRes.body.mediaDetails[0]
        return this._buildTrackResponse(id, syndRes.body, media, null, url, true)
      }

    } catch (e) {
      logger('error', 'Twitter', `Resolution failed for ${id}: ${e.message}`)
    }

    return { loadType: 'empty', data: {} }
  }

  _buildTrackResponse(id, legacy, media, result, url, isSyndication = false) {
    const variants = isSyndication ? media.variants : media.video_info.variants
    const bestVariant = variants
      .filter(v => (v.content_type || v.type) === 'video/mp4')
      .map(v => {
        if (v.bitrate) return v
        const match = (v.url || v.src).match(/\/(\d+)x(\d+)\//)
        if (match) v.bitrate = parseInt(match[1]) * parseInt(match[2])
        return v
      })
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] ||
      variants.find(v => (v.content_type || v.type) === 'application/x-mpegURL')

    if (!bestVariant) return { loadType: 'empty', data: {} }

    const directUrl = isSyndication ? bestVariant.src : bestVariant.url
    const isHLS = directUrl.includes('.m3u8')

    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: isSyndication ? legacy.user.name : (result?.core?.user_results?.result?.legacy?.name || 'Twitter User'),
      length: isSyndication ? (media.durationMs || 0) : (media.video_info?.duration_millis || 0),
      isStream: isHLS,
      position: 0,
      title: (isSyndication ? legacy.text : legacy.full_text)?.split('https://t.co')[0].trim() || 'Twitter Content',
      uri: url,
      artworkUrl: isSyndication ? media.poster : (media.media_url_https || null),
      isrc: null,
      sourceName: 'twitter'
    }

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack(trackInfo),
        info: trackInfo,
        pluginInfo: { directUrl, isHLS }
      }
    }
  }

  async search(query) {
    try {
      const features = { responsive_web_graphql_timeline_navigation_enabled: true }
      const { body } = await this._callGraphQL('gk_S_vsh_PyInisUnZun6Q/SearchTimeline', {
        rawQuery: `${query} filter:videos`,
        count: 10,
        querySource: 'typed_query',
        product: 'Latest'
      }, features)

      const instructions = body?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || []
      const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries || []

      const results = entries
        .map(e => {
          const result = e.content?.itemContent?.tweet_results?.result
          const legacy = result?.legacy || result?.tweet?.legacy
          if (!legacy) return null
          const media = legacy.extended_entities?.media?.find(m => m.type === 'video' || m.type === 'animated_gif')
          if (!media) return null
          return this._buildTrackResponse(legacy.id_str, legacy, media, result, `https://twitter.com/i/status/${legacy.id_str}`).data
        })
        .filter(Boolean)

      return results.length ? { loadType: 'search', data: results } : { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'Twitter', `Search failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(track, itag, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.nodelink.trackCacheManager.get('twitter', track.identifier)
      if (cached) return cached
    }

    const _videoId = track.identifier
    if (track.pluginInfo?.directUrl) {
      return {
        url: track.pluginInfo.directUrl,
        protocol: track.pluginInfo.isHLS ? 'hls' : 'https',
        format: track.pluginInfo.isHLS ? 'm3u8' : 'mp4'
      }
    }

    const res = await this.resolve(track.uri)
    if (res.loadType === 'track') {
      return {
        url: res.data.pluginInfo.directUrl,
        protocol: res.data.pluginInfo.isHLS ? 'hls' : 'https',
        format: res.data.pluginInfo.isHLS ? 'm3u8' : 'mp4'
      }
    }

    throw new Error('Failed to extract Twitter media URL')
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://twitter.com/'
      }

      if (url.includes('.m3u8')) {
        const stream = new HLSHandler(url, {
          type: 'fmp4',
          strategy: 'segmented',
          headers,
          localAddress: this.nodelink.routePlanner?.getIP(),
          startTime: additionalData?.startTime || 0
        })
        return { stream, type: 'fmp4' }
      }

      const response = await http1makeRequest(url, {
        method: 'GET',
        headers,
        streamOnly: true
      })

      if (response.error || !response.stream) throw response.error || new Error('Failed to get stream')

      const stream = new PassThrough()
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
      }

      response.stream.on('data', (chunk) => {
        if (!stream.destroyed) stream.write(chunk)
      })

      response.stream.on('end', finish)
      response.stream.on('close', finish)

      response.stream.on('error', (err) => {
        logger('error', 'Twitter', `External stream error: ${err.message}`)
        if (!stream.destroyed) stream.destroy(err)
      })

      return { stream, type: 'video/mp4' }
    } catch (e) {
      logger('error', 'Twitter', `Failed to load stream: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}
