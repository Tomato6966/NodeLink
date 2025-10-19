import { URLSearchParams } from 'node:url'
import { logger, makeRequest } from '../../utils.js'

const CACHE_DURATION_MS = 12 * 60 * 60 * 1000

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
    this.cachedPlayerScript = null
    this.cipherLoadLock = false
    this.explicitPlayerScriptUrl = null
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

      const {
        body: responseText,
        error,
        statusCode
      } = await makeRequest('https://www.youtube.com/embed/')
      if (error || statusCode !== 200) {
        throw new Error(
          `Failed to fetch player script (embed): ${error?.message || statusCode}`
        )
      }

      const scriptUrl = responseText.match(/"jsUrl":"([^"]+)"/)?.[1]
      if (!scriptUrl) {
        throw new Error('No jsUrl found in embed page')
      }

      this.cachedPlayerScript = new CachedPlayerScript(scriptUrl)
      logger(
        'debug',
        'YouTube-Cipher',
        `Obtained player script from /embed/: ${this.cachedPlayerScript.url}`
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

      return sts
    }

    const requestBody = {
      player_url: playerUrl
    }

    const headers = { 'Content-Type': 'application/json' }
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
    return body.sts
  }

  async resolveFormatUrl(playerScript, format) {
    if (!this.config.url) {
      throw new Error('Remote cipher URL is not configured.')
    }

    let streamUrl, encryptedSignature, signatureKey

    if (format.signatureCipher) {
      const cipherData = new URLSearchParams(format.signatureCipher)
      encryptedSignature = cipherData.get('s')
      streamUrl = cipherData.get('url')
      signatureKey = cipherData.get('sp') || 'sig'

      if (!encryptedSignature) {
        throw new Error(
          `Could not extract signature from signatureCipher: ${format.signatureCipher}`
        )
      }
    } else if (format.url) {
      streamUrl = format.url
    } else {
      throw new Error('Format has no url or signatureCipher')
    }

    const requestBody = {
      stream_url: streamUrl,
      player_url: playerScript.url
    }

    if (encryptedSignature) {
      requestBody.encrypted_signature = encryptedSignature
      requestBody.signature_key = signatureKey
    }

    const headers = { 'Content-Type': 'application/json' }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Resolving URL via /resolve_url: ${streamUrl}`
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
}
