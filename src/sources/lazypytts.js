import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest } from '../utils.js'

const VOICES_URL = 'https://lazypy.ro/tts/assets/js/voices.json'
const REQUEST_URL = 'https://lazypy.ro/tts/request_tts.php'
const DEFAULT_SERVICE = 'Cerence'
const DEFAULT_VOICE = 'Luciana'
const DEFAULT_MAX_TEXT_LENGTH = 3000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export default class LazyPyTtsSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = this.nodelink.options.sources?.lazypytts || {}
    this.searchTerms = ['lazypytts', 'lazytts']
    this.patterns = [/^lazypytts:/i, /^lazytts:/i]
    this.priority = 50
    this.services = new Map()
  }

  async setup() {
    if (this.config.enabled === false) {
      logger('debug', 'LazyPy', 'LazyPy TTS source is disabled.')
      return false
    }

    await this._fetchVoices()
    logger('info', 'Sources', 'Loaded LazyPy TTS source.')
    return true
  }

  async _fetchVoices() {
    try {
      const cached = this.nodelink.credentialManager.get('lazypytts_voices')
      if (cached?.services) {
        this._applyVoiceCache(cached)
        logger(
          'debug',
          'LazyPy',
          `Loaded ${cached.totalVoices || 0} LazyPy voices from CredentialManager.`
        )
        return
      }

      const { body, error, statusCode } = await makeRequest(VOICES_URL, {
        method: 'GET'
      })

      if (error || statusCode !== 200 || !body || typeof body !== 'object') {
        logger(
          'error',
          'LazyPy',
          `Failed to fetch LazyPy voices: ${error?.message || `Status ${statusCode}`}`
        )
        return
      }

      const summary = this._ingestVoices(body)
      this.nodelink.credentialManager.set(
        'lazypytts_voices',
        summary.cache,
        CACHE_TTL_MS
      )
      logger(
        'debug',
        'LazyPy',
        `Fetched ${summary.totalVoices} LazyPy voices across ${summary.serviceCount} services.`
      )
    } catch (e) {
      logger(
        'error',
        'LazyPy',
        `Exception fetching LazyPy voices: ${e.message}`
      )
    }
  }

  _applyVoiceCache(cache) {
    this.services.clear()
    for (const [key, service] of Object.entries(cache.services || {})) {
      const voices = new Map(Object.entries(service.voices || {}))
      this.services.set(key, {
        key,
        name: service.name,
        charLimit: service.charLimit ?? null,
        countBytes: !!service.countBytes,
        voices,
        defaultVoice: service.defaultVoice || null
      })
    }
  }

  _ingestVoices(data) {
    this.services.clear()
    let totalVoices = 0

    for (const [serviceName, serviceData] of Object.entries(data)) {
      if (!serviceData || !Array.isArray(serviceData.voices)) continue

      const serviceKey = this._normalizeKey(serviceName)
      if (!serviceKey) continue

      const voices = new Map()
      let defaultVoice = null

      for (const voice of serviceData.voices) {
        const voiceId = String(voice.vid ?? voice.id ?? voice.name ?? '').trim()
        const voiceName = String(voice.name ?? voice.vid ?? voiceId).trim()
        if (!voiceId && !voiceName) continue

        const payload = { id: voiceId || voiceName, name: voiceName || voiceId }
        const nameKey = this._normalizeKey(voiceName || voiceId)
        if (nameKey) voices.set(nameKey, payload)

        const idKey = this._normalizeKey(voiceId)
        if (idKey && !voices.has(idKey)) voices.set(idKey, payload)

        if (!defaultVoice) defaultVoice = payload
        totalVoices += 1
      }

      this.services.set(serviceKey, {
        key: serviceKey,
        name: serviceName,
        charLimit: Number.isFinite(serviceData.charLimit)
          ? serviceData.charLimit
          : null,
        countBytes: Boolean(serviceData.countBytes),
        voices,
        defaultVoice
      })
    }

    const cache = {
      services: Object.fromEntries(
        Array.from(this.services.entries()).map(([key, service]) => [
          key,
          {
            name: service.name,
            charLimit: service.charLimit,
            countBytes: service.countBytes,
            voices: Object.fromEntries(service.voices),
            defaultVoice: service.defaultVoice
          }
        ])
      ),
      totalVoices
    }

    return { totalVoices, serviceCount: this.services.size, cache }
  }

  _normalizeKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  }

  _safeDecode(value) {
    if (!value) return ''
    try {
      return decodeURIComponent(value)
    } catch {
      return String(value)
    }
  }

  _getService(name) {
    const key = this._normalizeKey(name)
    if (!key) return null
    return this.services.get(key) || null
  }

  _getFirstService() {
    return this.services.values().next().value || null
  }

  _findServiceForVoice(voiceName) {
    const voiceKey = this._normalizeKey(voiceName)
    if (!voiceKey) return null

    const preferred = this._getService(this.config.service)
    if (preferred) {
      const voice = preferred.voices.get(voiceKey)
      if (voice) return { service: preferred, voice }
    }

    for (const service of this.services.values()) {
      const voice = service.voices.get(voiceKey)
      if (voice) return { service, voice }
    }

    return null
  }

  _parseQueryString(raw) {
    if (!raw.includes('=')) return null
    const params = new URLSearchParams(raw)
    if (!params.has('text')) return null

    return {
      service: params.get('service') || params.get('svc') || '',
      voice:
        params.get('voice') ||
        params.get('voice_id') ||
        params.get('voiceId') ||
        '',
      text: params.get('text') || ''
    }
  }

  _parseColonInput(raw) {
    const parts = raw.split(':')
    if (parts.length >= 3 && this._getService(parts[0])) {
      return {
        service: parts[0],
        voice: parts[1],
        text: parts.slice(2).join(':')
      }
    }

    if (parts.length >= 2) {
      return {
        voice: parts[0],
        text: parts.slice(1).join(':')
      }
    }

    return { text: raw }
  }

  _parseInput(query) {
    let raw = String(query || '').trim()
    if (!raw) return { text: '' }

    raw = raw.replace(/^lazypytts:/i, '').replace(/^lazytts:/i, '')
    const parsed = this._parseQueryString(raw) || this._parseColonInput(raw)

    return {
      service: this._safeDecode(parsed.service),
      voice: this._safeDecode(parsed.voice),
      text: this._safeDecode(parsed.text)
    }
  }

  _resolveRequest(parsed) {
    const configService = this.config.service || DEFAULT_SERVICE
    const configVoice = this.config.voice || DEFAULT_VOICE
    const enforceConfig = this.config.enforceConfig === true
    const text = (parsed.text || '').trim()

    let serviceName = enforceConfig ? configService : parsed.service
    const voiceName = enforceConfig ? configVoice : parsed.voice
    let service = serviceName ? this._getService(serviceName) : null
    let voice = null

    if (!enforceConfig && !service && voiceName) {
      const found = this._findServiceForVoice(voiceName)
      if (found) {
        service = found.service
        serviceName = found.service.name
        voice = found.voice
      }
    }

    if (!service) {
      const fallback =
        this._getService(configService) || this._getFirstService()
      if (fallback) {
        service = fallback
        serviceName = fallback.name
      }
    }

    if (!voice && service) {
      if (voiceName) {
        voice = service.voices.get(this._normalizeKey(voiceName))
      }
      if (!voice && !enforceConfig && configVoice) {
        voice = service.voices.get(this._normalizeKey(configVoice))
      }
      if (!voice && service.defaultVoice) {
        voice = service.defaultVoice
      }
    }

    const resolvedVoice = voice?.name || voiceName || configVoice
    return {
      text,
      serviceName: serviceName || configService,
      voiceId: voice?.id || resolvedVoice,
      voiceLabel: resolvedVoice,
      service
    }
  }

  _getMaxTextLength(service) {
    const configLimit =
      Number.isFinite(this.config.maxTextLength) &&
      this.config.maxTextLength > 0
        ? this.config.maxTextLength
        : DEFAULT_MAX_TEXT_LENGTH
    const serviceLimit =
      service?.charLimit && service.charLimit > 0 ? service.charLimit : null
    return serviceLimit ? Math.min(serviceLimit, configLimit) : configLimit
  }

  _validateTextLength(text, service) {
    const maxLength = this._getMaxTextLength(service)
    const countBytes = service?.countBytes ?? false
    const length = countBytes ? Buffer.byteLength(text) : text.length
    if (length > maxLength) {
      return { length, maxLength, countBytes }
    }
    return null
  }

  /**
   * Searches LazyPy TTS using colon syntax for voice (and optional service).
   * @param {string} query - Text or structured query to synthesize.
   * @example lazypytts:Luciana:hello world
   * @example lazypytts:Cerence:Luciana:hello world
   * @example lazytts:Luciana:hello world
   */
  async search(query) {
    if (!query) return { loadType: 'empty', data: {} }

    try {
      const parsed = this._parseInput(query)
      const resolved = this._resolveRequest(parsed)

      if (!resolved.text) return { loadType: 'empty', data: {} }

      const lengthCheck = this._validateTextLength(
        resolved.text,
        resolved.service
      )
      if (lengthCheck) {
        const unit = lengthCheck.countBytes ? 'bytes' : 'characters'
        return {
          exception: {
            message: `Text too long for LazyPy TTS (${resolved.serviceName}). Max ${lengthCheck.maxLength} ${unit}.`,
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const track = this.buildTrack(resolved)
      return { loadType: 'track', data: track }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  async resolve(query) {
    return this.search(query)
  }

  buildTrack({ text, serviceName, voiceId, voiceLabel }) {
    const query = new URLSearchParams({
      service: String(serviceName),
      voice: String(voiceId),
      text: String(text)
    }).toString()
    const titleText = text.length > 50 ? `${text.substring(0, 47)}...` : text

    const track = {
      identifier: `lazypytts:${query}`,
      isSeekable: true,
      author: 'LazyPy TTS',
      length: -1,
      isStream: false,
      position: 0,
      title: `TTS (${voiceLabel}): ${titleText}`,
      uri: `lazypytts:${query}`,
      artworkUrl: null,
      isrc: null,
      sourceName: 'lazypytts'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  async getTrackUrl(track) {
    return {
      url: track.uri,
      protocol: 'lazypytts',
      format: 'mp3'
    }
  }

  async loadStream(decodedTrack, url, _protocol, _additionalData) {
    logger(
      'debug',
      'Sources',
      `Loading LazyPy TTS stream for "${decodedTrack.title}"`
    )

    try {
      const parsed = this._parseInput(url)
      const resolved = this._resolveRequest(parsed)

      if (!resolved.text) {
        return {
          exception: {
            message: 'LazyPy TTS text is empty.',
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const lengthCheck = this._validateTextLength(
        resolved.text,
        resolved.service
      )
      if (lengthCheck) {
        const unit = lengthCheck.countBytes ? 'bytes' : 'characters'
        return {
          exception: {
            message: `Text too long for LazyPy TTS (${resolved.serviceName}). Max ${lengthCheck.maxLength} ${unit}.`,
            severity: 'fault',
            cause: 'BadRequest'
          }
        }
      }

      const body = new URLSearchParams({
        service: resolved.serviceName,
        voice: resolved.voiceId,
        text: resolved.text
      }).toString()

      const {
        body: responseBody,
        error,
        statusCode
      } = await makeRequest(REQUEST_URL, {
        method: 'POST',
        body,
        disableBodyCompression: true,
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://lazypy.ro',
          Referer: 'https://lazypy.ro/tts/',
          'User-Agent': 'NodeLink/LazyPyTTS'
        }
      })

      if (error || statusCode !== 200 || !responseBody) {
        throw new Error(
          error?.message || `LazyPy TTS returned status ${statusCode}`
        )
      }

      const payload =
        typeof responseBody === 'string'
          ? JSON.parse(responseBody)
          : responseBody

      if (!payload?.success || !payload.audio_url) {
        throw new Error(payload?.error_msg || 'LazyPy TTS request failed.')
      }

      const audioResponse = await makeRequest(payload.audio_url, {
        method: 'GET',
        streamOnly: true,
        headers: {
          Accept: '*/*',
          'User-Agent': 'NodeLink/LazyPyTTS'
        }
      })

      if (audioResponse.error || !audioResponse.stream) {
        throw (
          audioResponse.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()

      audioResponse.stream.on('data', (chunk) => {
        stream.write(chunk)
      })

      audioResponse.stream.on('end', () => {
        stream.emit('finishBuffering')
        stream.end()
      })

      audioResponse.stream.on('close', () => {
        if (!stream.destroyed) stream.end()
      })

      audioResponse.stream.on('error', (err) => {
        logger('error', 'Sources', `LazyPy TTS stream error: ${err.message}`)
        if (!stream.destroyed) stream.destroy(err)
      })

      return { stream }
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Failed to load LazyPy TTS stream: ${err.message}`
      )
      return {
        exception: {
          message: err.message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }
}
