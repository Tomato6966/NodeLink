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
      'youtube-cipher',
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
          'youtube-cipher',
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
        'youtube-cipher',
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
    const {
      body: scriptContent,
      error,
      statusCode
    } = await makeRequest(playerUrl, { method: 'GET' })

    if (error || statusCode !== 200) {
      logger(
        'error',
        'CipherManager',
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
        'CipherManager',
        `Timestamp not found in player script: ${playerUrl}`
      )
      throw new Error(`Timestamp not found in player script: ${playerUrl}`)
    }

    const sts = timestampMatch[1]
    logger(
      'debug',
      'CipherManager',
      `Extracted timestamp from player script: ${sts}`
    )

    return sts
  }

  async resolveFormatUrl(playerScript, format) {
    if (!this.config.url) {
      throw new Error('Remote cipher URL is not configured.')
    }

    let encryptedSignature = null
    let n_param = null
    let sp = 'sig'
    let baseUrl = null

    if (format.signatureCipher) {
      const cipherData = new URLSearchParams(format.signatureCipher)
      encryptedSignature = cipherData.get('s')
      baseUrl = cipherData.get('url')
      sp = cipherData.get('sp') || 'sig'
      const tempUrl = new URL(baseUrl)
      n_param = tempUrl.searchParams.get('n')
    } else if (format.url) {
      const tempUrl = new URL(format.url)
      n_param = tempUrl.searchParams.get('n')
      baseUrl = format.url
    }

    if (!baseUrl) {
      throw new Error('No valid URL found in format for deciphering.')
    }

    const headers = {
      'Content-Type': 'application/json'
    }

    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    const requestBody = {
      player_url: playerScript.url
    }

    if (encryptedSignature) {
      requestBody.encrypted_signature = encryptedSignature
      requestBody.signature_key = sp
    }
    if (n_param) {
      requestBody.n_param = n_param
    }

    logger(
      'debug',
      'CipherManager',
      `Sending to remote cipher: encryptedSignature=${encryptedSignature}, n_param=${n_param}, player_url=${playerScript.url}, requestBody=${JSON.stringify(requestBody)}`
    )

    const { body, error, statusCode } = await makeRequest(
      `${this.config.url}/decrypt_signature`,
      {
        method: 'POST',
        headers,
        body: requestBody,
        disableBodyCompression: true
      }
    )

    if (error || statusCode !== 200) {
      logger(
        'error',
        'CipherManager',
        `Remote cipher server error: ${error?.message || body?.message || 'Invalid response'}`
      )
      throw new Error(
        `Failed to decrypt signature: ${error?.message || body?.message || 'Invalid response'}`
      )
    }

    logger(
      'debug',
      'CipherManager',
      `Received from remote cipher: decrypted_signature=${body.decrypted_signature}, decrypted_n_sig=${body.decrypted_n_sig}. Using signature parameter name: ${sp}. Original n_param: ${n_param}`
    )

    const finalUrl = new URL(baseUrl)
    if (body.decrypted_signature) {
      finalUrl.searchParams.set(sp, body.decrypted_signature)
    }
    if (body.decrypted_n_sig) {
      finalUrl.searchParams.set('n', body.decrypted_n_sig)
    }

    logger(
      'debug',
      'CipherManager',
      `Final deciphered URL: ${finalUrl.toString()}`
    )
    return finalUrl.toString()
  }
}
