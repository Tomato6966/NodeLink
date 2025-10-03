import { PassThrough } from 'node:stream'
import {
  http1makeRequest,
  loadHLSPlaylist,
  logger,
  makeRequest
} from '../../utils.js'

import CipherManager from './CipherManager.js'
import OAuth from './OAuth.js'
import Android from './clients/Android.js'
import IOS from './clients/IOS.js'
import Music from './clients/Music.js'
import TV from './clients/TV.js'
import TVEmbedded from './clients/TVEmbedded.js'
import Web from './clients/Web.js'

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
    logger('info', 'youtube', 'Setting up YouTube source...')

    this.oauth = new OAuth(this.nodelink)

    const clientClasses = { Android, IOS, Music, TV, TVEmbedded, Web }
    for (const clientName in clientClasses) {
      this.clients[clientName] = new clientClasses[clientName](
        this.nodelink,
        this.oauth
      )
    }
    logger(
      'debug',
      'youtube',
      `Initialized clients: ${Object.keys(this.clients).join(', ')}`
    )

    await this._fetchVisitorData()
    await this.cipherManager.getCachedPlayerScript()

    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
    }
    this.visitorDataInterval = setInterval(
      () => this._fetchVisitorData(),
      3600000
    )

    logger('info', 'youtube', 'YouTube source setup complete.')
    return true
  }

  cleanup() {
    logger('info', 'youtube', 'Cleaning up YouTube source...')
    if (this.visitorDataInterval) {
      clearInterval(this.visitorDataInterval)
      this.visitorDataInterval = null
    }
  }

  async _fetchVisitorData() {
    logger('debug', 'youtube', 'Fetching visitor data...')
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
            'youtube',
            `Extracted and standardized player script URL from main page: ${playerScriptUrl}`
          )
        }
      }

      if (!visitorFound) {
        logger(
          'warn',
          'youtube',
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
      logger('error', 'youtube', `Error fetching visitor data: ${e.message}`)
    }
    if (playerScriptUrl) {
      this.cipherManager.setPlayerScriptUrl(playerScriptUrl)
    }
  }

  async search(query, type) {
    const clientList = this.config.clients.search
    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (client) {
        logger(
          'debug',
          'youtube',
          `Attempting search with client: ${clientName}`
        )
        const result = await client.search(query, type, this.ytContext)
        if (result && result.loadType !== 'empty') {
          logger(
            'debug',
            'youtube',
            `Search successful with client: ${clientName}`
          )
          return result
        }
        logger(
          'debug',
          'youtube',
          `Client ${clientName} returned empty or failed search.`
        )
      } else {
        logger(
          'warn',
          'youtube',
          `Client ${clientName} not found in initialized clients.`
        )
      }
    }
    logger(
      'info',
      'youtube',
      'No search results found from any configured client.'
    )
    return { loadType: 'empty', data: {} }
  }

  async resolve(url, type) {
    const clientList = this.config.clients.playback
    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (client) {
        logger(
          'debug',
          'youtube',
          `Attempting to resolve URL with client: ${clientName}`
        )
        const result = await client.resolve(
          url,
          type,
          this.ytContext,
          this.cipherManager
        )
        if (result && result.loadType !== 'empty') {
          logger(
            'debug',
            'youtube',
            `Successfully resolved URL with client: ${clientName}`
          )
          return result
        }
        logger(
          'debug',
          'youtube',
          `Client ${clientName} returned empty or failed to resolve URL.`
        )
      } else {
        logger(
          'warn',
          'youtube',
          `Client ${clientName} not found in initialized clients.`
        )
      }
    }
    logger('info', 'youtube', 'No client could resolve the URL.')
    return { loadType: 'empty', data: {} }
  }

  async getTrackUrl(decodedTrack) {
    const clientList = this.config.clients.playback
    for (const clientName of clientList) {
      const client = this.clients[clientName]
      if (client) {
        logger(
          'debug',
          'youtube',
          `Attempting to get track URL for ${decodedTrack.title} with client: ${clientName}`
        )
        const result = await client.getTrackUrl(
          decodedTrack,
          this.ytContext,
          this.cipherManager
        )
        if (result && !result.exception) {
          logger(
            'debug',
            'youtube',
            `Successfully obtained stream URL for ${decodedTrack.title} using ${clientName} client.`
          )
          return result
        }
        logger(
          'debug',
          'youtube',
          `Client ${clientName} failed to get track URL for ${decodedTrack.title}.`
        )
      }
    }
    logger(
      'error',
      'youtube',
      `Failed to get track URL for ${decodedTrack.title} from any configured client.`
    )
    return {
      exception: {
        message: 'Failed to get track URL from any client.',
        severity: 'fault'
      }
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    logger(
      'debug',
      'youtube',
      `Loading stream for "${decodedTrack.title}" with protocol ${protocol}`
    )
    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        loadHLSPlaylist(url, stream)
        return { stream }
      }

      if (!url) throw new Error('No direct URL')

      const clientReferer = `https://www.youtube.com/watch?v=${decodedTrack.identifier}` // Default Referer

      const response = await http1makeRequest(url, {
        method: 'GET',
        streamOnly: true,
        headers: {}
      })
      if (response.statusCode !== 200)
        throw new Error(`HTTP status ${response.statusCode}`)

      const stream = new PassThrough()
      response.stream.pipe(stream)
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', () => stream.emit('finishBuffering'))

      return { stream }
    } catch (e) {
      logger(
        'error',
        'youtube',
        `Error loading stream for ${decodedTrack.identifier}: ${e.message}`
      )
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Upstream' }
      }
    }
  }
}
