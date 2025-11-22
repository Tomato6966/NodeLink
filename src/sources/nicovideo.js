import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger } from '../utils.js'
async function manageEncryptedHls(url, stream, headers) {
  try {
    const {
      body: playlistContent,
      error,
      statusCode
    } = await http1makeRequest(url, { headers })
    if (error || statusCode !== 200) {
      throw new Error(
        `Failed to fetch HLS playlist: ${error?.message || statusCode}`
      )
    }
    const lines = playlistContent.split('\n').map((l) => l.trim())
    const keyTag = lines.find((l) => l.startsWith('#EXT-X-KEY:'))
    if (!keyTag) {
      throw new Error('No encryption key found in HLS playlist.')
    }
    const keyUriMatch = keyTag.match(/URI="([^"]+)"/)
    const ivMatch = keyTag.match(/IV=0x([0-9a-fA-F]+)/)
    if (!keyUriMatch) {
      throw new Error('Could not parse encryption key from playlist.')
    }
    const keyUrl = new URL(keyUriMatch[1], url).toString()
    const iv = ivMatch ? Buffer.from(ivMatch[1], 'hex') : null
    const {
      body: key,
      error: keyError,
      statusCode: keyStatus
    } = await http1makeRequest(keyUrl, { headers, responseType: 'buffer' })
    if (keyError || keyStatus !== 200) {
      throw new Error(
        `Failed to fetch decryption key: ${keyError?.message || keyStatus}`
      )
    }

    const mediaSequenceTag = lines.find((l) =>
      l.startsWith('#EXT-X-MEDIA-SEQUENCE:')
    )
    const mediaSequence = mediaSequenceTag
      ? Number.parseInt(mediaSequenceTag.split(':')[1], 10)
      : 0
    const mapTag = lines.find((l) => l.startsWith('#EXT-X-MAP:'))

    if (mapTag) {
      const mapUriMatch = mapTag.match(/URI="([^"]+)"/)
      if (mapUriMatch) {
        const mapUrl = new URL(mapUriMatch[1], url).toString()
        const {
          body: initSegment,
          error: mapError,
          statusCode: mapStatus
        } = await http1makeRequest(mapUrl, { headers, responseType: 'buffer' })
        if (!mapError && mapStatus === 200 && initSegment.length > 0) {
          let decryptedInit = initSegment
          if (initSegment.length % 16 === 0 && iv) {
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
            decipher.setAutoPadding(false)
            decryptedInit = Buffer.concat([
              decipher.update(initSegment),
              decipher.final()
            ])
          }

          stream.write(decryptedInit)
        }
      }
    }
    const segments = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        const segmentUrl = lines[++i]
        if (segmentUrl && !segmentUrl.startsWith('#')) {
          segments.push(new URL(segmentUrl, url).toString())
        }
      }
    }
    logger(
      'debug',
      'NicoVideo-HLS',
      `Found ${segments.length} segments to process`
    )
    ;(async () => {
      for (let segIndex = 0; segIndex < segments.length; segIndex++) {
        if (stream.destroyed) break
        const segmentUrl = segments[segIndex]
        let segmentIv
        if (iv) {
          segmentIv = iv
        } else {
          const sequenceNum = mediaSequence + segIndex
          segmentIv = Buffer.alloc(16)
          segmentIv.writeBigUInt64BE(BigInt(sequenceNum), 8)
        }
        try {
          const {
            body: encryptedSegment,
            error: segError,
            statusCode: segStatus
          } = await http1makeRequest(segmentUrl, {
            headers,
            responseType: 'buffer'
          })
          if (segError || segStatus !== 200) {
            logger(
              'warn',
              'NicoVideo-HLS',
              `Skipping segment ${segIndex + 1}: ${segError?.message || segStatus}`
            )
            continue
          }
          const decipher = crypto.createDecipheriv(
            'aes-128-cbc',
            key,
            segmentIv
          )
          decipher.setAutoPadding(false)
          const decryptedSegment = Buffer.concat([
            decipher.update(encryptedSegment),
            decipher.final()
          ])
          if (!stream.destroyed) {
            stream.write(decryptedSegment)
          }
        } catch (decryptError) {
          logger(
            'warn',
            'NicoVideo-HLS',
            `Failed to decrypt segment ${segIndex + 1}: ${decryptError.message}`
          )
        }
      }
      if (!stream.destroyed) {
        stream.emit('finishBuffering')
        stream.end()
      }
    })().catch((e) => {
      logger('error', 'NicoVideo-HLS', `Stream processing error: ${e.message}`)
      if (!stream.destroyed) {
        stream.destroy(e)
      }
    })
  } catch (e) {
    logger('error', 'NicoVideo-HLS', `HLS loading failed: ${e.message}`)
    stream.destroy(e)
  }
}
export default class NicoVideoSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = ['ncsearch', 'nicovideo']
    this.patterns = [
      /^https?:\/\/(?:www\.)?nicovideo\.jp\/watch\/(\w+)/,
      /^https?:\/\/nico\.ms\/(\w+)/
    ]
    this.priority = 75
  }
  async setup() {
    logger('info', 'Sources', 'Loaded NicoVideo source.')
    return true
  }
  _buildHeaders(accessRightKey) {
    const headers = {
      'User-Agent': 'NodeLink',
      'X-Request-With': 'https://www.nicovideo.jp',
      Referer: 'https://www.nicovideo.jp/',
      'X-Frontend-Id': '6',
      'X-Frontend-Version': '0'
    }
    if (accessRightKey) {
      headers['x-access-right-key'] = accessRightKey
    }
    return headers
  }
  async search(query) {
    logger('debug', 'NicoVideo', `Searching for: ${query}`)
    const params = new URLSearchParams({
      q: query,
      targets: 'title,tags',
      fields: 'contentId,title,owner,thumbnailUrl,duration',
      _sort: '-viewCounter',
      _context: 'NodeLink',
      _limit: 25
    })
    const { body, error, statusCode } = await http1makeRequest(
      `https://api.search.nicovideo.jp/api/v2/snapshot/video/contents/search?${params.toString()}`
    )
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to search: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    if (!body.data || body.data.length === 0) {
      return { loadType: 'empty', data: {} }
    }
    const tracks = body.data.map((item) => {
      const trackInfo = {
        identifier: item.contentId,
        isSeekable: false,
        author: item.owner?.name || 'Unknown Artist',
        length: item.duration * 1000,
        isStream: false,
        position: 0,
        title: item.title,
        uri: `https://www.nicovideo.jp/watch/${item.contentId}`,
        artworkUrl: item.thumbnailUrl,
        isrc: null,
        sourceName: 'nicovideo'
      }
      return {
        encoded: encodeTrack(trackInfo),
        info: trackInfo,
        pluginInfo: {}
      }
    })
    return { loadType: 'search', data: tracks }
  }
  async resolve(url) {
    const videoId =
      url.match(this.patterns[0])?.[1] || url.match(this.patterns[1])?.[1]
    if (!videoId) return { loadType: 'empty', data: {} }
    const { body, error, statusCode } = await http1makeRequest(
      `https://www.nicovideo.jp/watch/${videoId}?responseType=json`,
      { headers: this._buildHeaders() }
    )
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to resolve URL: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    const jsonLd = body?.data?.metadata?.jsonLds?.find(
      (x) => x['@type'] === 'VideoObject'
    )
    const videoIdFromApi = body?.data?.response?.client?.watchId
    if (!jsonLd || !videoIdFromApi) {
      return {
        exception: {
          message: 'Could not extract video information.',
          severity: 'common'
        }
      }
    }
    const durationStr = jsonLd.duration
    const durationMs = durationStr
      ? Number.parseInt(durationStr.match(/(\d+)S/)?.[1] || 0, 10) * 1000
      : 0
    const track = {
      identifier: videoIdFromApi,
      isSeekable: false,
      author: jsonLd.author?.name || 'Unknown Artist',
      length: durationMs,
      isStream: false,
      position: 0,
      title: jsonLd.name,
      uri: jsonLd['@id'],
      artworkUrl: jsonLd.thumbnailUrl?.[0] || null,
      isrc: null,
      sourceName: 'nicovideo'
    }
    return {
      loadType: 'track',
      data: { encoded: encodeTrack(track), info: track, pluginInfo: {} }
    }
  }
  _buildOutputData(dmcMedia) {
    const quality = ['1080p', '720p', '480p', '360p', '144p']
    const outputs = []
    let topAudioId = null
    let topAudioQuality = -1
    for (const audio of dmcMedia.audios) {
      if (audio.isAvailable && audio.qualityLevel > topAudioQuality) {
        topAudioId = audio.id
        topAudioQuality = audio.qualityLevel
      }
    }
    if (!topAudioId) return outputs
    for (const video of dmcMedia.videos) {
      if (quality.includes(video.label) && video.isAvailable) {
        outputs.push([video.id, topAudioId])
      }
    }
    return outputs
  }
  async getTrackUrl(track) {
    const {
      body: pageData,
      error,
      statusCode
    } = await http1makeRequest(`${track.uri}?responseType=json`, {
      headers: this._buildHeaders()
    })
    if (error || statusCode !== 200) {
      return {
        exception: {
          message: `Failed to get track page: ${error?.message || statusCode}`,
          severity: 'fault'
        }
      }
    }
    const response = pageData?.data?.response
    if (!response) {
      return {
        exception: {
          message: 'Failed to extract response data from page',
          severity: 'fault'
        }
      }
    }
    const dmcMedia = response.media?.domand
    const watchTrackId = response.client?.watchTrackId
    const accessRightKey = dmcMedia?.accessRightKey
    if (!dmcMedia || !watchTrackId || !accessRightKey) {
      return {
        exception: {
          message: 'Failed to extract required DMC info for stream access',
          severity: 'fault'
        }
      }
    }
    const streamRequestUrl = `https://nvapi.nicovideo.jp/v1/watch/${track.identifier}/access-rights/hls?actionTrackId=${encodeURIComponent(watchTrackId)}&__retry=1`
    const postBody = { outputs: this._buildOutputData(dmcMedia) }
    const {
      body: streamData,
      headers: streamHeaders,
      error: streamError,
      statusCode: streamStatus
    } = await http1makeRequest(streamRequestUrl, {
      method: 'POST',
      headers: this._buildHeaders(accessRightKey),
      body: postBody,
      disableBodyCompression: true
    })
    if (streamError || streamStatus !== 201) {
      return {
        exception: {
          message: `Failed to get stream access rights: ${streamError?.message || streamStatus}`,
          severity: 'fault'
        }
      }
    }
    const cookie = streamHeaders['set-cookie']
      ? Array.isArray(streamHeaders['set-cookie'])
        ? streamHeaders['set-cookie'].join('; ')
        : streamHeaders['set-cookie']
      : null
    const masterPlaylistUrl = streamData.data.contentUrl
    const {
      body: masterPlaylistContent,
      error: masterError,
      statusCode: masterStatus
    } = await http1makeRequest(masterPlaylistUrl, {
      headers: { Cookie: cookie }
    })
    if (masterError || masterStatus !== 200) {
      return {
        exception: {
          message: `Failed to fetch master HLS playlist: ${masterError?.message || masterStatus}`,
          severity: 'fault'
        }
      }
    }
    const lines = masterPlaylistContent.split('\n')
    const audioTag = lines.find(
      (l) => l.startsWith('#EXT-X-MEDIA') && l.includes('TYPE=AUDIO')
    )
    if (!audioTag) {
      return {
        url: masterPlaylistUrl,
        protocol: 'hls',
        format: 'aac',
        additionalData: { cookie }
      }
    }
    const audioUri = audioTag.match(/URI="([^"]+)"/)?.[1]
    if (!audioUri) {
      return {
        exception: {
          message: 'Could not parse audio URI from master playlist',
          severity: 'fault'
        }
      }
    }
    const audioPlaylistUrl = new URL(audioUri, masterPlaylistUrl).toString()
    return {
      url: audioPlaylistUrl,
      protocol: 'hls',
      format: 'aac',
      additionalData: { cookie }
    }
  }
  async loadStream(track, url, protocol, additionalData) {
    if (protocol === 'hls') {
      const stream = new PassThrough()
      const headers = additionalData?.cookie
        ? { Cookie: additionalData.cookie }
        : {}
      manageEncryptedHls(url, stream, headers)
      return { stream, type: 'fmp4' }
    }
    return {
      exception: { message: 'Unsupported protocol', severity: 'common' }
    }
  }
}
