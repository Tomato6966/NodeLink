import { PassThrough } from 'node:stream'
import { http1makeRequest, logger, makeRequest } from '../../utils.js'
import CipherManager from './CipherManager.js'
import Android from './clients/Android.js'
import AndroidVR from './clients/AndroidVR.js'
import IOS from './clients/IOS.js'
import Music from './clients/Music.js'
import TV from './clients/TV.js'
import TVEmbedded from './clients/TVEmbedded.js'
import Web from './clients/Web.js'
import { checkURLType, YOUTUBE_CONSTANTS } from './common.js'
import OAuth from './OAuth.js'

const CHUNK_SIZE = 512 * 1024
const MAX_RETRIES = 3
const MAX_URL_REFRESH = 5
const VISITOR_DATA_INTERVAL = 3600000
const PLAYLIST_FALLBACK_SEGMENTS = 3

async function _manageYoutubeHlsStream(
  hlsManifestUrl,
  outputStream,
  cancelSignal,
  guildId,
  source
) {
  const segmentQueue = []
  const processedSegments = new Set()

  const cleanup = () => {
    cancelSignal.aborted = true
    outputStream.stopHls = null
    if (guildId && source) {
      source.activeStreams.delete(guildId)
    }
  }

  outputStream.once('close', cleanup)
  outputStream.once('error', cleanup)
  outputStream.stopHls = cleanup

  const fetchWithUserAgent = (url) => http1makeRequest(url, { method: 'GET' })

  const playlistFetcher = async (playlistUrl) => {
    let isFirstFetch = true

    while (!cancelSignal.aborted) {
      try {
        const {
          body: playlistContent,
          error,
          statusCode
        } = await fetchWithUserAgent(playlistUrl)

        if (error || statusCode !== 200) {
          logger(
            'error',
            'YouTube-HLS-Fetcher',
            `Playlist fetch failed: ${statusCode} - ${error?.message}`
          )
          return
        }

        const lines = playlistContent.split('\n').map((l) => l.trim())
        let targetDuration = 2
        const targetDurationLine = lines.find((l) =>
          l.startsWith('#EXT-X-TARGETDURATION:')
        )
        if (targetDurationLine)
          targetDuration = Number.parseInt(targetDurationLine.split(':')[1], 10)

        const currentSegments = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const segmentUrl = lines[i + 1]
            if (segmentUrl && !segmentUrl.startsWith('#')) {
              currentSegments.push(new URL(segmentUrl, playlistUrl).toString())
            }
          }
        }

        if (isFirstFetch) {
          const startIdx = Math.max(
            0,
            currentSegments.length - PLAYLIST_FALLBACK_SEGMENTS
          )
          for (let i = 0; i < currentSegments.length; i++) {
            const url = currentSegments[i]
            processedSegments.add(url)
            if (i >= startIdx) segmentQueue.push(url)
          }
          isFirstFetch = false
        } else {
          for (const url of currentSegments) {
            if (!processedSegments.has(url)) {
              processedSegments.add(url)
              segmentQueue.push(url)
            }
          }
        }

        if (playlistContent.includes('#EXT-X-ENDLIST')) return

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, targetDuration) * 1000)
        )
      } catch (e) {
        logger('error', 'YouTube-HLS-Fetcher', `Error: ${e.message}`)
        return
      }
    }
  }

  const segmentDownloader = async () => {
    while (!cancelSignal.aborted || segmentQueue.length > 0) {
      if (segmentQueue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }

      const segmentUrl = segmentQueue.shift()
      if (cancelSignal.aborted) break

      try {
        const res = await http1makeRequest(segmentUrl, { streamOnly: true })

        if (res.error || res.statusCode !== 200) {
          logger(
            'warn',
            'YouTube-HLS-Downloader',
            `Failed segment ${segmentUrl}: ${res.statusCode}`
          )
          if (res.stream) res.stream.destroy()
          continue
        }

        if (outputStream.destroyed || cancelSignal.aborted) {
          res.stream.destroy()
          break
        }

        await new Promise((resolve, reject) => {
          res.stream.pipe(outputStream, { end: false })
          res.stream.on('end', resolve)
          res.stream.on('error', (err) => {
            if (err.message === 'aborted' || err.code === 'ECONNRESET')
              resolve()
            else reject(err)
          })
        })
      } catch (e) {
        if (!cancelSignal.aborted && e.message !== 'aborted') {
          logger(
            'error',
            'YouTube-HLS-Downloader',
            `Error processing segment ${segmentUrl}: ${e.message}`
          )
        }
      }
    }

    if (!outputStream.destroyed) {
      outputStream.emit('finishBuffering')
      outputStream.end()
    }
  }

  try {
    const {
      body: masterPlaylistContent,
      error: masterError,
      statusCode: masterStatusCode
    } = await fetchWithUserAgent(hlsManifestUrl)

    if (masterError || masterStatusCode !== 200) {
      throw new Error(
        `Master playlist fetch failed: ${masterStatusCode} - ${masterError?.message}`
      )
    }

    const lines = masterPlaylistContent.split('\n').map((l) => l.trim())
    let bestStreamUrl = null
    let bestAudioOnlyUrl = null
    let bestBandwidth = 0
    let bestAudioOnlyBandwidth = 0

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const streamInf = lines[i]
        const streamUrl = lines[i + 1]

        if (streamUrl && !streamUrl.startsWith('#')) {
          const bandwidthMatch = streamInf.match(/BANDWIDTH=(\d+)/)
          const codecsMatch = streamInf.match(/CODECS="([^"]+)"/)

          const bandwidth = bandwidthMatch
            ? Number.parseInt(bandwidthMatch[1], 10)
            : 0
          const codecs = codecsMatch ? codecsMatch[1] : ''

          if (codecs.includes('avc1') && codecs.includes('mp4a')) {
            if (bandwidth > bestBandwidth) {
              bestBandwidth = bandwidth
              bestStreamUrl = new URL(streamUrl, hlsManifestUrl).toString()
            }
          } else if (codecs.includes('mp4a') || codecs.includes('opus')) {
            if (bandwidth > bestAudioOnlyBandwidth) {
              bestAudioOnlyBandwidth = bandwidth
              bestAudioOnlyUrl = new URL(streamUrl, hlsManifestUrl).toString()
            }
          }
        }
      }
    }

    const selectedPlaylistUrl = bestStreamUrl || bestAudioOnlyUrl
    if (!selectedPlaylistUrl) throw new Error('No suitable HLS stream found')

    logger('debug', 'YouTube-HLS', `Selected stream: ${selectedPlaylistUrl}`)

    Promise.all([playlistFetcher(selectedPlaylistUrl), segmentDownloader()])
  } catch (e) {
    logger('error', 'YouTube-HLS', `Error managing HLS stream: ${e.message}`)
    if (!outputStream.destroyed) outputStream.destroy(e)
  }
}

export default class YouTubeSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources.youtube
    this.searchTerms = ['youtube', 'ytsearch', 'ytmsearch']
    this.patterns = [
      /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+)|youtu\.be\/[\w-]+)/,
      /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^https?:\/\/music\.youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+)/
    ]

    this.priority = 100
    this.clients = {}
    this.oauth = null
    this.visitorDataInterval = null
    this.cipherManager = new CipherManager(nodelink)
    this.activeStreams = new Map()
    this.ytContext = {
      client: {
        screenDensityFloat: 1,
        screenHeightPoints: 1080,
        screenPixelDensity: 1,
        screenWidthPoints: 1920,
        hl: 'en',
        gl: 'US',
        visitorData: null
      }
    }
  }

  async setup() {
    logger('info', 'YouTube', 'Setting up YouTube source...')

    this.oauth = new OAuth(this.nodelink)

    const clientClasses = {
      Android,
      AndroidVR,
      IOS,
      Music,
      TV,
      TVEmbedded,
      Web
    }

    for (const clientName in clientClasses) {
      this.clients[clientName] = new clientClasses[clientName](
        this.nodelink,
        this.oauth
      )
    }

    logger(
      'debug',
      'YouTube',
      `Initialized clients: ${Object.keys(this.clients).join(', ')}`
    )

    await this._fetchVisitorData()
    await this.cipherManager.getCachedPlayerScript()
    await this.cipherManager.checkCipherServerStatus()

    if (this.visitorDataInterval) clearInterval(this.visitorDataInterval)
    this.visitorDataInterval = setInterval(
      () => this._fetchVisitorData(),
      VISITOR_DATA_INTERVAL
    )

    logger('info', 'YouTube', 'YouTube source setup complete.')
    return true
  }

  cleanup() {
    logger('info', 'YouTube', 'Cleaning up YouTube source...')

    for (const [guildId, cancelSignal] of this.activeStreams.entries()) {
      cancelSignal.aborted = true
    }
    this.activeStreams.clear()

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }

    if (this.oauth) this.oauth.cleanup?.()
  }

  async _fetchVisitorData() {
    logger('debug', 'YouTube', 'Fetching visitor data...')
    let playerScriptUrl = null

    try {
      const {
        body: data,
        error,
        statusCode
      } = await makeRequest('https://www.youtube.com', { method: 'GET' })
      let visitorFound = false

      if (!error && statusCode === 200) {
        const visitorMatch = data?.match(/"VISITOR_DATA":"([^"]+)"/)
        if (visitorMatch?.[1]) {
          this.ytContext.client.visitorData = visitorMatch[1]
          visitorFound = true
        }

        const playerScriptMatch = data?.match(/"jsUrl":"([^"]+)"/)
        if (playerScriptMatch?.[1]) {
          playerScriptUrl = playerScriptMatch[1].replace(
            /\/[a-z]{2}_[A-Z]{2}\//,
            '/en_US/'
          )
          logger('debug', 'YouTube', `Player script URL: ${playerScriptUrl}`)
        }
      }

      if (!visitorFound) {
        logger(
          'warn',
          'YouTube',
          `Failed to fetch visitor data: ${error?.message || `Status ${statusCode}`}`
        )

        const {
          body: guideData,
          error: guideError,
          statusCode: guideStatusCode
        } = await makeRequest('https://www.youtube.com/youtubei/v1/guide', {
          method: 'POST',
          body: { context: this.ytContext },
          disableBodyCompression: true
        })

        if (
          !guideError &&
          guideStatusCode === 200 &&
          guideData.responseContext?.visitorData
        ) {
          this.ytContext.client.visitorData =
            guideData.responseContext.visitorData
        }
      }
    } catch (e) {
      logger('error', 'YouTube', `Error fetching visitor data: ${e.message}`)
    }

    if (playerScriptUrl) this.cipherManager.setPlayerScriptUrl(playerScriptUrl)
  }

  async search(query, type) {
    const clientList = this.config.clients.search
    const clientErrors = []

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting search with client: ${clientName}`
        )
        const result = await client.search(query, type, this.ytContext)

        if (result && result.loadType === 'search') {
          logger(
            'debug',
            'YouTube',
            `Search successful with client: ${clientName}`
          )
          return result
        }

        const errorMessage =
          result?.data?.message || 'Client returned empty or failed.'
        clientErrors.push({ client: clientName, message: errorMessage })
        logger(
          'debug',
          'YouTube',
          `Client ${clientName} returned empty or failed search.`
        )
      } catch (e) {
        clientErrors.push({ client: clientName, message: e.message })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception during search: ${e.message}`
        )
      }
    }

    logger(
      'error',
      'YouTube',
      'No search results found from any configured client.'
    )
    return {
      exception: {
        message: 'No search results found from any configured client.',
        severity: 'fault',
        cause: 'All clients failed.',
        errors: clientErrors
      }
    }
  }

  async resolve(url, type) {
    const isMusicUrl = url.includes('music.youtube.com')
    const sourceType = isMusicUrl ? 'ytmusic' : 'youtube'

    let processUrl = url
    if (isMusicUrl) {
      processUrl = url.replace('music.youtube.com', 'www.youtube.com')
      logger('debug', 'YouTube', `Converted YouTube Music URL: ${processUrl}`)
    }

    const clientList =
      this.config.clients.resolve || this.config.clients.playback
    logger(
      'debug',
      'YouTube',
      `Using resolve clients: ${clientList.join(', ')}`
    )

    const clientErrors = []
    const urlType = checkURLType(processUrl, sourceType)

    if (urlType === YOUTUBE_CONSTANTS.PLAYLIST) {
      const androidClient = this.clients.Android
      if (androidClient) {
        try {
          logger(
            'debug',
            'YouTube',
            'Attempting to resolve playlist with Android client.'
          )
          const result = await androidClient.resolve(
            processUrl,
            type,
            this.ytContext,
            this.cipherManager
          )

          if (
            result &&
            (result.loadType === 'track' || result.loadType === 'playlist')
          ) {
            logger(
              'debug',
              'YouTube',
              'Successfully resolved playlist with Android client.'
            )
            return result
          }

          const errorMessage =
            result?.data?.message || 'Android client failed for playlist.'
          clientErrors.push({ client: 'Android', message: errorMessage })
          logger(
            'debug',
            'YouTube',
            'Android client returned empty or failed to resolve playlist.'
          )
        } catch (e) {
          clientErrors.push({ client: 'Android', message: e.message })
          logger(
            'warn',
            'YouTube',
            `Android client threw an exception during playlist resolve: ${e.message}`
          )
        }
      } else {
        clientErrors.push({
          client: 'Android',
          message: 'Android client not available.'
        })
        logger(
          'warn',
          'YouTube',
          'Android client not available for playlist priority.'
        )
      }
    }

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue
      if (urlType === YOUTUBE_CONSTANTS.PLAYLIST && clientName === 'Android')
        continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to resolve URL with client: ${clientName}`
        )
        const result = await client.resolve(
          processUrl,
          type,
          this.ytContext,
          this.cipherManager
        )

        if (
          result &&
          (result.loadType === 'track' || result.loadType === 'playlist')
        ) {
          logger(
            'debug',
            'YouTube',
            `Successfully resolved URL with client: ${clientName}`
          )
          return result
        }

        const errorMessage =
          result?.data?.message || 'Client returned empty or failed.'
        clientErrors.push({ client: clientName, message: errorMessage })
        logger(
          'debug',
          'YouTube',
          `Client ${clientName} returned empty or failed to resolve URL.`
        )
      } catch (e) {
        clientErrors.push({ client: clientName, message: e.message })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception during resolve: ${e.message}`
        )
      }
    }

    logger('error', 'YouTube', 'All clients failed to resolve the URL.')
    return {
      exception: {
        message: 'All clients failed to resolve the URL.',
        severity: 'fault',
        cause: 'All clients failed.',
        errors: clientErrors
      }
    }
  }

  async resolveHoloTrack(vanillaTrack, options = {}) {
    try {
      const { info, userData } = vanillaTrack

      const webClient = this.clients.Web
      if (!webClient) {
        logger(
          'warn',
          'YouTube',
          'Web client not available for Holo resolution'
        )
        return vanillaTrack
      }

      const videoId = info.identifier
      const playerResponse = await webClient._makePlayerRequest(
        videoId,
        this.ytContext,
        {},
        this.cipherManager
      )

      if (!playerResponse || playerResponse.error) return vanillaTrack

      const { buildHoloTrack } = await import('./common.js')

      const holoTrack = await buildHoloTrack(
        info,
        null,
        info.sourceName === 'ytmusic' ? 'ytmusic' : 'youtube',
        playerResponse,
        {
          fetchChannelInfo: options.fetchChannelInfo ?? false,
          resolveExternalLinks: options.resolveExternalLinks ?? false
        }
      )

      if (holoTrack) holoTrack.userData = userData
      return holoTrack
    } catch (err) {
      logger('error', 'YouTube', `Failed to resolve Holo track: ${err.message}`)
      return vanillaTrack
    }
  }

  async getTrackUrl(decodedTrack, itag) {
    const clientList = this.config.clients.playback
    const clientErrors = []

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to get track URL for ${decodedTrack.title} with client: ${clientName}`
        )
        const urlData = await client.getTrackUrl(
          decodedTrack,
          this.ytContext,
          this.cipherManager,
          itag
        )

        if (urlData.exception) {
          clientErrors.push({
            client: clientName,
            message: urlData.exception.message
          })
          logger(
            'debug',
            'YouTube',
            `Client ${clientName} failed: ${urlData.exception.message}`
          )
          continue
        }

        if (urlData.url) {
          const check = await http1makeRequest(urlData.url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true
          })

          if (check.stream) check.stream.destroy()

          if (
            !check.error &&
            (check.statusCode === 200 || check.statusCode === 206)
          ) {
            logger(
              'debug',
              'YouTube',
              `URL pre-flight check successful for client ${clientName}.`
            )
            return urlData
          }

          const errorMessage = `URL pre-flight failed. Status: ${check.statusCode}, Error: ${check.error?.message}`
          clientErrors.push({
            client: clientName,
            message: `Direct URL: ${errorMessage}`
          })
          logger('warn', 'YouTube', `Client ${clientName}: ${errorMessage}`)

          if (check.statusCode === 403 && urlData.hlsUrl) {
            logger(
              'warn',
              'YouTube',
              `Direct URL 403, attempting HLS fallback for client ${clientName}.`
            )
            const hlsCheck = await http1makeRequest(urlData.hlsUrl, {
              method: 'GET',
              headers: { Range: 'bytes=0-0' },
              streamOnly: true
            })

            if (hlsCheck.stream) hlsCheck.stream.destroy()

            if (
              !hlsCheck.error &&
              (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206)
            ) {
              logger(
                'debug',
                'YouTube',
                `HLS fallback check successful for client ${clientName}.`
              )
              return { url: urlData.hlsUrl, protocol: 'hls', format: 'mpegts' }
            }

            const hlsError = `HLS fallback failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error?.message}`
            clientErrors.push({ client: clientName, message: hlsError })
            logger('warn', 'YouTube', `Client ${clientName}: ${hlsError}`)
          }
        } else if (urlData.hlsUrl) {
          const hlsCheck = await http1makeRequest(urlData.hlsUrl, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true
          })

          if (hlsCheck.stream) hlsCheck.stream.destroy()

          if (
            !hlsCheck.error &&
            (hlsCheck.statusCode === 200 || hlsCheck.statusCode === 206)
          ) {
            logger(
              'debug',
              'YouTube',
              `HLS-only check successful for client ${clientName}.`
            )
            return { url: urlData.hlsUrl, protocol: 'hls', format: 'mpegts' }
          }

          const hlsError = `HLS-only check failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error?.message}`
          clientErrors.push({ client: clientName, message: hlsError })
          logger('warn', 'YouTube', `Client ${clientName}: ${hlsError}`)
        }
      } catch (e) {
        clientErrors.push({ client: clientName, message: e.message })
        logger(
          'warn',
          'YouTube',
          `Client ${clientName} threw an exception in getTrackUrl: ${e.message}`
        )
      }
    }

    logger(
      'error',
      'YouTube',
      'Failed to get a working track URL from any configured client.'
    )
    return {
      exception: {
        message: 'Failed to get a working track URL from any client.',
        severity: 'fault',
        cause: 'All clients failed.',
        errors: clientErrors
      }
    }
  }

  async loadStream(decodedTrack, url, protocol, guildId) {
    logger(
      'debug',
      'YouTube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )

    const cancelSignal = { aborted: false }
    if (guildId) this.activeStreams.set(guildId, cancelSignal)

    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        _manageYoutubeHlsStream(url, stream, cancelSignal, guildId, this)

        const originalDestroy = stream.destroy.bind(stream)
        stream.destroy = (err) => {
          cancelSignal.aborted = true
          if (guildId) this.activeStreams.delete(guildId)
          originalDestroy(err)
        }

        return { stream }
      }

      if (!url) throw new Error('No direct URL')

      const testResponse = await http1makeRequest(url, { method: 'HEAD' })
      const contentLength = testResponse.headers?.['content-length']
        ? Number.parseInt(testResponse.headers['content-length'], 10)
        : null

      if (testResponse.statusCode === 403)
        throw new Error('URL returned 403 Forbidden')

      if (contentLength && contentLength > 0) {
        logger(
          'debug',
          'YouTube',
          `Using range buffering for ${decodedTrack.title} (${Math.round(contentLength / 1024 / 1024)}MB)`
        )
        const result = this._streamWithRangeRequests(
          url,
          contentLength,
          decodedTrack,
          cancelSignal,
          guildId
        )
        return result
      }

      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.statusCode !== 200 && response.statusCode !== 206)
        throw new Error(`HTTP status ${response.statusCode}`)

      const stream = new PassThrough()
      stream.responseStream = response.stream

      const cleanup = () => {
        cancelSignal.aborted = true
        response.stream.removeAllListeners()
        if (response.stream && !response.stream.destroyed)
          response.stream.destroy()
        if (guildId) this.activeStreams.delete(guildId)
      }

      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => {
        cleanup()
        stream.emit('finishBuffering')
      })
      response.stream.on('error', (error) => {
        cleanup()

        if (error.message === 'aborted' || error.code === 'ECONNRESET') {
          logger('debug', 'YouTube', 'Client disconnected from stream')
          if (!stream.destroyed) stream.destroy()
          return
        }

        logger('error', 'YouTube', `Stream error: ${error.message}`)
        if (!stream.destroyed) {
          stream.emit('error', new Error(`Stream failed: ${error.message}`))
          stream.destroy()
        }
      })

      const originalDestroy = stream.destroy.bind(stream)
      stream.destroy = (err) => {
        cleanup()
        originalDestroy(err)
      }

      stream.once('end', cleanup)
      stream.once('error', cleanup)
      stream.once('close', cleanup)

      return { stream }
    } catch (e) {
      if (guildId) this.activeStreams.delete(guildId)
      logger(
        'error',
        'YouTube',
        `Error loading stream for ${decodedTrack.identifier}: ${e.message}`
      )
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Upstream' }
      }
    }
  }

  _streamWithRangeRequests(
    url,
    contentLength,
    decodedTrack,
    cancelSignal,
    guildId
  ) {
    const stream = new PassThrough({ highWaterMark: CHUNK_SIZE * 2 })
    let position = 0
    let errors = 0
    let refreshes = 0
    let currentUrl = url
    let destroyed = false
    let fetching = false
    let activeRequest = null
    let recoverTimeout = null

    const cleanup = () => {
      if (destroyed) return
      destroyed = true
      cancelSignal.aborted = true

      stream.removeListener('drain', onDrain)

      if (activeRequest) activeRequest.destroy()
      if (recoverTimeout) clearTimeout(recoverTimeout)
      if (guildId) this.activeStreams.delete(guildId)
    }

    const onDrain = () => {
      if (destroyed || cancelSignal.aborted) return
      fetchNext()
    }

    stream.on('drain', onDrain)
    stream.once('close', cleanup)
    stream.once('error', cleanup)

    const fetchNext = async () => {
      if (destroyed || cancelSignal.aborted || position >= contentLength) {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
        return
      }

      if (fetching) return
      fetching = true

      const start = position
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1)

      try {
        const {
          stream: responseStream,
          error,
          statusCode
        } = await http1makeRequest(currentUrl, {
          method: 'GET',
          headers: { Range: `bytes=${start}-${end}` },
          streamOnly: true
        })

        if (destroyed || cancelSignal.aborted) {
          responseStream?.destroy()
          return
        }

        activeRequest = responseStream

        if (error || (statusCode !== 206 && statusCode !== 200)) {
          throw new Error(`Range request failed: ${statusCode}`)
        }

        responseStream.on('data', (chunk) => {
          if (destroyed || cancelSignal.aborted) {
            responseStream.destroy()
            return
          }
          position += chunk.length
          const ok = stream.write(chunk)
          if (!ok) responseStream.pause()
        })

        responseStream.on('end', () => {
          activeRequest = null
          fetching = false
          if (!destroyed && position < contentLength) fetchNext()
          else if (!stream.writableEnded) {
            stream.emit('finishBuffering')
            stream.end()
          }
        })

        responseStream.on('error', () => {
          activeRequest = null
          fetching = false
          if (++errors >= MAX_RETRIES) recover()
          else
            setTimeout(
              fetchNext,
              Math.min(1000 * Math.pow(2, errors - 1), 5000)
            )
        })

        stream.once('drain', () => responseStream.resume())
      } catch (err) {
        activeRequest = null
        fetching = false
        if (++errors >= MAX_RETRIES) recover()
        else
          setTimeout(fetchNext, Math.min(1000 * Math.pow(2, errors - 1), 5000))
      }
    }

    const recover = async () => {
      if (destroyed || cancelSignal.aborted) return

      if (++refreshes > MAX_URL_REFRESH) {
        if (!stream.destroyed)
          stream.destroy(new Error('Max recovery attempts'))
        return
      }

      try {
        const newUrlData = await this.getTrackUrl(decodedTrack)
        if (destroyed || cancelSignal.aborted) return

        if (newUrlData.exception || !newUrlData.url) throw new Error('No URL')

        const test = await http1makeRequest(newUrlData.url, {
          method: 'GET',
          headers: { Range: `bytes=${position}-${position}` },
          streamOnly: true
        })
        test.stream?.destroy()

        if (test.statusCode !== 206 && test.statusCode !== 200)
          throw new Error('Test failed')

        currentUrl = newUrlData.url
        errors = 0
        fetchNext()
      } catch (error) {
        logger('error', 'YouTube', `Recovery failed: ${error.message}`)
        if (!destroyed && !cancelSignal.aborted) {
          recoverTimeout = setTimeout(recover, 2000)
        }
      }
    }

    fetchNext()

    const originalDestroy = stream.destroy.bind(stream)
    stream.destroy = (err) => {
      cleanup()
      originalDestroy(err)
    }

    return { stream }
  }

  async getChapters(trackInfo) {
    const webClient = this.clients.Web
    if (!webClient) {
      logger(
        'warn',
        'YouTube',
        'Web client not available for fetching chapters.'
      )
      return []
    }

    try {
      return await webClient.getChapters(trackInfo, this.ytContext)
    } catch (e) {
      logger('error', 'YouTube', `Failed to fetch chapters: ${e.message}`)
      return []
    }
  }
}
