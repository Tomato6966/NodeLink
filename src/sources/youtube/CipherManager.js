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

  async _decipherN(playerScript, n) {
    const requestBody = {
      player_url: playerScript.url,
      n_param: n
    }

    const headers = { 'Content-Type': 'application/json' }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Deciphering N param: ${n} with script: ${playerScript.url}`
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
      throw new Error(
        `Failed to decrypt n-parameter: ${error?.message || body?.message || 'Invalid response'}`
      )
    }

    const decryptedN = body.decrypted_n_sig
    if (!decryptedN) {
      throw new Error('Proxy did not return a decrypted n-parameter.')
    }

    logger('debug', 'YouTube-Cipher', `Received decrypted N: ${decryptedN}`)
    return decryptedN
  }

  async _getUriWithSignature(playerScript, format) {
    const cipherData = new URLSearchParams(format.signatureCipher)
    const encryptedSignature = cipherData.get('s')
    const baseUrl = cipherData.get('url')
    const sp = cipherData.get('sp') || 'sig'

    if (!encryptedSignature) {
      throw new Error(
        `Could not extract signature from signatureCipher: ${format.signatureCipher}`
      )
    }

    const tempUrl = new URL(baseUrl)
    const n_param = tempUrl.searchParams.get('n')

    const requestBody = {
      player_url: playerScript.url,
      encrypted_signature: encryptedSignature,
      signature_key: sp,
      n_param: n_param
    }

    const headers = { 'Content-Type': 'application/json' }
    if (this.config.token) {
      headers.Authorization = this.config.token
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Sending to remote cipher: encryptedSignature=${encryptedSignature}, n_param=${n_param}, sp=${sp}, player_url=${playerScript.url}`
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
      throw new Error(
        `Failed to decrypt signature: ${error?.message || body?.message || 'Invalid response'}`
      )
    }

    logger(
      'debug',
      'YouTube-Cipher',
      `Received from remote cipher: decrypted_signature=${body.decrypted_signature}, decrypted_n_sig=${body.decrypted_n_sig}`
    )

    const finalUrl = new URL(baseUrl)

    if (body.decrypted_signature) {
      finalUrl.searchParams.set(sp, body.decrypted_signature)
    } else {
      logger(
        'warn',
        'YouTube-Cipher',
        'Proxy did not return a decrypted signature, the URL will likely be invalid.'
      )
    }

    if (body.decrypted_n_sig) {
      finalUrl.searchParams.set('n', body.decrypted_n_sig)
    }

    return finalUrl.toString()
  }

  async resolveFormatUrl(playerScript, format) {
    if (!this.config.url) {
      throw new Error('Remote cipher URL is not configured.')
    }

    if (format.signatureCipher) {
      return this._getUriWithSignature(playerScript, format)
    }

    if (format.url && new URL(format.url).searchParams.has('n')) {
      const initialUrl = new URL(format.url)
      const nParameter = initialUrl.searchParams.get('n')
      const newN = await this._decipherN(playerScript, nParameter)
      initialUrl.searchParams.set('n', newN)

      const finalUrl = initialUrl.toString()
      logger('debug', 'YouTube-Cipher', `Final N-transformed URL: ${finalUrl}`)
      return finalUrl
    }

    // This path should not be reached if called from common.js correctly
    return format.url
  }
}
