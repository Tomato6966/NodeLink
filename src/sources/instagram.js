import { URLSearchParams } from 'node:url'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.js'
import { PassThrough } from 'node:stream'

export default class InstagramSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /^https?:\/\/(?:www\.)?instagram\.com\/p\/([\w-]+)/,
      /^https?:\/\/(?:www\.)?instagram\.com\/(?:reels?|reel)\/([\w-]+)/
    ]
    this.priority = 70

    this.apiConfig = {
      apiUrl: 'https://www.instagram.com/api/graphql',
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

  _getPostId(url) {
    if (!url) {
      return {
        id: null,
        error: 'Instagram URL not provided',
        pathSegment: null
      }
    }
    for (const pattern of this.patterns) {
      const match = url.match(pattern)
      //biome-ignore lint: change-to-an-optinal-chain
      if (match && match[1]) {
        let pathSegment = 'p'
        if (url.includes('/reel/') || url.includes('/reels/')) {
          pathSegment = 'reel'
        }
        return { id: match[1], error: null, pathSegment: pathSegment }
      }
    }
    return {
      id: null,
      error: 'Instagram post/reel ID not found in URL',
      pathSegment: null
    }
  }

  _getShortcodeFromMediaId(mediaId) {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let shortcode = ''
    if (String(mediaId).includes('_')) {
      //biome-ignore lint: reassign
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

    let response
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
      id: postId,
      error: idError,
      pathSegment
    } = this._getPostId(queryUrl)
    if (idError) {
      return {
        exception: { message: idError, severity: 'common', cause: 'URLParsing' }
      }
    }

    const { data: videoData, exception: fetchError } =
      await this._fetchFromGraphQL(postId, pathSegment)

    if (fetchError) {
      if (fetchError.message?.includes('Media not found')) {
        return { loadType: 'empty', data: {} }
      }
      return { exception: { ...fetchError, cause: 'APIRequest' } }
    }

    const track = this.buildTrack(videoData, queryUrl, postId)
    return { loadType: 'track', data: track }
  }

  buildTrack(videoData, queryUrl, postId) {
    const trackInfo = {
      identifier: postId,
      title: videoData.title || 'Instagram Video',
      author: videoData.author,
      length: videoData.length || -1,
      sourceName: 'instagram',
      artworkUrl: videoData.thumbnail || videoData.artworkUrl,
      uri: queryUrl,
      isStream: videoData.isStream,
      isSeekable: videoData.isSeekable,
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
      id: postId,
      error: idError,
      pathSegment
    } = this._getPostId(track.uri)
    if (idError) {
      return {
        exception: { message: idError, severity: 'common', cause: 'URLParsing' }
      }
    }

    const { data: videoData, error: fetchError_graphql } =
      await this._fetchFromGraphQL(postId, pathSegment)

    if (fetchError_graphql || !videoData?.videoUrl) {
      const errorMessage =
        fetchError_graphql?.message || 'Could not retrieve video stream URL.'
      return {
        exception: {
          message: errorMessage,
          severity: 'fault',
          cause: 'StreamLink'
        }
      }
    }

    return {
      url: videoData.videoUrl,
      protocol: videoData.videoUrl.startsWith('https:') ? 'https' : 'http',
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
