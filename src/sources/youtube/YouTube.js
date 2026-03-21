import { PassThrough } from 'node:stream'
import HLSHandler from '../../playback/hls/HLSHandler.ts'
import {
  getBestMatch,
  http1makeRequest,
  logger,
  makeRequest
} from '../../utils.ts'
import CipherManager from './CipherManager.js'
import Android from './clients/Android.js'
import AndroidVR from './clients/AndroidVR.js'
import IOS from './clients/IOS.js'
import Music from './clients/Music.js'
import TV from './clients/TV.js'
import TVCast from './clients/TVCast.js'
import Web from './clients/Web.js'
import WebRemix from './clients/Web_Remix.js'
import WebEmbedded from './clients/WebEmbedded.js'
import { checkURLType, YOUTUBE_CONSTANTS } from './common.js'
import YouTubeLiveChat from './LiveChat.js'
import OAuth from './OAuth.js'
import { SabrStream } from './sabr/sabr.js'

const CHUNK_SIZE = 64 * 1024
const MAX_RETRIES = 3
const MAX_URL_REFRESH = 10
const VISITOR_DATA_INTERVAL = 3600000

export default class YouTubeSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources.youtube
    this.additionalsSourceName = ['ytmusic']
    this.searchTerms = ['ytsearch', 'ytmsearch']
    this.recommendationTerm = ['ytrec']
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
    this.liveChat = new YouTubeLiveChat(nodelink, this)
    this.activeStreams = new Map()
    this.mirrorFallbackInFlight = new Set()
    this.proxyIndex = 0
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

  getProxy() {
    if (!this.config.proxies || !Array.isArray(this.config.proxies) || this.config.proxies.length === 0) {
      return undefined
    }
    const proxy = this.config.proxies[this.proxyIndex]
    this.proxyIndex = (this.proxyIndex + 1) % this.config.proxies.length
    return proxy
  }

  async setup() {
    logger('info', 'YouTube', 'Setting up YouTube source...')

    this.oauth = new OAuth(this.nodelink)

    const clientClasses = {
      Android,
      AndroidVR,
      IOS,
      Music,
      WebRemix,
      TV,
      TVCast,
      Web,
      WebEmbedded
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
    this.cipherManager?.cleanup?.()
  }

  async _fetchVisitorData() {
    const cachedVisitorData =
      this.nodelink.credentialManager.get('yt_visitor_data')
    const cachedPlayerScript = this.nodelink.credentialManager.get(
      'yt_player_script_url'
    )

    if (cachedPlayerScript) {
      this.cipherManager.setPlayerScriptUrl(cachedPlayerScript)
      logger('debug', 'YouTube', 'Player script URL loaded from cache.')
    }

    // Não vamos poder mais deixar um cache de visitorData, 1 de fevereiro, youtube mudou a forma como ele interage com o visitorData

    let visitorFound = false
    let playerScriptUrl = null

    try {
      const {
        body: data,
        error,
        statusCode
      } = await makeRequest('https://www.youtube.com/embed', {
        method: 'GET',
        headers: {
          Cookie: 'YSC=cz5kYp3ZuIE; VISITOR_INFO1_LIVE=U-0T5oUyzf8;'
        }
      })

      if (!error && statusCode === 200) {
        const visitorMatch = data?.match(/"VISITOR_DATA":"([^"]+)"/)
        if (visitorMatch?.[1]) {
          this.ytContext.client.visitorData = visitorMatch[1]
          this.nodelink.credentialManager.set(
            'yt_visitor_data',
            visitorMatch[1],
            60 * 60 * 1000
          )
          visitorFound = true
          logger('debug', 'YouTube', 'visitorData refreshed and cached.')
        }

        const playerScriptMatch = data?.match(/"jsUrl":"([^"]+)"/)
        if (playerScriptMatch?.[1]) {
          playerScriptUrl = playerScriptMatch[1].replace(
            /\/[a-z]{2}_[A-Z]{2}\//,
            '/en_US/'
          )
          this.nodelink.credentialManager.set(
            'yt_player_script_url',
            playerScriptUrl,
            12 * 60 * 60 * 1000
          )
          logger('debug', 'YouTube', `Player script URL: ${playerScriptUrl}`)
        }
      } else {
        logger(
          'warn',
          'YouTube',
          `Embed request failed: ${error?.message || `Status ${statusCode}`}`
        )
      }

      if (!visitorFound) {
        const {
          body: guideData,
          error: guideError,
          statusCode: guideStatusCode
        } = await makeRequest('https://www.youtube.com/youtubei/v1/guide', {
          method: 'POST',
          body: { context: this.ytContext },
          disableBodyCompression: true,
        proxy: (typeof this.getProxy === 'function' ? this.getProxy() : this.nodelink?.sources?.getSource?.('youtube')?.getProxy?.()) || this.source?.getProxy?.()
        })

        if (
          !guideError &&
          guideStatusCode === 200 &&
          guideData.responseContext?.visitorData
        ) {
          this.ytContext.client.visitorData =
            guideData.responseContext.visitorData
          this.nodelink.credentialManager.set(
            'yt_visitor_data',
            guideData.responseContext.visitorData,
            60 * 60 * 1000
          )
          visitorFound = true
          logger(
            'debug',
            'YouTube',
            'visitorData refreshed via guide and cached.'
          )
        } else {
          logger(
            'warn',
            'YouTube',
            'Failed to refresh visitorData via guide; using cached fallback if present.'
          )
        }
      }
    } catch (e) {
      logger('error', 'YouTube', `Error fetching visitor data: ${e.message}`)
      logger(
        'warn',
        'YouTube',
        'Using cached visitorData fallback (if present).'
      )
    }

    if (playerScriptUrl) this.cipherManager.setPlayerScriptUrl(playerScriptUrl)
  }

  async search(query, type, searchType = 'track') {
    if (type === 'ytrec') {
      return this.getRecommendations(query)
    }

    let clientList = this.config.clients.search

    if (type === 'ytmsearch') {
      clientList = ['WebRemix', 'Music']
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

  async getRecommendations(query) {
    let videoId = query
    if (!/^[a-zA-Z0-9_-]{11}$/.test(query)) {
      const searchRes = await this.search(query, 'ytmsearch')
      if (searchRes.loadType !== 'search' || !searchRes.data.length) {
        return { loadType: 'empty', data: {} }
      }
      videoId = searchRes.data[0].info.identifier
    }

    try {
      const automixId = `RD${videoId}`
      let automixRes = null

      // Try WebRemix first, then Music
      if (this.clients.WebRemix || this.clients.Music) {
        try {
          const musicClient = this.clients.WebRemix || this.clients.Music
          const clientName = this.clients.WebRemix ? 'WebRemix' : 'Music'
          logger(
            'debug',
            'YouTube',
            `Attempting recommendations with ${clientName} client`
          )

          automixRes = await musicClient.resolve(
            `https://music.youtube.com/playlist?list=${automixId}`,
            'ytmusic',
            this.ytContext,
            this.cipherManager
          )
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `Music client failed for recommendations: ${e.message}`
          )
        }
      }

      if (
        (!automixRes || automixRes.loadType !== 'playlist') &&
        (this.clients.TV || this.clients.TVCast || this.clients.WebRemix)
      ) {
        try {
          const tvClient = this.clients.TV || this.clients.TVCast
          const clientName = this.clients.TV ? 'TV' : 'TVCast'
          logger(
            'debug',
            'YouTube',
            `Attempting recommendations with ${clientName} client`
          )
          automixRes = await tvClient.resolve(
            `https://www.youtube.com/playlist?list=${automixId}`,
            'youtube',
            this.ytContext,
            this.cipherManager
          )
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `TV client failed for recommendations: ${e.message}`
          )
        }
      }

      if (
        automixRes &&
        automixRes.loadType === 'playlist' &&
        automixRes.data.tracks.length > 0
      ) {
        const tracks = automixRes.data.tracks.filter(
          (t) => t.info.identifier !== videoId
        )
        return {
          loadType: 'playlist',
          data: {
            info: { name: 'YouTube Recommendations', selectedTrack: 0 },
            pluginInfo: { type: 'recommendations' },
            tracks
          }
        }
      }

      return { loadType: 'empty', data: {} }
    } catch (e) {
      logger('error', 'YouTube', `Recommendations failed: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
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
      const musicClients = ['WebRemix', 'Music']

      for (const clientName of musicClients) {
        const musicClient = this.clients[clientName]
        if (!musicClient) continue

        try {
          logger(
            'debug',
            'YouTube',
            `Attempting to resolve YouTube Music URL with ${clientName} client.`
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
              `Successfully resolved YouTube Music URL with ${clientName} client.`
            )
            return result
          }

          if (
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
                `${clientName} client returned Playability Error for ${fallbackId}. Attempting fallback to standard YouTube client.`
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

          const errorMessage =
            result?.data?.message ||
            `${clientName} client returned empty or failed.`
          clientErrors.push({ client: clientName, message: errorMessage })
          logger(
            'debug',
            'YouTube',
            `${clientName} client returned empty or failed for Music URL.`
          )
        } catch (e) {
          clientErrors.push({ client: clientName, message: e.message })
          logger(
            'warn',
            'YouTube',
            `${clientName} client threw an exception during Music URL resolve: ${e.message}`
          )
        }
      }

      // If we get here, both clients failed
      const msg = 'All music clients failed for direct Music URL.'
      logger('error', 'YouTube', msg)
      return {
        exception: {
          message: msg,
          severity: 'fault',
          cause: 'MusicClientsFailure',
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

  async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = this.nodelink.trackCacheManager.get(
        'youtube',
        decodedTrack.identifier
      )
      if (cached) {
        logger(
          'debug',
          'YouTube',
          `Using cached URL for ${decodedTrack.identifier}`
        )
        return cached
      }
    }

    let clientList = [...this.config.clients.playback]
    if (!clientList.length) clientList = ['Web']
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
        const proxyToUse = this.getProxy();
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

        if (urlData.protocol === 'sabr') {
          const bestAudio = urlData.formats
            ?.filter((f) => f.mimeType?.includes('audio'))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

          if (bestAudio) {
            urlData.format = bestAudio.mimeType?.includes('webm')
              ? 'webm/opus'
              : 'm4a'
          }

          return urlData
        }

        if (urlData.url) {
          const check = await http1makeRequest(urlData.url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true,
        proxy: (typeof this.getProxy === 'function' ? this.getProxy() : this.nodelink?.sources?.getSource?.('youtube')?.getProxy?.()) || this.source?.getProxy?.()
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
            const result = { ...urlData, additionalData: { contentLength, proxy: proxyToUse } }
            this.nodelink.trackCacheManager.set(
              'youtube',
              decodedTrack.identifier,
              result,
              1000 * 60 * 60 * 5
            )
            return result
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
              streamOnly: true,
        proxy: (typeof this.getProxy === 'function' ? this.getProxy() : this.nodelink?.sources?.getSource?.('youtube')?.getProxy?.()) || this.source?.getProxy?.()
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
              const result = {
                url: urlData.hlsUrl,
                protocol: 'hls',
                format: 'mpegts'
              }
              this.nodelink.trackCacheManager.set(
                'youtube',
                decodedTrack.identifier,
                result,
                1000 * 60 * 60 * 5
              )
              return result
            }

            const hlsError = `HLS fallback failed. Status: ${hlsCheck.statusCode}, Error: ${hlsCheck.error?.message}`
            clientErrors.push({ client: clientName, message: hlsError })
            logger('warn', 'YouTube', `Client ${clientName}: ${hlsError}`)
          }
        } else if (urlData.hlsUrl) {
          const hlsCheck = await http1makeRequest(urlData.hlsUrl, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            streamOnly: true,
        proxy: (typeof this.getProxy === 'function' ? this.getProxy() : this.nodelink?.sources?.getSource?.('youtube')?.getProxy?.()) || this.source?.getProxy?.()
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
            const result = {
              url: urlData.hlsUrl,
              protocol: 'hls',
              format: 'mpegts'
            }
            this.nodelink.trackCacheManager.set(
              'youtube',
              decodedTrack.identifier,
              result,
              1000 * 60 * 60 * 5
            )
            return result
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

    const mirrored = await this._tryMirrorSourceTrackUrl(
      decodedTrack,
      itag,
      forceRefresh
    )
    if (mirrored) return mirrored

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

  async _tryMirrorSourceTrackUrl(decodedTrack, itag, forceRefresh = false) {
    const key = `${decodedTrack?.identifier || ''}:${decodedTrack?.title || ''}:${decodedTrack?.author || ''}`
    if (this.mirrorFallbackInFlight.has(key)) return null
    const blockedFallbackSources = new Set([
      'amazonmusic',
      'anghami',
      'applemusic',
      'eternalbox',
      'flowery',
      'genius',
      'google-tts',
      'http',
      'instagram',
      'kwai',
      'lastfm',
      'lazypytts',
      'letrasmus',
      'local',
      'pandora',
      'pinterest',
      'pipertts',
      'reddit',
      'rss',
      'shazam',
      'songlink',
      'spotify',
      'telegram',
      'tidal',
      'twitch',
      'tumblr',
      'twitter',
      'vimeo'
    ])

    const configuredFallbackSources = Array.isArray(
      this.config?.fallbackSources
    )
      ? this.config.fallbackSources
      : []
    const defaultSources = Array.isArray(
      this.nodelink.options.defaultSearchSource
    )
      ? this.nodelink.options.defaultSearchSource
      : [this.nodelink.options.defaultSearchSource]

    const fallbackOrder = [
      ...configuredFallbackSources,
      ...defaultSources,
      'soundcloud',
      'deezer',
      'jiosaavn',
      'qobuz',
      'gaana',
      'vkmusic',
      'yandexmusic',
      'audiomack',
      'bandcamp',
      'audius',
      'mixcloud',
      'bilibili',
      'bluesky',
      'nicovideo'
    ].filter((name, index, arr) => {
      const source = this.nodelink.sources?.getSource(name)
      return (
        typeof name === 'string' &&
        name.length > 0 &&
        arr.indexOf(name) === index &&
        !['youtube', 'ytmusic'].includes(name) &&
        !blockedFallbackSources.has(name) &&
        this.nodelink.options?.sources?.[name]?.enabled &&
        source &&
        typeof source.search === 'function' &&
        typeof source.getTrackUrl === 'function'
      )
    })

    if (fallbackOrder.length === 0) return null

    const query =
      `${decodedTrack?.title || ''} ${decodedTrack?.author || ''}`.trim()
    if (!query) return null

    this.mirrorFallbackInFlight.add(key)
    try {
      for (const fallbackSource of fallbackOrder) {
        try {
          const search = await this.nodelink.sources.search(
            fallbackSource,
            query
          )
          if (
            !search ||
            search.loadType !== 'search' ||
            !Array.isArray(search.data) ||
            search.data.length === 0
          ) {
            continue
          }

          const bestMatch = getBestMatch(search.data, decodedTrack)
          const bestInfo = bestMatch?.info
          if (
            !bestInfo ||
            ['youtube', 'ytmusic'].includes(bestInfo.sourceName)
          ) {
            continue
          }

          const stream = await this.nodelink.sources.getTrackUrl(
            bestInfo,
            itag,
            forceRefresh
          )
          if (!stream?.exception) {
            logger(
              'warn',
              'YouTube',
              `Fallback source succeeded via ${bestInfo.sourceName} for "${bestInfo.title}".`
            )
            return { ...stream, newTrack: bestMatch }
          }
        } catch (e) {
          logger(
            'debug',
            'YouTube',
            `Fallback source ${fallbackSource} failed: ${e.message}`
          )
        }
      }
    } finally {
      this.mirrorFallbackInFlight.delete(key)
    }

    return null
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
      if (protocol === 'sabr') {
        const sabr = new SabrStream({
          videoId: decodedTrack.identifier,
          accessToken: additionalData.accessToken,
          visitorData: additionalData.visitorData,
          serverAbrStreamingUrl: additionalData.serverAbrStreamingUrl,
          videoPlaybackUstreamerConfig:
            additionalData.videoPlaybackUstreamerConfig,
          poToken: additionalData.poToken,
          clientInfo: additionalData.clientInfo,
          formats: additionalData.formats,
          startTime: additionalData.startTime || 0,
          positionCallback: additionalData.positionCallback,
          previousSession: additionalData.previousSession
        })

        const stream = new PassThrough()
        let readyResolved = false
        let readyResolve
        let readyReject
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve
          readyReject = reject
        })
        let isRecovering = false
        let lastRecoverAt = 0

        sabr.on('data', (chunk) => {
          if (!readyResolved) {
            readyResolved = true
            readyResolve()
          }
          if (!stream.write(chunk)) {
            sabr.pause()
          }
        })
        stream.on('drain', () => sabr.resume())

        sabr.on('end', () => {
          if (!readyResolved) {
            readyResolved = true
            readyReject(new Error('SABR stream ended before data'))
          }
          stream.end()
        })
        sabr.on('finishBuffering', () => stream.emit('finishBuffering'))
        sabr.on('stall', async () => {
          if (isRecovering || stream.destroyed) return

          const now = Date.now()
          if (now - lastRecoverAt < 2000) return
          lastRecoverAt = now

          isRecovering = true
          try {
            logger(
              'warn',
              'YouTube',
              `SABR stall detected for ${decodedTrack.title}. Refreshing session...`
            )
            const newUrlData = await this.getTrackUrl(decodedTrack, null, true)
            if (!newUrlData || newUrlData.protocol !== 'sabr') {
              throw new Error('No SABR session available for recovery')
            }

            const ad = newUrlData.additionalData || {}
            sabr.clearBuffers()
            sabr.updateSession({
              serverAbrStreamingUrl: ad.serverAbrStreamingUrl || newUrlData.url,
              videoPlaybackUstreamerConfig: ad.videoPlaybackUstreamerConfig,
              poToken: ad.poToken,
              visitorData: ad.visitorData,
              clientInfo: ad.clientInfo,
              formats: ad.formats,
              userAgent: ad.userAgent,
              playbackCookie: ad.playbackCookie
            })
          } catch (err) {
            logger('warn', 'YouTube', `SABR recovery failed: ${err.message}`)
            if (!stream.destroyed) stream.destroy(err)
          } finally {
            isRecovering = false
          }
        })
        sabr.on('error', async (err) => {
          logger('error', 'YouTube', `SABR stream error: ${err.message}`)
          if (!readyResolved) {
            readyResolved = true
            readyReject(err)
          }

          if (
            (err.message.includes('sabr.malformed_config') ||
              err.message.includes(
                'sabr.media_serving_enforcement_id_error'
              )) &&
            !isRecovering
          ) {
            logger(
              'info',
              'YouTube',
              `Known recoverable error detected (${err.message}), triggering stall recovery...`
            )
            sabr.emit('stall')
            return
          }

          if (!stream.destroyed) stream.destroy(err)
        })

        const originalDestroy = stream.destroy.bind(stream)
        let isDestroying = false
        stream.destroy = (err) => {
          if (isDestroying) return
          isDestroying = true
          sabr.destroy(err)
          this.activeStreams.delete(streamKey)
          originalDestroy(err)
        }

        stream.once('close', () => {
          if (isDestroying) return
          isDestroying = true
          sabr.destroy()
          this.activeStreams.delete(streamKey)
        })

        stream._sabrStream = sabr
        stream.getSessionState = () => {
          if (isDestroying || stream.destroyed) return null
          return sabr.getSessionState()
        }

        const bestAudio = additionalData.formats
          .filter((f) => f.mimeType?.includes('audio'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

        sabr.start(bestAudio.itag)

        const type = bestAudio.mimeType?.includes('webm') ? 'webm/opus' : 'm4a'

        await ready
        return { stream, type }
      }

      if (protocol === 'hls') {
        const playerScript = await this.cipherManager.getCachedPlayerScript()
        const stream = new HLSHandler(url, {
          type: 'mpegts',
          localAddress: this.nodelink.routePlanner?.getIP(),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            Referer: 'https://www.youtube.com/',
            Origin: 'https://www.youtube.com'
          },
          onResolveUrl: async (segmentUrl) => {
            if (segmentUrl.includes('/n/')) {
              const nToken = segmentUrl.match(/\/n\/([^/]+)/)?.[1]
              if (nToken && playerScript) {
                try {
                  return await this.cipherManager.resolveUrl(
                    segmentUrl,
                    null,
                    nToken,
                    null,
                    playerScript
                  )
                } catch (err) {
                  logger(
                    'warn',
                    'YouTube',
                    `Failed to resolve n-token: ${err.message}`
                  )
                }
              }
            }
            return null
          }
        })

        const originalDestroy = stream.destroy.bind(stream)
        stream.destroy = (err) => {
          if (cancelSignal.aborted) return
          cancelSignal.aborted = true
          this.activeStreams.delete(streamKey)
          originalDestroy(err)
        }

        return { stream }
      }

      if (!url) throw new Error('No direct URL')

      let contentLength = additionalData?.contentLength || null

      if (!contentLength) {
        const testResponse = await http1makeRequest(url, { method: 'HEAD', timeout: 5000 })

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
            streamOnly: true,
        proxy: (typeof this.getProxy === 'function' ? this.getProxy() : this.nodelink?.sources?.getSource?.('youtube')?.getProxy?.()) || this.source?.getProxy?.()
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
        streamOnly: true,
        proxy: proxyToUse,
        timeout: 20000
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
          proxy: proxyToUse,
          timeout: 20000
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
        const newUrlData = await this.getTrackUrl(decodedTrack, null, true)

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

  async handleLiveChat(socket, id) {
    return this.liveChat.handleConnection(socket, id)
  }
}
