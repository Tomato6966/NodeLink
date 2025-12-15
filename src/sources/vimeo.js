import { PassThrough } from 'node:stream'
import { Buffer } from 'node:buffer'
import https from 'node:https'
import http from 'node:http'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { encodeTrack, logger } from '../utils.js'

const VIMEO_PATTERNS = [
  /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)(?:|[/?#])/i,
  /^https?:\/\/player\.vimeo\.com\/video\/(\d+)(?:|[/?#])/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/channels\/[^/]+\/(\d+)(?:|[/?#])/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/groups\/[^/]+\/videos\/(\d+)(?:|[/?#])/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/album\/\d+\/video\/(\d+)(?:|[/?#])/i,
  /^https?:\/\/(?:www\.)?vimeo\.com\/showcase\/\d+\/video\/(\d+)(?:|[/?#])/i
]

const VIMEO_BASE = 'https://vimeo.com'
const VIMEO_PLAYER_BASE = 'https://player.vimeo.com'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
const CDN_PRIORITY = ['akfire_interconnect_quic', 'fastly_skyfire']
const REQUEST_TIMEOUT = 15000
const CACHE_TTL = 60000
const CACHE_MAX_SIZE = 100

const SEGMENT_HIGH_WATER_MARK = 64 * 1024
const PROGRESSIVE_HIGH_WATER_MARK = 16 * 1024

function parseJson(data) {
  try {
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : data
    return JSON.parse(str)
  } catch {
    return null
  }
}

function unescapeString(text) {
  if (!text) return ''
  return String(text)
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\"/g, '"')
    .replace(/&amp;/g, '&')
}

function extractVideoId(url) {
  if (!url) return null
  for (const pattern of VIMEO_PATTERNS) {
    const match = url.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

function extractHashParam(url) {
  try {
    return new URL(url).searchParams.get('h')
  } catch {
    return null
  }
}

function decompressBody(body, encoding) {
  if (!encoding || !body) return body
  try {
    switch (encoding) {
      case 'gzip':
        return zlib.gunzipSync(body)
      case 'deflate':
        return zlib.inflateSync(body)
      case 'br':
        return zlib.brotliDecompressSync(body)
      default:
        return body
    }
  } catch {
    return body
  }
}

function sortTracksByQuality(tracks) {
  return [...tracks].sort((a, b) => {
    const aSampleRate = a.sample_rate || a.audio_sample_rate || 0
    const bSampleRate = b.sample_rate || b.audio_sample_rate || 0

    const aIs48k = aSampleRate >= 44100
    const bIs48k = bSampleRate >= 44100
    if (aIs48k && !bIs48k) return -1
    if (bIs48k && !aIs48k) return 1

    const aBitrate = a.avg_bitrate || a.bitrate || 0
    const bBitrate = b.avg_bitrate || b.bitrate || 0
    return bBitrate - aBitrate
  })
}

function selectBestAudioTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null

  const validTracks = tracks.filter((track) => track?.segments?.length > 0)
  if (validTracks.length === 0) return null

  const mp42AacTracks = validTracks.filter((track) => {
    const codecs = track.codecs || ''
    const format = track.format || ''
    return (
      codecs.includes('mp4a') &&
      (format === 'mp42' || format === 'iso5' || format === 'iso6')
    )
  })

  if (mp42AacTracks.length > 0) {
    const sorted = sortTracksByQuality(mp42AacTracks)
    const selected = sorted[0]
    logger(
      'debug',
      'Sources',
      `[vimeo] Selected mp42 AAC audio track: ${selected.codecs} @ ${selected.avg_bitrate || selected.bitrate}bps, ${selected.sample_rate || selected.audio_sample_rate}Hz`
    )
    return selected
  }

  const aacTracks = validTracks.filter((track) => {
    const codecs = track.codecs || ''
    return codecs.includes('mp4a')
  })

  if (aacTracks.length > 0) {
    const sorted = sortTracksByQuality(aacTracks)
    const selected = sorted[0]
    logger(
      'debug',
      'Sources',
      `[vimeo] Selected AAC audio track (dash format): ${selected.codecs} @ ${selected.avg_bitrate || selected.bitrate}bps, ${selected.sample_rate || selected.audio_sample_rate}Hz`
    )
    return selected
  }

  logger(
    'warn',
    'Sources',
    `[vimeo] No AAC tracks found, using first available`
  )
  return validTracks.reduce((prev, curr) => {
    const prevBitrate = prev?.avg_bitrate || prev?.bitrate || 0
    const currBitrate = curr?.avg_bitrate || curr?.bitrate || 0
    return currBitrate > prevBitrate ? curr : prev
  }, validTracks[0])
}

function buildSegmentUrl(playlistUrl, basePath, trackPath, segmentPath) {
  try {
    const urlWithoutQuery = playlistUrl.split('?')[0]
    const playlistDir = urlWithoutQuery.substring(
      0,
      urlWithoutQuery.lastIndexOf('/') + 1
    )
    const relativePath = (basePath || '') + (trackPath || '') + segmentPath
    return new URL(relativePath, playlistDir).href
  } catch (err) {
    logger(
      'error',
      'Sources',
      `[vimeo] Failed to build segment URL: ${err.message}`
    )
    return null
  }
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const isHttps = urlObj.protocol === 'https:'
    const httpLib = isHttps ? https : http

    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      ...options.headers
    }

    const req = httpLib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers,
        timeout: options.timeout || REQUEST_TIMEOUT
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()

          const redirectUrl = res.headers.location.startsWith('/')
            ? `${urlObj.protocol}//${urlObj.host}${res.headers.location}`
            : res.headers.location
          return httpRequest(redirectUrl, options).then(resolve).catch(reject)
        }

        const chunks = []
        let totalSize = 0
        const maxSize = options.maxSize || 10 * 1024 * 1024

        res.on('data', (chunk) => {
          totalSize += chunk.length
          if (totalSize > maxSize) {
            res.destroy(new Error('Response too large'))
            return
          }
          chunks.push(chunk)
        })

        res.once('error', (err) => {
          chunks.length = 0
          reject(err)
        })

        res.once('end', () => {
          const rawBody = Buffer.concat(chunks)
          chunks.length = 0

          const body = decompressBody(rawBody, res.headers['content-encoding'])
          resolve({ statusCode: res.statusCode, headers: res.headers, body })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'))
    })

    req.once('error', reject)
    req.end()
  })
}

class StreamingRequest {
  constructor(url, outputStream) {
    this.url = url
    this.outputStream = outputStream
    this.request = null
    this.response = null
    this.destroyed = false
  }

  start() {
    if (this.destroyed) return
    this._makeRequest()
  }

  _makeRequest() {
    const urlObj = new URL(this.url)
    const isHttps = urlObj.protocol === 'https:'
    const httpLib = isHttps ? https : http

    this.request = httpLib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          Connection: 'keep-alive'
        },
        timeout: REQUEST_TIMEOUT
      },
      (res) => {
        if (this.destroyed) {
          res.destroy()
          return
        }

        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()

          const redirectUrl = res.headers.location.startsWith('/')
            ? `${urlObj.protocol}//${urlObj.host}${res.headers.location}`
            : res.headers.location

          this.url = redirectUrl
          this.request = null
          this.response = null
          this._makeRequest()
          return
        }

        if (res.statusCode >= 400) {
          this.destroy(new Error(`HTTP ${res.statusCode}`))
          return
        }

        this.response = res
        this._pipeResponse()
      }
    )

    this.request.once('error', (err) => this.destroy(err))
    this.request.once('timeout', () =>
      this.destroy(new Error('Request timeout'))
    )
    this.request.end()
  }

  _pipeResponse() {
    const res = this.response
    const stream = this.outputStream

    res.on('data', (chunk) => {
      if (this.destroyed || stream.destroyed) {
        this.destroy()
        return
      }

      const canContinue = stream.write(chunk)
      if (!canContinue) {
        res.pause()
        stream.once('drain', () => {
          if (!this.destroyed && !stream.destroyed && !res.destroyed) {
            res.resume()
          }
        })
      }
    })

    res.once('end', () => {
      if (!this.destroyed && !stream.destroyed) {
        stream.emit('finishBuffering')
        stream.end()
      }
      this.cleanup()
    })

    res.once('error', (err) => this.destroy(err))
    res.once('close', () => this.cleanup())

    stream.once('close', () => this.destroy())
  }

  destroy(error = null) {
    if (this.destroyed) return
    this.destroyed = true

    if (this.response && !this.response.destroyed) {
      this.response.removeAllListeners()
      this.response.destroy()
    }

    if (this.request && !this.request.destroyed) {
      this.request.removeAllListeners()
      this.request.destroy()
    }

    if (error && this.outputStream && !this.outputStream.destroyed) {
      this.outputStream.destroy(error)
    }

    this.cleanup()
  }

  cleanup() {
    this.request = null
    this.response = null
    this.outputStream = null
  }
}

function curlRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s',
      '-L',
      '-A',
      USER_AGENT,
      '-H',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
      '-H',
      'Accept-Encoding: gzip, deflate, br',
      '-H',
      'DNT: 1',
      '-H',
      'Connection: keep-alive',
      '-H',
      'Upgrade-Insecure-Requests: 1',
      '-H',
      'Sec-Fetch-Dest: iframe',
      '-H',
      'Sec-Fetch-Mode: navigate',
      '-H',
      'Sec-Fetch-Site: cross-site',
      '--compressed',
      '-w',
      '\n%{http_code}',
      '-m',
      String(Math.floor(REQUEST_TIMEOUT / 1000))
    ]

    if (options.referer) args.push('-H', `Referer: ${options.referer}`)
    if (options.origin) args.push('-H', `Origin: ${options.origin}`)
    args.push(url)

    const curlProcess = spawn('curl', args)
    const outputChunks = []
    let isCompleted = false

    const cleanup = () => {
      outputChunks.length = 0
      curlProcess.stdout.removeAllListeners()
      curlProcess.stderr.removeAllListeners()
      curlProcess.removeAllListeners()
    }

    const timeoutId = setTimeout(() => {
      if (!isCompleted) {
        isCompleted = true
        curlProcess.kill('SIGTERM')
        cleanup()
        reject(new Error('curl timeout'))
      }
    }, REQUEST_TIMEOUT)

    curlProcess.stdout.on('data', (chunk) => outputChunks.push(chunk))
    curlProcess.stderr.resume()

    curlProcess.on('error', (err) => {
      clearTimeout(timeoutId)
      if (!isCompleted) {
        isCompleted = true
        cleanup()
        reject(err)
      }
    })

    curlProcess.on('close', (exitCode) => {
      clearTimeout(timeoutId)
      if (isCompleted) return
      isCompleted = true

      if (exitCode !== 0) {
        cleanup()
        return reject(new Error(`curl exited with code ${exitCode}`))
      }

      const output = Buffer.concat(outputChunks).toString('utf8')
      outputChunks.length = 0

      const lastNewlineIndex = output.lastIndexOf('\n')
      const statusCode = parseInt(output.slice(lastNewlineIndex + 1), 10) || 0
      const bodyText = output.slice(0, lastNewlineIndex)

      cleanup()
      resolve({
        statusCode,
        headers: {},
        body: Buffer.from(bodyText, 'utf8')
      })
    })
  })
}

class SegmentStreamer {
  constructor(playlistData, outputStream) {
    this.playlistData = playlistData
    this.outputStream = outputStream
    this.aborted = false
    this.segmentsFetched = 0
    this.bytesWritten = 0
  }

  async start() {
    const {
      playlistUrl,
      basePath,
      trackPath,
      initSegment,
      segments,
      isDashFormat
    } = this.playlistData

    const onClose = () => this.abort()
    const onError = () => this.abort()

    this.outputStream.once('close', onClose)
    this.outputStream.once('error', onError)

    try {
      if (initSegment && !this.aborted) {
        const initBuffer = Buffer.from(initSegment, 'base64')
        logger(
          'debug',
          'Sources',
          `[vimeo] Writing init segment: ${initBuffer.length} bytes (dash: ${isDashFormat})`
        )

        const canContinue = await this._writeToStream(initBuffer)
        if (!canContinue) {
          logger(
            'warn',
            'Sources',
            `[vimeo] Stream closed before init segment complete`
          )
          return
        }
        this.bytesWritten += initBuffer.length
      }

      for (let i = 0; i < segments.length; i++) {
        if (this.aborted || this.outputStream.destroyed) break

        const segmentData = await this._fetchSegment(
          playlistUrl,
          basePath,
          trackPath,
          segments[i].url
        )

        if (this.aborted) break

        if (segmentData?.length) {
          const canContinue = await this._writeToStream(segmentData)
          if (!canContinue) break

          this.segmentsFetched++
          this.bytesWritten += segmentData.length
        } else {
          logger(
            'warn',
            'Sources',
            `[vimeo] Failed to fetch segment ${i + 1}/${segments.length}`
          )
        }
      }

      logger(
        'debug',
        'Sources',
        `[vimeo] Streaming complete: ${this.segmentsFetched}/${segments.length} segments, ${this.bytesWritten} bytes`
      )

      if (!this.aborted && !this.outputStream.destroyed) {
        this.outputStream.emit('finishBuffering')
        this.outputStream.end()
      }
    } catch (error) {
      logger(
        'error',
        'Sources',
        `[vimeo] Segment streaming error: ${error.message}`
      )
      if (!this.outputStream.destroyed) {
        this.outputStream.destroy(error)
      }
    } finally {
      this.outputStream.removeListener('close', onClose)
      this.outputStream.removeListener('error', onError)
      this.cleanup()
    }
  }

  async _fetchSegment(playlistUrl, basePath, trackPath, segmentPath) {
    if (this.aborted) return null

    const segmentUrl = buildSegmentUrl(
      playlistUrl,
      basePath,
      trackPath,
      segmentPath
    )
    if (!segmentUrl) {
      logger(
        'error',
        'Sources',
        `[vimeo] Failed to build segment URL for: ${segmentPath}`
      )
      return null
    }

    try {
      const response = await httpRequest(segmentUrl, {
        headers: {
          Accept: '*/*',
          Origin: VIMEO_BASE,
          Referer: `${VIMEO_BASE}/`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site'
        },
        timeout: REQUEST_TIMEOUT,
        maxSize: 5 * 1024 * 1024
      })

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return response.body
      }

      logger(
        'warn',
        'Sources',
        `[vimeo] Segment fetch returned ${response.statusCode}`
      )
    } catch (err) {
      logger('warn', 'Sources', `[vimeo] Segment fetch error: ${err.message}`)
    }

    return null
  }

  async _writeToStream(data) {
    if (this.aborted || this.outputStream.destroyed || !data?.length) {
      return false
    }

    const canWriteMore = this.outputStream.write(data)

    if (!canWriteMore && !this.outputStream.destroyed) {
      await new Promise((resolve) => {
        const onDrain = () => {
          this.outputStream.removeListener('close', onClose)
          resolve()
        }
        const onClose = () => {
          this.outputStream.removeListener('drain', onDrain)
          resolve()
        }

        this.outputStream.once('drain', onDrain)
        this.outputStream.once('close', onClose)
      })
    }

    return !this.aborted && !this.outputStream.destroyed
  }

  abort() {
    this.aborted = true
  }

  cleanup() {
    this.aborted = true
    this.playlistData = null
    this.outputStream = null
  }
}

export default class VimeoSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = []
    this.patterns = VIMEO_PATTERNS
    this.priority = 70
    this._cache = new Map()
    this._curlAvailable = null
    this._activeStreams = new Set()
  }

  _getCached(key) {
    const entry = this._cache.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this._cache.delete(key)
      return null
    }
    return entry.value
  }

  _setCache(key, value) {
    const now = Date.now()

    for (const [k, v] of this._cache) {
      if (now >= v.expiresAt) this._cache.delete(k)
    }

    while (this._cache.size >= CACHE_MAX_SIZE) {
      const firstKey = this._cache.keys().next().value
      this._cache.delete(firstKey)
    }

    this._cache.set(key, { value, expiresAt: now + CACHE_TTL })
  }

  async _checkCurlAvailability() {
    if (this._curlAvailable !== null) return this._curlAvailable

    return new Promise((resolve) => {
      const curlProcess = spawn('curl', ['--version'])

      curlProcess.on('error', () => {
        this._curlAvailable = false
        resolve(false)
      })

      curlProcess.on('close', (code) => {
        this._curlAvailable = code === 0
        resolve(this._curlAvailable)
      })

      curlProcess.stdout.resume()
      curlProcess.stderr.resume()
    })
  }

  async setup() {
    await this._checkCurlAvailability()
    return true
  }

  match(url) {
    return extractVideoId(url) !== null
  }

  async search() {
    return { loadType: 'empty', data: {} }
  }

  async resolve(url) {
    const videoId = extractVideoId(url)
    const hashParam = extractHashParam(url)

    if (!videoId) return { loadType: 'empty', data: {} }

    const metadata = await this._fetchVideoMetadata(videoId, hashParam)
    if (!metadata?.title) return { loadType: 'empty', data: {} }

    const trackInfo = {
      title: metadata.title,
      author: metadata.author || 'Unknown',
      length: metadata.durationMs || 0,
      identifier: videoId,
      isSeekable: true,
      isStream: false,
      uri: `https://vimeo.com/${videoId}${hashParam ? '?h=' + hashParam : ''}`,
      artworkUrl: metadata.artworkUrl || null,
      isrc: null,
      sourceName: 'vimeo',
      position: 0,
      userData: hashParam ? { vimeo: { h: hashParam } } : undefined
    }

    return {
      loadType: 'track',
      data: { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: {} }
    }
  }

  async getTrackUrl(decodedTrack) {
    const videoId = decodedTrack?.identifier
    const hashParam = decodedTrack?.userData?.vimeo?.h || null

    if (!videoId) {
      return {
        exception: {
          message: 'Invalid Vimeo track identifier',
          severity: 'fault'
        }
      }
    }

    const cacheKey = `stream:${videoId}:${hashParam || ''}`
    const cached = this._getCached(cacheKey)
    if (cached) return cached

    try {
      const result = await this._extractFromEmbed(videoId, hashParam)
      if (result?.playlistData || result?.url) {
        this._setCache(cacheKey, result)
        return result
      }
    } catch (err) {
      logger(
        'warn',
        'Sources',
        `[vimeo] Embed extraction failed for ${videoId}: ${err.message}`
      )
    }

    return {
      exception: {
        message:
          'Failed to extract Vimeo stream. Video may be private or require authentication.',
        severity: 'fault',
        cause: 'Upstream'
      }
    }
  }

  async loadStream(decodedTrack, url, protocol) {
    const isProgressive = protocol === 'https' || protocol === 'http'
    const highWaterMark = isProgressive
      ? PROGRESSIVE_HIGH_WATER_MARK
      : SEGMENT_HIGH_WATER_MARK

    const stream = new PassThrough({
      highWaterMark,
      emitClose: true,
      autoDestroy: true
    })

    this._activeStreams.add(stream)

    const cleanup = () => {
      this._activeStreams.delete(stream)
      stream._streamingRequest = null
      stream._segmentStreamer = null
    }

    stream.once('close', cleanup)
    stream.once('error', cleanup)

    if (isProgressive) {
      const streamingRequest = new StreamingRequest(url, stream)
      stream._streamingRequest = streamingRequest
      streamingRequest.start()
      return { stream }
    }

    if (protocol === 'segmented') {
      const cacheKey = `stream:${decodedTrack.identifier}:${decodedTrack.userData?.vimeo?.h || ''}`
      const cached = this._getCached(cacheKey)

      if (!cached?.playlistData) {
        stream.destroy(new Error('Vimeo stream metadata not found'))
        return { stream }
      }

      const playlistDataCopy = {
        playlistUrl: cached.playlistData.playlistUrl,
        basePath: cached.playlistData.basePath,
        trackPath: cached.playlistData.trackPath,
        initSegment: cached.playlistData.initSegment,
        segments: cached.playlistData.segments.map((s) => ({ ...s })),
        duration: cached.playlistData.duration,
        bitrate: cached.playlistData.bitrate,
        codecs: cached.playlistData.codecs,
        sampleRate: cached.playlistData.sampleRate,
        clipId: cached.playlistData.clipId,
        isDashFormat: cached.playlistData.isDashFormat
      }

      const segmentStreamer = new SegmentStreamer(playlistDataCopy, stream)
      stream._segmentStreamer = segmentStreamer

      setImmediate(() => {
        segmentStreamer.start().catch((err) => {
          if (!stream.destroyed) {
            stream.destroy(err)
          }
        })
      })

      return { stream }
    }

    stream.destroy(new Error(`Unsupported protocol: ${protocol}`))
    return { stream }
  }

  cleanupAllStreams() {
    for (const stream of this._activeStreams) {
      if (!stream.destroyed) {
        stream.destroy()
      }
    }
    this._activeStreams.clear()
    this._cache.clear()
  }

  async _fetchVideoMetadata(videoId, hashParam) {
    try {
      const targetUrl = hashParam
        ? `https://vimeo.com/${videoId}?h=${hashParam}`
        : `https://vimeo.com/${videoId}`

      const oembedUrl = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(targetUrl)}`
      const response = await httpRequest(oembedUrl, {
        headers: { Accept: 'application/json' },
        maxSize: 1024 * 1024
      })

      if (response.statusCode >= 400) {
        return this._fetchMetadataFromApiV2(videoId)
      }

      const data = parseJson(response.body)
      if (!data?.title) return this._fetchMetadataFromApiV2(videoId)

      return {
        title: data.title,
        author: data.author_name || 'Unknown',
        durationMs: (data.duration || 0) * 1000,
        artworkUrl: data.thumbnail_url || null
      }
    } catch {
      return this._fetchMetadataFromApiV2(videoId)
    }
  }

  async _fetchMetadataFromApiV2(videoId) {
    try {
      const response = await httpRequest(
        `https://vimeo.com/api/v2/video/${videoId}.json`,
        {
          headers: { Accept: 'application/json' },
          maxSize: 1024 * 1024
        }
      )

      if (response.statusCode >= 400) return null

      const data = parseJson(response.body)
      if (!Array.isArray(data) || !data[0]) return null

      const video = data[0]
      return {
        title: video.title || 'Unknown',
        author: video.user_name || 'Unknown',
        durationMs: (video.duration || 0) * 1000,
        artworkUrl: video.thumbnail_large || video.thumbnail_medium || null
      }
    } catch {
      return null
    }
  }

  async _extractFromEmbed(videoId, hashParam) {
    const playerUrl = hashParam
      ? `${VIMEO_PLAYER_BASE}/video/${videoId}?h=${hashParam}&app_id=122963`
      : `${VIMEO_PLAYER_BASE}/video/${videoId}?app_id=122963`

    let response

    if (this._curlAvailable) {
      try {
        response = await curlRequest(playerUrl, {
          referer: `${VIMEO_BASE}/${videoId}`,
          origin: VIMEO_BASE
        })
      } catch {
        response = await httpRequest(playerUrl, {
          headers: {
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Sec-Fetch-Dest': 'iframe',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'cross-site',
            Referer: `${VIMEO_BASE}/${videoId}`,
            Origin: VIMEO_BASE
          },
          maxSize: 5 * 1024 * 1024
        })
      }
    } else {
      response = await httpRequest(playerUrl, {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Sec-Fetch-Dest': 'iframe',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'cross-site',
          Referer: `${VIMEO_BASE}/${videoId}`,
          Origin: VIMEO_BASE
        },
        maxSize: 5 * 1024 * 1024
      })
    }

    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}`)
    }

    const html = response.body.toString('utf8')

    if (html.includes('Just a moment') || html.includes('challenge-platform')) {
      throw new Error('Cloudflare challenge detected')
    }

    return this._parsePageForConfig(html, playerUrl, videoId)
  }

  async _parsePageForConfig(html, refererUrl, videoId) {
    const configUrlMatch =
      html.match(/"config_url"\s*:\s*"([^"]+)"/i) ||
      html.match(/"configUrl"\s*:\s*"([^"]+)"/i) ||
      html.match(/data-config-url="([^"]+)"/i)

    if (configUrlMatch?.[1]) {
      try {
        const result = await this._fetchConfigFromUrl(
          unescapeString(configUrlMatch[1]),
          refererUrl,
          videoId
        )
        if (result) return result
      } catch {}
    }

    const configPatterns = [
      /window\.playerConfig\s*=\s*(\{[\s\S]*?\});\s*(?:window\.|<\/script>|if\s*\()/i,
      /window\.playerConfig\s*=\s*(\{[\s\S]*?"video"[\s\S]*?\})\s*;/i,
      /"config"\s*:\s*(\{[\s\S]*?"request"[\s\S]*?\})\s*[,}]/i
    ]

    for (const pattern of configPatterns) {
      const match = html.match(pattern)
      if (match) {
        const config = this._parseJsonConfig(match[1])
        if (config) {
          const result = await this._extractPlaylistFromConfig(
            config,
            refererUrl,
            videoId
          )
          if (result) return result
        }
      }
    }

    const cdnMatch = html.match(
      /(https?:\/\/[^"'\s\\]*vimeocdn\.com[^"'\s\\]*playlist\.json[^"'\s\\]*)/i
    )
    if (cdnMatch?.[1]) {
      try {
        const result = await this._fetchPlaylist(
          unescapeString(cdnMatch[1]),
          videoId
        )
        if (result) return result
      } catch {}
    }

    const progressiveMatch = html.match(/"progressive"\s*:\s*\[([\s\S]*?)\]/i)
    if (progressiveMatch?.[1]) {
      const result = this._handleProgressiveUrls(progressiveMatch[1], videoId)
      if (result) return result
    }

    throw new Error('No config found in embed page')
  }

  _handleProgressiveUrls(progressiveJson, videoId) {
    try {
      const urls = []
      let pos = 0

      while (true) {
        const urlStart = progressiveJson.indexOf('"url"', pos)
        if (urlStart === -1) break

        const valueStart = progressiveJson.indexOf('"', urlStart + 5)
        if (valueStart === -1) break

        const valueEnd = progressiveJson.indexOf('"', valueStart + 1)
        if (valueEnd === -1) break

        const url = unescapeString(
          progressiveJson.substring(valueStart + 1, valueEnd)
        )

        let height = 0
        const heightMatch = progressiveJson
          .substring(pos, urlStart)
          .match(/"height"\s*:\s*(\d+)/i)
        if (heightMatch) {
          height = parseInt(heightMatch[1], 10)
        } else {
          const afterHeightMatch = progressiveJson
            .substring(valueEnd)
            .match(/"height"\s*:\s*(\d+)/i)
          if (afterHeightMatch) {
            height = parseInt(afterHeightMatch[1], 10)
          }
        }

        let quality = ''
        const qualityMatch = progressiveJson
          .substring(pos, valueEnd + 100)
          .match(/"quality"\s*:\s*"([^"]+)"/i)
        if (qualityMatch) {
          quality = qualityMatch[1]
        }

        urls.push({ url, height, quality })
        pos = valueEnd + 1
      }

      urls.sort((a, b) => a.height - b.height)
      const best = urls.find((p) => p.height >= 360) || urls[urls.length - 1]

      if (best?.url) {
        logger(
          'warn',
          'Sources',
          `[vimeo] Using progressive stream for ${videoId} (${best.height}p)`
        )
        return {
          url: best.url,
          protocol: 'https',
          format: 'mp4',
          additionalData: {
            source: 'vimeo.progressive',
            quality: best.quality,
            height: best.height
          }
        }
      }
    } catch {}
    return null
  }

  _parseJsonConfig(configString) {
    try {
      let braceDepth = 0
      let endIndex = 0

      for (let i = 0; i < configString.length; i++) {
        if (configString[i] === '{') braceDepth++
        else if (configString[i] === '}') braceDepth--
        if (braceDepth === 0 && i > 0) {
          endIndex = i + 1
          break
        }
      }

      return parseJson(
        configString.substring(0, endIndex || configString.length)
      )
    } catch {
      return null
    }
  }

  async _fetchConfigFromUrl(configUrl, refererUrl, videoId) {
    if (configUrl.startsWith('/')) {
      const refUrl = new URL(refererUrl)
      configUrl = `${refUrl.protocol}//${refUrl.host}${configUrl}`
    }

    const response = await httpRequest(configUrl, {
      headers: {
        Accept: 'application/json',
        Referer: refererUrl,
        Origin: VIMEO_BASE
      },
      maxSize: 2 * 1024 * 1024
    })

    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}`)
    }

    const config = parseJson(response.body)
    if (!config) throw new Error('Invalid config JSON')

    return this._extractPlaylistFromConfig(config, configUrl, videoId)
  }

  async _extractPlaylistFromConfig(config, refererUrl, videoId) {
    let files = config?.request?.files
    if (!files) {
      files = config?.video?.files || config?.files || config?.clip?.files
    }
    if (!files) {
      const nestedConfig =
        config?.config || config?.player?.config || config?.data?.config
      if (nestedConfig) {
        return this._extractPlaylistFromConfig(
          nestedConfig,
          refererUrl,
          videoId
        )
      }
    }

    if (!files) {
      throw new Error('No files in config')
    }

    const dashConfig = files.dash
    if (dashConfig?.cdns) {
      let selectedCdn = null
      for (const cdnName of CDN_PRIORITY) {
        if (dashConfig.cdns[cdnName]) {
          selectedCdn = dashConfig.cdns[cdnName]
          break
        }
      }
      if (!selectedCdn) {
        selectedCdn =
          dashConfig.cdns[dashConfig.default_cdn] ||
          Object.values(dashConfig.cdns)[0]
      }

      if (selectedCdn) {
        let playlistUrl = unescapeString(selectedCdn.avc_url || selectedCdn.url)
        if (playlistUrl) {
          if (
            !playlistUrl.includes('playlist.json') &&
            !playlistUrl.includes('master.json')
          ) {
            playlistUrl = playlistUrl.replace(
              /\/[^/?]+(\?|$)/,
              '/playlist.json$1'
            )
          }
          if (!playlistUrl.includes('omit=')) {
            playlistUrl +=
              (playlistUrl.includes('?') ? '&' : '?') + 'omit=av1-hevc'
          }

          try {
            return await this._fetchPlaylist(playlistUrl, videoId)
          } catch {}
        }
      }
    }

    const hlsConfig = files.hls
    if (hlsConfig?.cdns) {
      let selectedCdn = null
      for (const cdnName of CDN_PRIORITY) {
        if (hlsConfig.cdns[cdnName]) {
          selectedCdn = hlsConfig.cdns[cdnName]
          break
        }
      }
      if (!selectedCdn) {
        selectedCdn =
          hlsConfig.cdns[hlsConfig.default_cdn] ||
          Object.values(hlsConfig.cdns)[0]
      }

      if (selectedCdn?.url) {
        return {
          url: unescapeString(selectedCdn.url),
          protocol: 'hls',
          format: 'hls',
          additionalData: { source: 'vimeo.hls' }
        }
      }
    }

    const progressive = files.progressive
    if (Array.isArray(progressive) && progressive.length > 0) {
      const sorted = [...progressive].sort(
        (a, b) => (a.height || 0) - (b.height || 0)
      )
      const best =
        sorted.find((p) => (p.height || 0) >= 360) || sorted[sorted.length - 1]

      if (best?.url) {
        logger(
          'warn',
          'Sources',
          `[vimeo] Using progressive stream for ${videoId}`
        )
        return {
          url: best.url,
          protocol: 'https',
          format: 'mp4',
          additionalData: {
            source: 'vimeo.progressive',
            quality: best.quality,
            height: best.height
          }
        }
      }
    }

    throw new Error('No playable streams in config')
  }

  async _fetchPlaylist(playlistUrl, videoId) {
    const response = await httpRequest(playlistUrl, {
      headers: {
        Accept: '*/*',
        Origin: VIMEO_BASE,
        Referer: `${VIMEO_BASE}/`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      maxSize: 2 * 1024 * 1024
    })

    if (response.statusCode >= 400) {
      throw new Error(`HTTP ${response.statusCode}`)
    }

    const playlist = parseJson(response.body)
    if (!playlist) {
      throw new Error('Invalid playlist JSON')
    }

    if (playlist.audio?.length) {
      logger(
        'debug',
        'Sources',
        `[vimeo] Found ${playlist.audio.length} audio tracks for ${videoId}`
      )
      for (const track of playlist.audio) {
        logger(
          'debug',
          'Sources',
          `[vimeo]   - ${track.codecs} @ ${track.avg_bitrate || track.bitrate}bps, ${track.sample_rate}Hz, format: ${track.format}, base: ${track.base_url?.substring(0, 30)}...`
        )
      }
    }

    if (playlist.audio?.length) {
      const audioTrack = selectBestAudioTrack(playlist.audio)
      if (audioTrack) {
        const segments = audioTrack.segments.map((seg) => ({
          url: seg.url,
          start: seg.start,
          end: seg.end,
          size: seg.size
        }))

        const sampleRate =
          audioTrack.sample_rate || audioTrack.audio_sample_rate || 48000
        const isDashFormat = audioTrack.format === 'dash'

        let basePath = playlist.base_url || ''
        let trackPath = audioTrack.base_url || ''

        if (!basePath && !trackPath) {
          basePath = '../../../../../'
        } else if (basePath && !basePath.endsWith('/')) {
          basePath += '/'
        }

        if (trackPath && !trackPath.endsWith('/')) {
          trackPath += '/'
        }

        const playlistData = {
          playlistUrl,
          basePath,
          trackPath,
          initSegment: audioTrack.init_segment || null,
          segments,
          duration: audioTrack.duration,
          bitrate: audioTrack.avg_bitrate || audioTrack.bitrate,
          codecs: audioTrack.codecs,
          sampleRate,
          clipId: playlist.clip_id,
          isDashFormat
        }

        logger(
          'debug',
          'Sources',
          `[vimeo] Using audio: ${audioTrack.codecs} @ ${playlistData.bitrate}bps, ${sampleRate}Hz, ${segments.length} segments, format: ${audioTrack.format}`
        )

        return {
          url: playlistUrl,
          protocol: 'segmented',
          format: 'mp4',
          playlistData,
          additionalData: {
            source: 'vimeo.adaptive',
            bitrate: playlistData.bitrate,
            codecs: playlistData.codecs,
            segments: segments.length,
            sampleRate,
            format: audioTrack.format
          }
        }
      }
    }

    if (playlist.video?.length) {
      logger(
        'warn',
        'Sources',
        `[vimeo] No compatible audio tracks, falling back to video track`
      )

      const video = playlist.video.reduce((best, v) => {
        const bw = v.avg_bitrate || v.bitrate || 0
        return bw > (best?.avg_bitrate || best?.bitrate || 0) ? v : best
      }, null)

      if (video?.segments?.length) {
        const segments = video.segments.map((seg) => ({
          url: seg.url,
          start: seg.start,
          end: seg.end,
          size: seg.size
        }))

        const playlistData = {
          playlistUrl,
          basePath: playlist.base_url || '',
          trackPath: video.base_url || '',
          initSegment: video.init_segment || null,
          segments,
          duration: video.duration,
          bitrate: video.avg_bitrate || video.bitrate,
          codecs: video.codecs,
          clipId: playlist.clip_id,
          isDashFormat: video.format === 'dash'
        }

        return {
          url: playlistUrl,
          protocol: 'segmented',
          format: 'mp4',
          playlistData,
          additionalData: {
            source: 'vimeo.video-only',
            segments: segments.length
          }
        }
      }
    }
    // vou chorar no banho... - toddy
    // not 100% of the songs are working
    throw new Error('No compatible audio tracks in playlist')
  }
}
