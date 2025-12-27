import { URLSearchParams } from 'node:url'
import { http1makeRequest, logger, makeRequest, getVersion } from '../../utils.js'

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000
const VERSION = getVersion()

class CachedPlayerScript {
  constructor(url) {
    this.url = url.startsWith('http') ? url : `https://www.youtube.com${url}`
    this.expireTimestampMs = Date.now() + CACHE_DURATION_MS
  }
}

export default class CipherManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources.youtube.cipher
    if (this.config.url) {
      this.config.url = this.config.url.replace(/\/+$/, '')
    }
    this.cachedPlayerScript = null
    this.cipherLoadLock = false
    this.explicitPlayerScriptUrl = null
    this.userAgent = `nodelink/${VERSION} (https://github.com/PerformanC/NodeLink)`
    this.stsCache = new Map()
    
     setInterval(() => {
      this.stsCache.clear()
      logger('debug', 'YouTube-Cipher', 'Cleared STS cache (12h interval)')
    }, 12 * 60 * 60 * 1000).unref()
  }

  setPlayerScriptUrl(url) {
    this.explicitPlayerScriptUrl = new CachedPlayerScript(url)
    logger(
      'debug',
      'YouTube-Cipher',
      `Explicit player script URL set: ${this.explicitPlayerScriptUrl.url}`
    )
  }

  async getPlayerScript() {
    if (this.cipherLoadLock) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return this.getCachedPlayerScript()
    }

    const cachedUrl = this.nodelink.credentialManager.get('yt_player_script_url')
    if (cachedUrl && !this.explicitPlayerScriptUrl) {
      this.cachedPlayerScript = new CachedPlayerScript(cachedUrl)
      return this.cachedPlayerScript
    }

    this.cipherLoadLock = true
    try {
      if (
        this.explicitPlayerScriptUrl &&
        Date.now() < this.explicitPlayerScriptUrl.expireTimestampMs
      ) {
        logger(
          'debug',
          'YouTube-Cipher',
          `Using explicit player script URL: ${this.explicitPlayerScriptUrl.url}`
        )
        this.cachedPlayerScript = this.explicitPlayerScriptUrl
        return this.cachedPlayerScript
      }

      const scriptUrl =
        await this._fetchPlayerScriptFromWatchPage('dQw4w9WgXcQ')

      if (!scriptUrl) {
        logger(
          'warn',
          'YouTube-Cipher',
          'Failed to obtain player script URL. Cipher manager might not function correctly.'
        )
        return null
      }

      this.cachedPlayerScript = new CachedPlayerScript(scriptUrl)
      logger(
        'debug',
        'YouTube-Cipher',

        `Obtained player script from watch page: ${this.cachedPlayerScript.url}`
      )
      return this.cachedPlayerScript
    } finally {
      this.cipherLoadLock = false
    }
  }

  async getCachedPlayerScript() {
    if (
      this.explicitPlayerScriptUrl &&
      Date.now() < this.explicitPlayerScriptUrl.expireTimestampMs
    ) {
      return this.explicitPlayerScriptUrl
    }
    if (
      !this.cachedPlayerScript ||
      Date.now() >= this.cachedPlayerScript.expireTimestampMs
    ) {
      return this.getPlayerScript()
    }
    return this.cachedPlayerScript
  }

  async getTimestamp(playerUrl) {
    if (this.stsCache.has(playerUrl)) {
      return this.stsCache.get(playerUrl)
    }

    const cachedSts = this.nodelink.credentialManager.get(`yt_sts_${playerUrl}`)
    if (cachedSts) {
      this.stsCache.set(playerUrl, cachedSts)
      return cachedSts
    }

    if (!this.config.url) {
      const {
        body: scriptContent,
        error,
        statusCode
      } = await makeRequest(playerUrl, { method: 'GET' })

      if (error || statusCode !== 200) {
        logger(
          'error',
          'YouTube-Cipher',
          `Failed to fetch player script for timestamp: ${error?.message || `Status ${statusCode}`}`
        )
        throw new Error(
          `Failed to fetch player script for timestamp: ${error?.message || `Status ${statusCode}`}`
        )
      }

      const timestampMatch = scriptContent.match(
        /(?:signatureTimestamp|sts):(\d+)/
      )

      if (!timestampMatch || !timestampMatch[1]) {
        logger(
          'error',
          'YouTube-Cipher',
          `Timestamp not found in player script: ${playerUrl}`
        )
        throw new Error(`Timestamp not found in player script: ${playerUrl}`)
      }

      const sts = timestampMatch[1]
      logger(
        'debug',
        'YouTube-Cipher',
        `Extracted timestamp from player script: ${sts}`
      )

      this.stsCache.set(playerUrl, sts)
      this.nodelink.credentialManager.set(`yt_sts_${playerUrl}`, sts, 12 * 60 * 60 * 1000)
      return sts
    }

    const requestBody = {
      player_url: playerUrl
    }

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger('debug', 'YouTube-Cipher', `Fetching STS via /get_sts: ${playerUrl}`)

    const { body, error, statusCode } = await makeRequest(
      `${this.config.url}/get_sts`,
      {
        method: 'POST',
        headers,
        body: requestBody,
        disableBodyCompression: true
      }
    )

    if (error || statusCode !== 200) {
      throw new Error(
        `Failed to get STS: ${error?.message || body?.message || 'Invalid response'}`
      )
    }

    if (!body.sts) {
      throw new Error('Server did not return STS.')
    }

    logger('debug', 'YouTube-Cipher', `Received STS: ${body.sts}`)

    this.stsCache.set(playerUrl, body.sts)
    return body.sts
  }

  async checkCipherServerStatus() {
    if (!this.config.url) {
      logger(
        'warn',
        'YouTube-Cipher',
        'Remote cipher URL is not configured. Skipping online check.'
      )
      return false
    }

    try {
      const headers = {
        'User-Agent': this.userAgent
      }
      if (this.config.token) {
        headers.Authorization = this.config.token
      }

      const { statusCode, error } = await http1makeRequest(
        `${this.config.url}/`,
        { method: 'GET', timeout: 5000, headers }
      )
      if (error || statusCode !== 200) {
        logger(
          'warn',
          'YouTube-Cipher',
          `Cipher server at ${this.config.url} is offline or unreachable. Status: ${statusCode || 'N/A'}`
        )
        return false
      }
      logger(
        'info',
        'YouTube-Cipher',
        `Cipher server at ${this.config.url} is online.`
      )
      return true
    } catch (e) {
      logger(
        'warn',
        'YouTube-Cipher',
        `Cipher server at ${this.config.url} is offline or unreachable.`
      )
      return false
    }
  }

  async resolveUrl(
    streamUrl,
    encryptedSignature,
    nParam,
    signatureKey,
    playerScript,
    context
  ) {
    if (!this.config.url) {
      throw new Error('Remote cipher URL is not configured.')
    }

    const requestBody = {
      stream_url: streamUrl,
      player_url: playerScript.url
    }

    if (encryptedSignature) {
      requestBody.encrypted_signature = encryptedSignature
      requestBody.signature_key = signatureKey || 'sig'
    }

    if (nParam) {
      requestBody.n_param = nParam
    }

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    }

    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Resolving URL via /resolve_url: ${streamUrl}`
    )

    logger(
      'debug',
      'YouTube-Cipher',
      `Sending to cipher service: ${JSON.stringify(requestBody, null, 2)}`
    )

    const { body, error, statusCode } = await makeRequest(
      `${this.config.url}/resolve_url`,
      {
        method: 'POST',
        headers,
        body: requestBody,
        disableBodyCompression: true
      }
    )

    logger(
      'debug',
      'YouTube-Cipher',
      `Received from cipher service (Status: ${statusCode}): ${JSON.stringify(body, null, 2)}`
    )

    if (error || statusCode !== 200) {
      throw new Error(
        `Failed to resolve URL: ${error?.message || body?.message || 'Invalid response'}`
      )
    }

    if (!body.resolved_url) {
      throw new Error('Server did not return a resolved URL.')
    }

    logger('debug', 'YouTube-Cipher', `Resolved URL: ${body.resolved_url}`)
    return body.resolved_url
  }

  async _fetchPlayerScriptFromWatchPage(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
    const {
      body: watchPage,
      error,
      statusCode
    } = await makeRequest(watchUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      }
    })

    if (error || statusCode !== 200) {
      throw new Error(
        `Failed to fetch watch page for player script: ${error?.message || statusCode}`
      )
    }

    const jsUrlMatch = watchPage.match(/"jsUrl":"([^"]+)"/)
    if (!jsUrlMatch || !jsUrlMatch[1]) {
      logger(
        'warn',
        'YouTube-Cipher',
        'Could not find jsUrl in watch page. Player script fetching failed.'
      )
      return null
    }

    let scriptUrl = jsUrlMatch[1]
    scriptUrl = scriptUrl.replace(/\/[a-z]{2}_[A-Z]{2}\//, '/en_US/')
    return `https://www.youtube.com${scriptUrl}`
  }
}
