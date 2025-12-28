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

const CHUNK_SIZE = 64 * 1024
const MAX_RETRIES = 3
const MAX_URL_REFRESH = 10
const VISITOR_DATA_INTERVAL = 3600000
const PLAYLIST_FALLBACK_SEGMENTS = 3

async function _manageYoutubeHlsStream(
  hlsManifestUrl,
  outputStream,
  cancelSignal,
  streamKey,
  source
) {
  const segmentQueue = []
  const processedSegments = new Set()
  const MAX_PROCESSED_TRACK = 100
  const processedOrder = new Array(MAX_PROCESSED_TRACK)
  let processedIndex = 0
  let cleanedUp = false
  let playlistEnded = false
  const MAX_LIVE_QUEUE_SIZE = 15

  const rememberSegment = (url) => {
    if (processedSegments.has(url)) return false

    const old = processedOrder[processedIndex]
    if (old) processedSegments.delete(old)

    processedSegments.add(url)
    processedOrder[processedIndex] = url
    processedIndex = (processedIndex + 1) % MAX_PROCESSED_TRACK

    return true
  }

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    cancelSignal.aborted = true
    outputStream.stopHls = null
    outputStream.removeListener('close', cleanup)
    outputStream.removeListener('error', cleanup)

    if (source?.activeStreams && streamKey) {
      source.activeStreams.delete(streamKey)
    }

    segmentQueue.length = 0
    processedSegments.clear()
    processedOrder.length = 0
  }

  outputStream.once('close', cleanup)
  outputStream.once('error', cleanup)
  outputStream.stopHls = cleanup

  const fetchWithUserAgent = (url) => http1makeRequest(url, { method: 'GET' })

  const playlistFetcher = async (playlistUrl, isLive = false) => {
    let isFirstFetch = true
    let lastMediaSequence = -1

    try {
      while (!cancelSignal.aborted) {
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
        let mediaSequence = 0

        const targetDurationLine = lines.find((l) =>
          l.startsWith('#EXT-X-TARGETDURATION:')
        )
        if (targetDurationLine) {
          const parts = targetDurationLine.split(':')
          if (parts[1]) {
            const parsed = Number.parseInt(parts[1], 10)
            if (!Number.isNaN(parsed)) targetDuration = parsed
          }
        }

        const mediaSequenceLine = lines.find((l) =>
          l.startsWith('#EXT-X-MEDIA-SEQUENCE:')
        )
        if (mediaSequenceLine) {
          const parts = mediaSequenceLine.split(':')
          if (parts[1]) {
            const parsed = Number.parseInt(parts[1], 10)
            if (!Number.isNaN(parsed)) mediaSequence = parsed
          }
        }

        const currentSegments = []
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXTINF:')) {
            const segmentUrl = lines[i + 1]
            if (segmentUrl && !segmentUrl.startsWith('#')) {
              currentSegments.push(new URL(segmentUrl, playlistUrl).toString())
            }
          }
        }

        if (!isFirstFetch && isLive && mediaSequence > lastMediaSequence + 30) {
          logger(
            'warn',
            'YouTube-HLS-Fetcher',
            `Fell behind live edge (gap: ${mediaSequence - lastMediaSequence}), resetting buffer`
          )
          segmentQueue.length = 0
          processedSegments.clear()
          processedOrder.length = 0
          isFirstFetch = true
        }

        lastMediaSequence = mediaSequence

        if (isFirstFetch) {
          const segmentsToTake = isLive ? 3 : PLAYLIST_FALLBACK_SEGMENTS
          const startIdx = Math.max(0, currentSegments.length - segmentsToTake)
          for (let i = startIdx; i < currentSegments.length; i++) {
            const url = currentSegments[i]
            if (rememberSegment(url)) {
              segmentQueue.push(url)
            }
          }
          isFirstFetch = false
        } else {
          for (const url of currentSegments) {
            if (!processedSegments.has(url)) {
              if (isLive && segmentQueue.length >= MAX_LIVE_QUEUE_SIZE) {
                const oldUrl = segmentQueue.shift()
                if (oldUrl) {
                  processedSegments.delete(oldUrl)
                }
              }

              if (rememberSegment(url)) {
                segmentQueue.push(url)
              }
            }
          }
        }

        if (playlistContent.includes('#EXT-X-ENDLIST')) {
          playlistEnded = true
          return
        }

        await new Promise((resolve) => {
          const timeout = setTimeout(
            resolve,
            Math.max(1, targetDuration) * 1000
          )
          if (typeof timeout.unref === 'function') timeout.unref()
        })
      }
    } finally {
      playlistEnded = true
    }
  }

  const segmentDownloader = async () => {
    let nextSegmentPromise = null

    while (true) {
      if (
        cancelSignal.aborted ||
        (playlistEnded && segmentQueue.length === 0 && !nextSegmentPromise)
      )
        break

      if (segmentQueue.length === 0 && !nextSegmentPromise) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 50)
          if (typeof timeout.unref === 'function') timeout.unref()
        })
        continue
      }

      try {
        let res
        if (nextSegmentPromise) {
          res = await nextSegmentPromise
          nextSegmentPromise = null
        } else {
          const segmentUrl = segmentQueue.shift()
          if (processedSegments.has(segmentUrl)) {
            processedSegments.delete(segmentUrl)
          }
          res = await http1makeRequest(segmentUrl, { streamOnly: true })
        }

        if (
          segmentQueue.length > 0 &&
          !nextSegmentPromise &&
          !cancelSignal.aborted
        ) {
          const nextUrl = segmentQueue.shift()
          if (processedSegments.has(nextUrl)) {
            processedSegments.delete(nextUrl)
          }
          nextSegmentPromise = http1makeRequest(nextUrl, { streamOnly: true })
        }

        if (res.error || res.statusCode !== 200) {
          if (res.stream) res.stream.destroy()
          
          let retryCount = 0
          let success = false
          while (retryCount < 3 && !cancelSignal.aborted) {
             retryCount++
             const retryRes = await http1makeRequest(res.url || segmentQueue[0], { streamOnly: true })
             if (!retryRes.error && retryRes.statusCode === 200) {
                res = retryRes
                success = true
                break
             }
             if (retryRes.stream) retryRes.stream.destroy()
             await new Promise(r => setTimeout(r, 500 * retryCount))
          }

          if (!success) {
             logger(
               'warn',
               'YouTube-HLS-Downloader',
               `Failed segment after retries: ${res.statusCode}`
             )
             continue
          }
        }

        if (outputStream.destroyed || cancelSignal.aborted) {
          if (res.stream && !res.stream.destroyed) res.stream.destroy()
          break
        }

        await new Promise((resolve, reject) => {
          res.stream.pipe(outputStream, { end: false })
          res.stream.on('end', resolve)
          res.stream.on('error', (err) => {
            if (err.message === 'aborted' || err.code === 'ECONNRESET') {
              resolve()
            } else {
              reject(err)
            }
          })
        })
      } catch (e) {
        if (!cancelSignal.aborted && e.message !== 'aborted') {
          logger(
            'error',
            'YouTube-HLS-Downloader',
            `Error processing segment: ${e.message}`
          )
        }
      }
    }

    if (!outputStream.destroyed && !outputStream.writableEnded) {
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
    const isLive =
      masterPlaylistContent.includes('yt_live_broadcast') ||
      masterPlaylistContent.includes('live/1')

    if (isLive) {
      logger(
        'debug',
        'YouTube-HLS',
        'Live stream detected, remember that this is still experimental (for performance reasons)'
      )
    }

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

    await Promise.all([
      playlistFetcher(selectedPlaylistUrl, isLive),
      segmentDownloader()
    ])
  } catch (e) {
    logger('error', 'YouTube-HLS', `Error managing HLS stream: ${e.message}`)
    if (!outputStream.destroyed) outputStream.destroy(e)
  } finally {
    cleanup()
  }
}

export default class YouTubeSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources.youtube
    this.searchTerms = ['youtube', 'ytsearch', 'ytmsearch', 'ytmusic']
    this.patterns = [
      /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[\w-]+(?:&list=[\w-]+)?|playlist\?list=[\w-]+|live\/[\w-]+)|youtu\.be\/[\w-]+)/,
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
    if (typeof this.visitorDataInterval.unref === 'function') {
      this.visitorDataInterval.unref()
    }

    logger('info', 'YouTube', 'YouTube source setup complete.')
    return true
  }

  cleanup() {
    logger('info', 'YouTube', 'Cleaning up YouTube source...')

    for (const [, cancelSignal] of this.activeStreams.entries()) {
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
    const cachedVisitorData = this.nodelink.credentialManager.get('yt_visitor_data')
    const cachedPlayerScript = this.nodelink.credentialManager.get('yt_player_script_url')

    if (cachedVisitorData && cachedPlayerScript) {
      this.ytContext.client.visitorData = cachedVisitorData
      this.cipherManager.setPlayerScriptUrl(cachedPlayerScript)
      logger('debug', 'YouTube', 'Context and player script loaded from cache. Skipping network request.')
      return
    }

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
          this.nodelink.credentialManager.set('yt_visitor_data', visitorMatch[1], 24 * 60 * 60 * 1000)
          visitorFound = true
        }

        const playerScriptMatch = data?.match(/"jsUrl":"([^"]+)"/)
        if (playerScriptMatch?.[1]) {
          playerScriptUrl = playerScriptMatch[1].replace(
            /\/[a-z]{2}_[A-Z]{2}\//,
            '/en_US/'
          )
          this.nodelink.credentialManager.set('yt_player_script_url', playerScriptUrl, 12 * 60 * 60 * 1000)
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

  async search(query, type, searchType = 'track') {
    let clientList = this.config.clients.search

    if (type === 'ytmsearch') {
      clientList = ['Music']
    }

    const clientErrors = []

    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (!client) continue

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting ${searchType} search with client: ${clientName}`
        )
        const result = await client.search(query, searchType, this.ytContext)

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
    const liveMatch = url.match(
      /^https?:\/\/(?:www\.)?youtube\.com\/live\/([\w-]+)/
    )
    if (liveMatch) {
      const videoId = liveMatch[1]
      url = `https://www.youtube.com/watch?v=${videoId}`
      logger('debug', 'YouTube', `Normalized live URL to: ${url}`)
    }
    const isMusicUrl = url.includes('music.youtube.com')
    const sourceType = isMusicUrl ? 'ytmusic' : 'youtube'

    const processUrl = url

    const clientList =
      this.config.clients.resolve || this.config.clients.playback
    logger(
      'debug',
      'YouTube',
      `Using resolve clients: ${clientList.join(', ')}`
    )

    const clientErrors = []
    const urlType = checkURLType(processUrl, sourceType)

    if (isMusicUrl) {
      const musicClient = this.clients.Music
      if (musicClient) {
        try {
          logger(
            'debug',
            'YouTube',
            'Attempting to resolve YouTube Music URL with Music client.'
          )
          const result = await musicClient.resolve(
            processUrl,
            sourceType,
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
              'Successfully resolved YouTube Music URL with Music client.'
            )
            return result
          }

          const listIdMatch = url.match(/[?&]list=([\w-]+)/)
          const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
          const listId = listIdMatch ? listIdMatch[1] : null
          const videoId = videoIdMatch ? videoIdMatch[1] : null
          const fallbackId = listId || videoId

          if (fallbackId) {
            logger(
              'warn',
              'YouTube',
              `Music client failed for ${fallbackId}. Attempting fallback to standard YouTube client.`
            )
            let fallbackUrl
            if (listId) {
              fallbackUrl = `https://www.youtube.com/playlist?list=${listId}`
              if (videoId) {
                fallbackUrl += `&v=${videoId}`
              }
            } else {
              fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`
            }
            const fallbackResult = await this.resolve(fallbackUrl, 'youtube')

            if (
              fallbackResult &&
              (fallbackResult.loadType === 'track' ||
                fallbackResult.loadType === 'playlist')
            ) {
              if (
                fallbackResult.loadType === 'track' &&
                fallbackResult.data?.info
              ) {
                fallbackResult.data.info.sourceName = 'ytmusic'
                fallbackResult.data.info.uri = url
              } else if (
                fallbackResult.loadType === 'playlist' &&
                fallbackResult.data?.tracks
              ) {
                for (const track of fallbackResult.data.tracks) {
                  if (track.info) {
                    track.info.sourceName = 'ytmusic'
                    const trackVideoId = track.info.identifier
                    track.info.uri = `https://music.youtube.com/watch?v=${trackVideoId}`
                  }
                }
              }
              return fallbackResult
            }
          }
          clientErrors.push({
            client: 'Music',
            message:
              'Music client failed or fallback unsuccessful for direct Music URL.'
          })
          logger(
            'error',
            'YouTube',
            'Music client failed for direct Music URL and no fallback yielded a track.'
          )
          return {
            exception: {
              message:
                'Music client failed for direct Music URL and no fallback yielded a track.',
              severity: 'fault',
              cause: 'MusicClientFailure',
              errors: clientErrors
            }
          }
        } catch (e) {
          clientErrors.push({ client: 'Music', message: e.message })
          logger(
            'warn',
            'YouTube',
            `Music client threw an exception during direct Music URL resolve: ${e.message}`
          )
          return {
            exception: {
              message: `Music client failed for direct Music URL: ${e.message}`,
              severity: 'fault',
              cause: 'MusicClientException',
              errors: clientErrors
            }
          }
        }
      }
      const msg = 'Music client not available for direct Music URL.'
      clientErrors.push({ client: 'Music', message: msg })
      logger('error', 'YouTube', msg)
      return {
        exception: {
          message: msg,
          severity: 'fault',
          cause: 'MusicClientNotAvailable',
          errors: clientErrors
        }
      }
    }

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
            sourceType,
            this.ytContext,
            this.cipherManager
          )

          if (
            result &&
            (result.loadType === 'track' ||
              result.loadType === 'playlist' ||
              result.loadType === 'empty')
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

      if (!isMusicUrl && clientName === 'Music') continue
      if (isMusicUrl && clientName !== 'Music' && type !== 'youtube-fallback') {
        continue
      }
      if (
        type === 'youtube-fallback' &&
        !['Android', 'Web'].includes(clientName)
      ) {
        continue
      }

      try {
        logger(
          'debug',
          'YouTube',
          `Attempting to resolve URL with client: ${clientName}`
        )
        const result = await client.resolve(
          processUrl,
          sourceType,
          this.ytContext,
          this.cipherManager
        )

        if (
          isMusicUrl &&
          clientName === 'Music' &&
          result?.loadType === 'error' &&
          result.data?.cause === 'UpstreamPlayability'
        ) {
          const listIdMatch = url.match(/[?&]list=([\w-]+)/)
          const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
          const listId = listIdMatch ? listIdMatch[1] : null
          const videoId = videoIdMatch ? videoIdMatch[1] : null
          const fallbackId = listId || videoId

          if (fallbackId) {
            logger(
              'warn',
              'YouTube',
              `Music client returned Playability Error for ${fallbackId}. Attempting fallback to standard YouTube client.`
            )
            let fallbackUrl
            if (listId) {
              fallbackUrl = `https://www.youtube.com/playlist?list=${listId}`
              if (videoId) {
                fallbackUrl += `&v=${videoId}`
              }
            } else {
              fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`
            }
            const fallbackResult = await this.resolve(fallbackUrl, 'youtube')

            if (
              fallbackResult &&
              (fallbackResult.loadType === 'track' ||
                fallbackResult.loadType === 'playlist' ||
                fallbackResult.loadType === 'empty')
            ) {
              if (
                fallbackResult.loadType === 'track' &&
                fallbackResult.data?.info
              ) {
                fallbackResult.data.info.sourceName = 'ytmusic'
                fallbackResult.data.info.uri = url
              } else if (
                fallbackResult.loadType === 'playlist' &&
                fallbackResult.data?.tracks
              ) {
                for (const track of fallbackResult.data.tracks) {
                  if (track.info) {
                    track.info.sourceName = 'ytmusic'
                    const trackVideoId = track.info.identifier
                    track.info.uri = `https://music.youtube.com/watch?v=${trackVideoId}`
                  }
                }
              }
              return fallbackResult
            }
          }
        }

        if (
          result &&
          (result.loadType === 'track' ||
            result.loadType === 'playlist' ||
            result.loadType === 'empty')
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
            let contentLength = null
            if (check.headers?.['content-range']) {
              const match = check.headers['content-range'].match(/\/(\d+)/)
              if (match) contentLength = Number.parseInt(match[1], 10)
            }
            if (!contentLength && check.headers?.['content-length']) {
              contentLength = Number.parseInt(
                check.headers['content-length'],
                10
              )
            }

            logger(
              'debug',
              'YouTube',
              `URL pre-flight check successful for client ${clientName}.`
            )
            return { ...urlData, additionalData: { contentLength } }
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

    if (decodedTrack.audioTrackId) {
      logger(
        'warn',
        'YouTube',
        `Requested audio track "${decodedTrack.audioTrackId}" not found on any client. Falling back to default audio.`
      )

      const fallbackTrack = { ...decodedTrack }
      delete fallbackTrack.audioTrackId

      return this.getTrackUrl(fallbackTrack, itag)
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

    const cancelSignal = { aborted: false }
    const streamKey = additionalData?.streamKey || Symbol('streamKey')
    this.activeStreams.set(streamKey, cancelSignal)

    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        _manageYoutubeHlsStream(url, stream, cancelSignal, streamKey, this)

        const originalDestroy = stream.destroy.bind(stream)
        stream.destroy = (err) => {
          cancelSignal.aborted = true
          this.activeStreams.delete(streamKey)
          originalDestroy(err)
        }

        return { stream }
      }

      if (!url) throw new Error('No direct URL')

      let contentLength = additionalData?.contentLength || null

      if (!contentLength) {
        const testResponse = await http1makeRequest(url, { method: 'HEAD' })

        if (testResponse.headers?.['content-length']) {
          contentLength = Number.parseInt(
            testResponse.headers['content-length'],
            10
          )
        }

        if (testResponse.statusCode === 403) {
          throw new Error('URL returned 403 Forbidden')
        }

        if (!contentLength) {
          const rangeResponse = await http1makeRequest(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true
          })

          if (rangeResponse.stream) rangeResponse.stream.destroy()

          if (rangeResponse.headers?.['content-range']) {
            const match =
              rangeResponse.headers['content-range'].match(/\/(\d+)/)
            if (match) contentLength = Number.parseInt(match[1], 10)
          }
        }
      }

      if (contentLength && contentLength > 0) {
        logger(
          'debug',
          'YouTube',
          `Using range buffering for ${decodedTrack.title} (${Math.round(contentLength / 1024 / 1024)}MB)`
        )
        return this._streamWithRangeRequests(
          url,
          contentLength,
          decodedTrack,
          cancelSignal,
          streamKey
        )
      }

      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.statusCode !== 200 && response.statusCode !== 206) {
        throw new Error(`HTTP status ${response.statusCode}`)
      }

      const stream = new PassThrough()
      stream.responseStream = response.stream

      let cleanedUp = false
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        cancelSignal.aborted = true
        response.stream.removeAllListeners()
        if (!response.stream.destroyed) response.stream.destroy()
        this.activeStreams.delete(streamKey)
        stream.removeListener('close', cleanup)
      }

      response.stream.on('data', (chunk) => {
        if (!stream.write(chunk)) {
          response.stream.pause()
        }
      })

      stream.on('drain', () => {
        if (!response.stream.destroyed) response.stream.resume()
      })

      response.stream.on('end', () => {
        cleanup()
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
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

      stream.once('close', cleanup)

      return { stream }
    } catch (e) {
      this.activeStreams.delete(streamKey)
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
    streamKey
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
      stream.removeListener('close', cleanup)
      stream.removeListener('end', cleanup)
      stream.removeListener('error', cleanup)

      if (activeRequest) {
        activeRequest.removeAllListeners()
        if (!activeRequest.destroyed) activeRequest.destroy()
        activeRequest = null
      }

      if (recoverTimeout) {
        clearTimeout(recoverTimeout)
        recoverTimeout = null
      }

      this.activeStreams.delete(streamKey)
    }

    const onDrain = () => {
      if (destroyed || cancelSignal.aborted) return
      if (activeRequest && !activeRequest.destroyed) {
        activeRequest.resume()
      }
      if (!fetching && position < contentLength) {
        fetchNext()
      }
    }

    stream.on('drain', onDrain)
    stream.once('close', cleanup)
    stream.once('end', cleanup)
    stream.once('error', cleanup)

    const fetchNext = async () => {
      if (destroyed || cancelSignal.aborted || stream.destroyed) {
        cleanup()
        return
      }

      if (position >= contentLength) {
        if (!stream.writableEnded) {
          stream.emit('finishBuffering')
          stream.end()
        }
        cleanup()
        return
      }

      if (fetching) return
      fetching = true

      const start = position
      const end = Math.min(start + CHUNK_SIZE - 1, contentLength - 1)

      try {
        const result = await http1makeRequest(currentUrl, {
          method: 'GET',
          headers: { Range: `bytes=${start}-${end}` },
          streamOnly: true,
          timeout: 10000
        })

        const responseStream = result.stream
        const { error, statusCode } = result

        if (destroyed || cancelSignal.aborted) {
          if (responseStream && !responseStream.destroyed) {
            responseStream.destroy()
          }
          fetching = false
          return
        }

        activeRequest = responseStream

        if (error || (statusCode !== 200 && statusCode !== 206)) {
          if (statusCode === 403 || statusCode === 404 || statusCode >= 500) {
            logger(
              'warn',
              'YouTube',
              `Got ${statusCode} at pos ${position} → forcing recovery`
            )
            fetching = false
            recover()
            return
          }
          throw new Error(`Range request failed: ${statusCode}`)
        }

        const onData = (chunk) => {
          if (destroyed || cancelSignal.aborted) {
            responseStream.destroy()
            return
          }
          if (refreshes > 0) refreshes = 0
          position += chunk.length
          if (!stream.write(chunk)) {
            responseStream.pause()
          }
        }

        const onEnd = () => {
          cleanupRequestListeners()
          activeRequest = null
          fetching = false
          if (!destroyed && position < contentLength) {
            setImmediate(fetchNext)
          } else if (!stream.writableEnded && position >= contentLength) {
            stream.emit('finishBuffering')
            stream.end()
            cleanup()
          }
        }

        const onError = (err) => {
          cleanupRequestListeners()
          activeRequest = null
          fetching = false
          if (!destroyed) {
            logger(
              'warn',
              'YouTube',
              `Range request error at pos ${position}: ${err.message}`
            )
            const isAborted =
              err.message === 'aborted' || err.code === 'ECONNRESET'
            if (++errors >= MAX_RETRIES || isAborted) {
              if (isAborted)
                logger(
                  'warn',
                  'YouTube',
                  'Connection aborted, forcing immediate recovery with new URL.'
                )
              recover(err)
            } else {
              const timeout = setTimeout(
                fetchNext,
                Math.min(1000 * 2 ** (errors - 1), 5000)
              )
              if (typeof timeout.unref === 'function') timeout.unref()
            }
          }
        }

        const cleanupRequestListeners = () => {
          responseStream.removeListener('data', onData)
          responseStream.removeListener('end', onEnd)
          responseStream.removeListener('error', onError)
        }

        responseStream.on('data', onData)
        responseStream.on('end', onEnd)
        responseStream.on('error', onError)
      } catch (err) {
        activeRequest = null
        fetching = false
        if (!destroyed) {
          logger(
            'warn',
            'YouTube',
            `Range request exception at pos ${position}: ${err.message}`
          )
          const isAborted =
            err.message === 'aborted' || err.code === 'ECONNRESET'
          if (++errors >= MAX_RETRIES || isAborted) {
            if (isAborted)
              logger(
                'warn',
                'YouTube',
                'Connection aborted, forcing immediate recovery with new URL.'
              )
            recover(err)
          } else {
            const timeout = setTimeout(
              fetchNext,
              Math.min(1000 * 2 ** (errors - 1), 5000)
            )
            if (typeof timeout.unref === 'function') timeout.unref()
          }
        }
      }
    }

    const recover = async (causeError) => {
      if (destroyed || cancelSignal.aborted) return

      const isForbidden =
        causeError?.message?.includes('403') || causeError?.statusCode === 403
      const isAborted =
        causeError?.message === 'aborted' || causeError?.code === 'ECONNRESET'

      if (!isForbidden && !isAborted && refreshes === 0) {
        logger(
          'debug',
          'YouTube',
          `Retrying same URL for recovery first (cause: ${causeError?.message})...`
        )
        errors = 0
        fetching = false
        fetchNext()
        refreshes++
        return
      }

      if (++refreshes > MAX_URL_REFRESH) {
        logger('error', 'YouTube', 'Max URL refresh attempts reached')
        if (!stream.destroyed) {
          stream.destroy(new Error('Failed to recover stream'))
        }
        return
      }

      if (stream.destroyed || stream.writableEnded) {
        cleanup()
        return
      }

      try {
        const newUrlData = await this.getTrackUrl(decodedTrack)

        if (destroyed || cancelSignal.aborted) return

        if (newUrlData.exception || !newUrlData.url) {
          throw new Error('No valid URL from getTrackUrl')
        }

        currentUrl = newUrlData.url
        errors = 0
        logger(
          'debug',
          'YouTube',
          `URL recovered for ${decodedTrack.title} (resume at ${position} bytes, attempt ${refreshes}, cause: ${causeError?.message})`
        )
        fetching = false
        fetchNext()
      } catch (error) {
        logger(
          'warn',
          'YouTube',
          `Recovery failed (attempt ${refreshes}): ${error.message}`
        )
        if (!destroyed && !cancelSignal.aborted) {
          recoverTimeout = setTimeout(
            () => recover(causeError),
            4000 + refreshes * 1000
          )
          if (typeof recoverTimeout.unref === 'function') {
            recoverTimeout.unref()
          }
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
