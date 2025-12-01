import { PassThrough } from 'node:stream'
import {
  http1makeRequest,
  loadHLSPlaylist,
  logger,
  makeRequest
} from '../../utils.js'
import { YOUTUBE_CONSTANTS, checkURLType } from './common.js'

import CipherManager from './CipherManager.js'
import OAuth from './OAuth.js'
import Android from './clients/Android.js'
import AndroidVR from './clients/AndroidVR.js'
import IOS from './clients/IOS.js'
import Music from './clients/Music.js'
import TV from './clients/TV.js'
import TVEmbedded from './clients/TVEmbedded.js'
import Web from './clients/Web.js'

async function _manageYoutubeHlsStream(hlsManifestUrl, outputStream) {
  const segmentQueue = []
  const processedSegments = new Set()
  const stopRef = { stop: false }

  outputStream.on('close', () => {
    stopRef.stop = true
  })
  outputStream.on('error', () => {
    stopRef.stop = true
  })

  outputStream.stopHls = () => {
    stopRef.stop = true
  }

  const fetchWithUserAgent = async (url) => {
    return http1makeRequest(url, {
      method: 'GET'
    })
  }

  let isFirstFetch = true

  const playlistFetcher = async (playlistUrl) => {
    while (!stopRef.stop) {
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
          throw new Error(`Playlist fetch failed: ${statusCode}`)
        }

        const lines = playlistContent.split('\n').map((l) => l.trim())
        let targetDuration = 2 // Default HLS target duration
        const targetDurationLine = lines.find((l) =>
          l.startsWith('#EXT-X-TARGETDURATION:')
        )
        if (targetDurationLine) {
          targetDuration = Number.parseInt(targetDurationLine.split(':')[1], 10)
        }

        const currentSegments = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const segmentUrl = lines[i + 1]
            if (segmentUrl && !segmentUrl.startsWith('#')) {
              const absoluteUrl = new URL(segmentUrl, playlistUrl).toString()
              currentSegments.push(absoluteUrl)
            }
          }
        }

        if (isFirstFetch) {
          const startIdx = Math.max(0, currentSegments.length - 3)
          for (let i = 0; i < currentSegments.length; i++) {
            const url = currentSegments[i]
            processedSegments.add(url)
            if (i >= startIdx) {
              segmentQueue.push(url)
            }
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

        if (playlistContent.includes('#EXT-X-ENDLIST')) {
          stopRef.stop = true
        }

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, targetDuration) * 1000)
        )
      } catch (e) {
        logger('error', 'YouTube-HLS-Fetcher', `Error: ${e.message}`)
        stopRef.stop = true
      }
    }
  }

  const segmentDownloader = async () => {
    while (!stopRef.stop || segmentQueue.length > 0) {
      if (segmentQueue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }

      const segmentUrl = segmentQueue.shift()

      if (stopRef.stop) continue

      let segmentStream = null
      try {
        const res = await http1makeRequest(segmentUrl, {
          streamOnly: true
        })
        segmentStream = res.stream

        if (res.error || res.statusCode !== 200) {
          logger(
            'warn',
            'YouTube-HLS-Downloader',
            `Failed segment ${segmentUrl}: ${res.statusCode}`
          )
          if (segmentStream) segmentStream.destroy()
          continue
        }

        if (outputStream.destroyed) {
          segmentStream.destroy()
          continue
        }

        await new Promise((resolve, reject) => {
          segmentStream.pipe(outputStream, { end: false })
          segmentStream.on('end', resolve)
          segmentStream.on('error', (err) => {
            if (err.message === 'aborted' || err.code === 'ECONNRESET') {
              resolve()
            } else {
              reject(err)
            }
          })
        })
      } catch (e) {
        if (segmentStream && !segmentStream.destroyed) {
          segmentStream.destroy()
        }
        if (!stopRef.stop && e.message !== 'aborted') {
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
    let bestBandwidth = 0
    let bestStreamUrl = null
    let bestAudioOnlyUrl = null
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

    let selectedPlaylistUrl = null
    if (bestStreamUrl) {
      selectedPlaylistUrl = bestStreamUrl
      logger(
        'debug',
        'YouTube-HLS',
        `Selected best combined stream: ${selectedPlaylistUrl}`
      )
    } else if (bestAudioOnlyUrl) {
      selectedPlaylistUrl = bestAudioOnlyUrl
      logger(
        'debug',
        'YouTube-HLS',
        `Selected best audio-only stream: ${selectedPlaylistUrl}`
      )
    } else {
      throw new Error('No suitable HLS stream found in master playlist.')
    }

    playlistFetcher(selectedPlaylistUrl)
    segmentDownloader()
  } catch (e) {
    logger(
      'error',
      'YouTube-HLS',
      `Error managing YouTube HLS stream: ${e.message}`
    )
    if (!outputStream.destroyed) {
      outputStream.destroy(e)
    }
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

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
    }
    this.visitorDataInterval = setInterval(
      () => this._fetchVisitorData(),
      3600000
    )

    logger('info', 'YouTube', 'YouTube source setup complete.')
    return true
  }

  cleanup() {
    logger('info', 'YouTube', 'Cleaning up YouTube source...')
    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }
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
          playerScriptUrl = playerScriptMatch[1]
          playerScriptUrl = playerScriptUrl.replace(
            /\/[a-z]{2}_[A-Z]{2}\//,
            '/en_US/'
          )
          logger(
            'debug',
            'YouTube',
            `Extracted and standardized player script URL from main page: ${playerScriptUrl}`
          )
        }
      }

      if (!visitorFound) {
        logger(
          'warn',
          'YouTube',
          `Failed to fetch initial page for visitor data: ${error?.message || `Status ${statusCode}`}`
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
    if (playerScriptUrl) {
      this.cipherManager.setPlayerScriptUrl(playerScriptUrl)
    }
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
      logger(
        'debug',
        'YouTube',
        `Converted YouTube Music URL to standard format: ${processUrl}`
      )
    }

    const clientList =
      this.config.clients.resolve || this.config.clients.playback

    logger(
      'debug',
      'YouTube',
      `Using resolve clients for URL resolution: ${clientList.join(', ')}`
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
            'Attempting to resolve playlist URL with Android client (priority).'
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
              'Successfully resolved playlist URL with Android client.'
            )
            return result
          }
          const errorMessage =
            result?.data?.message ||
            'Android client returned empty or failed for playlist.'
          clientErrors.push({ client: 'Android', message: errorMessage })
          logger(
            'debug',
            'YouTube',
            'Android client returned empty or failed to resolve playlist URL.'
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
      const { encoded, info, userData } = vanillaTrack

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

      if (!playerResponse || playerResponse.error) {
        return vanillaTrack
      }

      const { buildHoloTrack } = await import('./common.js')

      const holoTrack = await buildHoloTrack(
        info,
        null, // itemData
        info.sourceName === 'ytmusic' ? 'ytmusic' : 'youtube',
        playerResponse,
        {
          fetchChannelInfo: options.fetchChannelInfo ?? false,
          resolveExternalLinks: options.resolveExternalLinks ?? false
        }
      )

      if (holoTrack) {
        holoTrack.userData = userData
      }

      return holoTrack
    } catch (err) {
      logger('error', 'YouTube', `Failed to resolve Holo track: ${err.message}`)
      return vanillaTrack
    }
  }

  async getTrackUrl(decodedTrack) {
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
          this.cipherManager
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
          const getCheck = await http1makeRequest(urlData.url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true
          })

          if (getCheck.stream) getCheck.stream.destroy()

          if (
            !getCheck.error &&
            (getCheck.statusCode === 200 || getCheck.statusCode === 206)
          ) {
            logger(
              'debug',
              'YouTube',
              `URL pre-flight GET check successful for client ${clientName}.`
            )
            return urlData
          }

          const errorMessage = `URL pre-flight GET check failed. Status: ${getCheck.statusCode}, Error: ${getCheck.error?.message}`
          clientErrors.push({
            client: clientName,
            message: `Direct URL: ${errorMessage}`
          })
          logger('warn', 'YouTube', `Client ${clientName}: ${errorMessage}`)

          if (getCheck.statusCode === 403 && urlData.hlsUrl) {
            logger(
              'warn',
              'YouTube',
              `Direct URL failed with 403, attempting HLS fallback for client ${clientName}.`
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
                `HLS fallback URL pre-flight GET check successful for client ${clientName}.`
              )
              return {
                url: urlData.hlsUrl,
                protocol: 'hls',
                format: 'mpegts'
              }
            }

            const hlsError = `HLS fallback URL pre-flight GET check failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error?.message}`
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
              `HLS-only URL pre-flight GET check successful for client ${clientName}.`
            )
            return {
              url: urlData.hlsUrl,
              protocol: 'hls',
              format: 'mpegts'
            }
          }

          const hlsError = `HLS-only URL pre-flight GET check failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error?.message}`
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

  async loadStream(decodedTrack, url, protocol, additionalData) {
    logger(
      'debug',
      'YouTube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )
    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        _manageYoutubeHlsStream(url, stream)
        return { stream }
      }

      if (!url) throw new Error('No direct URL')

      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.statusCode !== 200 && response.statusCode !== 206)
        throw new Error(`HTTP status ${response.statusCode}`)

      const stream = new PassThrough()
      // vou salvar a stream pro streamConnector, dai o codigo consegue se comunicar direito, fechando a stream do youtube
      stream.responseStream = response.stream

      const cleanupListeners = () => {
        response.stream.removeListener('data', dataHandler)
        response.stream.removeListener('end', endHandler)
        response.stream.removeListener('error', errorHandler)
        if (response.stream && !response.stream.destroyed) {
          response.stream.destroy()
        }
      }

      const dataHandler = (chunk) => stream.write(chunk)
      const endHandler = () => {
        cleanupListeners()
        stream.emit('finishBuffering')
      }
      const errorHandler = (error) => {
        cleanupListeners()

        const isClientDisconnect =
          error.message === 'aborted' || error.code === 'ECONNRESET'
        if (isClientDisconnect) {
          logger('debug', 'YouTube', 'Client disconnected from stream')
          if (!stream.destroyed) {
            stream.destroy()
          }
          return
        }

        logger('error', 'YouTube', `Stream error: ${error.message}`)
        if (!stream.destroyed) {
          stream.emit('error', new Error(`Stream failed: ${error.message}`))
          stream.destroy()
        }
      }

      response.stream.on('data', dataHandler)
      response.stream.on('end', endHandler)
      response.stream.on('error', errorHandler)

      stream.on('end', cleanupListeners)
      stream.on('error', cleanupListeners)
      stream.on('close', cleanupListeners)

      return { stream }
    } catch (e) {
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

  async getChapters(trackInfo) {
    const webClient = this.clients.Web
    if (!webClient) {
      logger('warn', 'YouTube', 'Web client not available for fetching chapters.')
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
