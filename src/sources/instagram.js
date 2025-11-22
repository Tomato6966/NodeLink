import { PassThrough } from 'node:stream'
import { URLSearchParams } from 'node:url'

import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.js'

export default class InstagramSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?instagram\.com\/reels\/audio\/(\d+)/,
      /^https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)/,
      /^https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|reel)\/([\w-]+)/
    ]
    this.priority = 70

    this.apiConfig = {
      apiUrl: 'https://www.instagram.com/api/graphql',
      audioApiUrl: 'https://www.instagram.com/api/v1/clips/music/',
      csrfToken: null,
      igAppId: null,
      fbLsd: null,
      docId_post: '10015901848480474',
      jazoest: '2957'
    }
  }

  async setup() {
    logger('info', 'Sources', 'Fetching Instagram API parameters...')
    try {
      const response = await makeRequest('https://www.instagram.com/', {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        }
      })

      const body = response.body

      if (typeof body !== 'string' || response.statusCode !== 200) {
        throw new Error(
          `Failed to fetch Instagram homepage (Status: ${response.statusCode})`
        )
      }

      const csrfToken = body.match(/"csrf_token":"(.*?)"/)?.[1]
      const igAppId = body.match(/"appId":"(.*?)"/)?.[1]
      const fbLsd =
        body.match(/"LSD",\[\],{"token":"(.*?)"},/)?.[1] ||
        body.match(/name="lsd" value="(.*?)"/)?.[1]
      const docIdPost = body.match(/"PostPage",\[\],"(\d+)",/)?.[1]

      if (!csrfToken || !igAppId || !fbLsd) {
        logger(
          'error',
          'Sources',
          'Could not fetch all required Instagram parameters (CSRF, AppID, LSD). Source will be unavailable.'
        )
        return false
      }

      this.apiConfig.csrfToken = csrfToken
      this.apiConfig.igAppId = igAppId
      this.apiConfig.fbLsd = fbLsd
      if (docIdPost) this.apiConfig.docId_post = docIdPost

      logger('info', 'Sources', 'Loaded Instagram source.')
      return true
    } catch (e) {
      logger(
        'error',
        'Sources',
        `Instagram setup failed: ${e.message}. Source will be unavailable.`
      )
      return false
    }
  }

  isLinkMatch(link) {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  _extractInfo(url) {
    if (!url) {
      return {
        id: null,
        error: 'Instagram URL not provided',
        type: null
      }
    }
    for (const [index, pattern] of this.patterns.entries()) {
      const match = url.match(pattern)
      if (match && match[1]) {
        if (index === 0) {
          return { id: match[1], error: null, type: 'audio' }
        }

        let pathSegment = 'p'
        if (url.includes('/reel/') || url.includes('/reels/')) {
          pathSegment = 'reel'
        }
        return {
          id: match[1],
          error: null,
          type: 'post',
          pathSegment: pathSegment
        }
      }
    }
    return {
      id: null,
      error: 'Instagram post/reel/audio ID not found in URL',
      type: null
    }
  }

  _getShortcodeFromMediaId(mediaId) {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let shortcode = ''
    if (String(mediaId).includes('_')) {
      mediaId = String(mediaId).substring(0, String(mediaId).indexOf('_'))
    }
    try {
      let mediaIdBigInt = BigInt(mediaId)
      if (mediaIdBigInt <= 0) return null
      while (mediaIdBigInt > 0) {
        const remainder = mediaIdBigInt % BigInt(64)
        mediaIdBigInt = (mediaIdBigInt - remainder) / BigInt(64)
        shortcode = alphabet.charAt(Number(remainder)) + shortcode
      }
      return shortcode
    } catch (e) {
      logger(
        'debug',
        'Sources',
        `Could not convert Instagram mediaId "${mediaId}" to shortcode: ${e.message}`
      )
      return null
    }
  }

  _encodePostRequestData(shortcode) {
    const variables = JSON.stringify({
      shortcode: shortcode,
      fetch_comment_count: 'null',
      fetch_related_profile_media_count: 'null',
      parent_comment_count: 'null',
      child_comment_count: 'null',
      fetch_like_count: 'null',
      fetch_tagged_user_count: 'null',
      fetch_preview_comment_count: 'null',
      has_threaded_comments: 'false',
      hoisted_comment_id: 'null',
      hoisted_reply_id: 'null'
    })

    const requestData = {
      av: '0',
      __user: '0',
      __a: '1',
      __req: '3',
      dpr: '1',
      __ccg: 'UNKNOWN',
      lsd: this.apiConfig.fbLsd,
      jazoest: this.apiConfig.jazoest,
      doc_id: this.apiConfig.docId_post,
      variables: variables,
      fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
      fb_api_caller_class: 'RelayModern'
    }

    const params = new URLSearchParams()
    for (const key in requestData) {
      params.append(key, requestData[key])
    }
    return params.toString()
  }

  async _fetchFromAudioAPI(audioId) {
    if (!audioId) {
      return {
        data: null,
        exception: { message: 'Audio ID not provided', severity: 'common' }
      }
    }

    const headers = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name': 'PolarisClipsAudioRoute',
      'X-CSRFToken': this.apiConfig.csrfToken,
      'X-IG-App-ID': this.apiConfig.igAppId,
      'X-FB-LSD': this.apiConfig.fbLsd,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reels/audio/${audioId}/`
    }

    const body = new URLSearchParams({
      audio_cluster_id: audioId,
      lsd: this.apiConfig.fbLsd,
      jazoest: this.apiConfig.jazoest,
      __user: '0',
      __a: '1'
    }).toString()

    let response = null
    try {
      response = await http1makeRequest(this.apiConfig.audioApiUrl, {
        method: 'POST',
        headers: headers,
        body: body,
        disableBodyCompression: true
      })
    } catch (e) {
      logger(
        'error',
        'Sources',
        `Internal error during Instagram Audio API request for audioId ${audioId}: ${e.message}`
      )
      return {
        data: null,
        exception: {
          message: `Internal error during Audio API request: ${e.message}`,
          severity: 'fault'
        }
      }
    }

    if (response.error || response.statusCode !== 200) {
      const errorMsg =
        response.error?.message ||
        `Audio API request failed with code ${response.statusCode}`
      return {
        data: null,
        exception: {
          message: errorMsg,
          severity: 'fault',
          cause: `Status: ${response.statusCode}`
        }
      }
    }

    let responseData = response.body
    if (typeof responseData === 'string') {
      if (responseData.startsWith('for (;;);')) {
        responseData = responseData.substring('for (;;);'.length)
      }
      try {
        responseData = JSON.parse(responseData)
      } catch (e) {
        return {
          data: null,
          exception: {
            message: 'Invalid JSON response from Audio API',
            severity: 'fault'
          }
        }
      }
    }

    if (!responseData) {
      return {
        data: null,
        exception: {
          message: 'Invalid data structure in Audio API JSON response',
          severity: 'fault'
        }
      }
    }

    let payload = null
    if (responseData.payload) {
      payload = responseData.payload
    } else if (responseData.metadata) {
      payload = responseData
    } else {
      return {
        data: null,
        exception: {
          message: 'Invalid data structure in Audio API JSON response (no payload or metadata)',
          severity: 'fault'
        }
      }
    }

    let audioInfo = payload.metadata?.original_sound_info
    let infoSource = 'original_sound_info'

    if (!audioInfo) {
      audioInfo = payload.metadata?.music_info
      infoSource = 'music_info'
    }

    if (!audioInfo) {
      return {
        data: null,
        exception: {
          message: 'Audio information not found in API response.',
          severity: 'common'
        }
      }
    }

    let audioUrl = null
    let artist = null
    let title = null
    let duration = null
    let thumbnail = null

    if (infoSource === 'original_sound_info') {
      audioUrl = audioInfo.progressive_download_url
      artist = audioInfo.ig_artist?.username || 'User Unknown'
      title = audioInfo.original_audio_title || 'Instagram Audio'
      duration = audioInfo.duration_in_ms || 0
      thumbnail = audioInfo.ig_artist?.profile_pic_url || ''
    } else {
      const musicAsset = audioInfo.music_asset_info
      const musicConsumption = audioInfo.music_consumption_info

      audioUrl = musicAsset?.progressive_download_url

      if (!audioUrl && musicConsumption?.dash_manifest) {
        const urlMatch = musicConsumption.dash_manifest.match(/<BaseURL>(.*?)<\/BaseURL>/)
        if (urlMatch && urlMatch[1]) {
          audioUrl = urlMatch[1].replace(/&amp;/g, '&')
        }
      }

      if (!audioUrl) {
         audioUrl = audioInfo.progressive_download_url
      }

      artist = musicAsset?.artist_name || 'User Unknown'
      title = musicAsset?.title || 'Instagram Audio'
      duration = musicAsset?.duration_in_ms || 0
      thumbnail = musicAsset?.cover_artwork_thumbnail_uri || ''
    }

    if (!audioUrl) {
      return {
        data: null,
        exception: {
          message: 'Audio download URL not found in API response.',
          severity: 'common'
        }
      }
    }

    return {
      data: {
        videoUrl: audioUrl,
        author: artist,
        length: duration,
        thumbnail: thumbnail,
        title: title,
        isStream: false,
        isSeekable: false
      },
      exception: null
    }
  }

  async _fetchFromGraphQL(postId, pathSegment) {
    if (!postId) {
      return {
        data: null,
        exception: { message: 'Post ID not provided', severity: 'common' }
      }
    }

    const headers = {
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
      'X-CSRFToken': this.apiConfig.csrfToken,
      'X-IG-App-ID': this.apiConfig.igAppId,
      'X-FB-LSD': this.apiConfig.fbLsd,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/${pathSegment || 'p'}/${postId}/`
    }

    const encodedData = this._encodePostRequestData(postId)

    let response = null
    try {
      response = await http1makeRequest(this.apiConfig.apiUrl, {
        method: 'POST',
        headers: headers,
        body: encodedData,
        disableBodyCompression: true
      })
    } catch (e) {
      logger(
        'error',
        'Sources',
        `Internal error during Instagram GraphQL request for postId ${postId}: ${e.message}`
      )
      return {
        data: null,
        exception: {
          message: `Internal error during GraphQL request: ${e.message}`,
          severity: 'fault'
        }
      }
    }

    if (response.error || response.statusCode !== 200) {
      const errorMsg =
        response.error?.message ||
        `GraphQL request failed with code ${response.statusCode}`
      return {
        data: null,
        exception: {
          message: errorMsg,
          severity: 'fault',
          cause: `Status: ${response.statusCode}`
        }
      }
    }

    let responseData = response.body
    if (typeof responseData === 'string') {
      try {
        responseData = JSON.parse(responseData)
      } catch (e) {
        return {
          data: null,
          exception: {
            message: 'Invalid JSON response from GraphQL',
            severity: 'fault'
          }
        }
      }
    }

    if (!responseData || !responseData.data) {
      return {
        data: null,
        exception: {
          message: 'Invalid data structure in GraphQL JSON response',
          severity: 'fault'
        }
      }
    }

    const media = responseData.data.xdt_shortcode_media

    if (media === null) {
      return {
        data: null,
        exception: {
          message: 'Media not found or unavailable (private/deleted?).',
          severity: 'common'
        }
      }
    }

    let videoNode = null

    if (media.is_video) {
      videoNode = media
    } else if (
      media.__typename === 'XDTGraphSidecar' &&
      media.edge_sidecar_to_children
    ) {
      const videoEdge = media.edge_sidecar_to_children.edges.find(
        (edge) => edge.node.is_video
      )
      if (videoEdge) {
        videoNode = videoEdge.node
      }
    }

    if (!videoNode) {
      return {
        data: null,
        exception: {
          message: 'This post does not contain a video.',
          severity: 'common'
        }
      }
    }

    const videoUrl = videoNode.video_url
    if (!videoUrl) {
      return {
        data: null,
        exception: {
          message: 'Video URL not found in API response.',
          severity: 'common'
        }
      }
    }
    const title =
      media?.edge_media_to_caption?.edges[0]?.node?.text || 'Instagram Video'

    return {
      data: {
        videoUrl: videoUrl,
        author: media.owner?.username || 'User Unknown',
        length: (videoNode.video_duration || 0) * 1000,
        thumbnail: videoNode.display_url || media.display_url || '',
        title: title,
        isStream: false,
        isSeekable: false
      },
      exception: null
    }
  }

  async resolve(queryUrl) {
    const {
      id: contentId,
      error: idError,
      type,
      pathSegment
    } = this._extractInfo(queryUrl)
    if (idError) {
      return {
        exception: { message: idError, severity: 'common', cause: 'URLParsing' }
      }
    }

    let trackData = null
    let fetchError = null

    if (type === 'post') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromGraphQL(contentId, pathSegment))
    } else if (type === 'audio') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromAudioAPI(contentId))
    } else {
      return {
        exception: {
          message: 'Unknown URL type',
          severity: 'fault',
          cause: 'URLParsing'
        }
      }
    }

    if (fetchError) {
      if (fetchError.message?.includes('Media not found')) {
        return { loadType: 'empty', data: {} }
      }
      return { exception: { ...fetchError, cause: 'APIRequest' } }
    }

    const track = this.buildTrack(trackData, queryUrl, contentId)
    return { loadType: 'track', data: track }
  }

  buildTrack(trackData, queryUrl, contentId) {
    const trackInfo = {
      identifier: contentId,
      title: trackData.title || 'Instagram Content',
      author: trackData.author,
      length: trackData.length || -1,
      sourceName: 'instagram',
      artworkUrl: trackData.thumbnail || trackData.artworkUrl,
      uri: queryUrl,
      isStream: trackData.isStream,
      isSeekable: trackData.isSeekable,
      position: 0,
      isrc: null
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async getTrackUrl(track) {
    const {
      id: contentId,
      error: idError,
      type,
      pathSegment
    } = this._extractInfo(track.uri)
    if (idError) {
      return {
        exception: { message: idError, severity: 'common', cause: 'URLParsing' }
      }
    }

    let trackData = null
    let fetchError = null

    if (type === 'post') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromGraphQL(contentId, pathSegment))
    } else if (type === 'audio') {
      ;({ data: trackData, exception: fetchError } =
        await this._fetchFromAudioAPI(contentId))
    } else {
      return {
        exception: {
          message: 'Unknown URL type',
          severity: 'fault',
          cause: 'URLParsing'
        }
      }
    }

    if (fetchError || !trackData?.videoUrl) {
      const errorMessage =
        fetchError?.message || 'Could not retrieve video/audio stream URL.'
      return {
        exception: {
          message: errorMessage,
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }

    return {
      url: trackData.videoUrl,
      protocol: trackData.videoUrl.startsWith('https:') ? 'https' : 'http',
      format: 'mp4'
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      const options = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
          Referer: decodedTrack.uri || 'https://www.instagram.com/'
        },
        disableBodyCompression: true
      }
      const response = await http1makeRequest(url, options)

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }
      const stream = new PassThrough()
      response.stream.on('data', (chunk) => {
        stream.write(chunk)
      })
      response.stream.on('end', () => {
        stream.end()
        stream.emit('finishBuffering')
      })
      response.stream.on('error', (err) => {
        stream.destroy(err)
      })
      return { stream, type: 'video/mp4' }
    } catch (err) {
      return {
        exception: {
          message: err.message,
          severity: 'fault',
          cause: 'StreamLoadFailed'
        }
      }
    }
  }

  async search(query, type) {
    if (this.isLinkMatch(query)) {
      return this.resolve(query)
    }

    if (/^\d{15,}(_\d+)?$/.test(query)) {
      const shortcode = this._getShortcodeFromMediaId(query)
      if (shortcode) {
        const url = `https://www.instagram.com/p/${shortcode}/`
        return this.resolve(url)
      }
    }

    return {
      exception: {
        message: 'No results found for the query.',
        severity: 'common',
        cause: 'NoResults'
      }
    }
  }
}
