import { logger, makeRequest } from '../utils.js'

const APPLE_SEARCH_API = `http://lyrics.paxsenix.dpdns.org/searchAppleMusic.php?q=`
const APPLE_LYRICS_API = `http://lyrics.paxsenix.dpdns.org/getAppleMusicLyrics.php?id=`

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]

const FEAT_PATTERN = /\s*[\(\[]\s*(?:ft\.?|feat\.?|featuring)\s+[^\)\]]+[\)\]]/gi
const SEPARATORS = [' - ', ' – ', ' — ']

const _clean = (text, removeFeat = false) => {
  let result = text
  for (const pattern of CLEAN_PATTERNS) result = result.replace(pattern, '')
  if (removeFeat) result = result.replace(FEAT_PATTERN, '')
  return result.trim()
}

const _parse = (query) => {
  const cleaned = _clean(query, true)
  for (const sep of SEPARATORS) {
    const idx = cleaned.indexOf(sep)
    if (idx > 0 && idx < cleaned.length - sep.length) {
      return { artist: cleaned.slice(0, idx).trim(), title: cleaned.slice(idx + sep.length).trim() }
    }
  }
  return { artist: null, title: _clean(query, true) }
}

class YTMusic {
  constructor() {
    this.isReady = false
    this.config = {}
    this.baseUrl = 'https://music.youtube.com/'
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.129 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  }

  async initialize(options = {}) {
    try {
      const { GL, HL } = options
      const { body: html } = await makeRequest(this.baseUrl, { method: 'GET', headers: this.defaultHeaders, timeout: 8000 })
      const matches = html.match(/ytcfg\.set\(.*\)/) || [];
      const parsed = matches
        .map(x => x.slice(10, -1))
        .map(x => { try { return JSON.parse(x) } catch { return null } })
        .filter(Boolean)
      this.config = parsed.reduce((acc, v) => ({ ...acc, ...v }), {})
      if (GL) this.config.GL = GL
      if (HL) this.config.HL = HL
      if (!this.config.INNERTUBE_API_KEY) {
        logger('error', 'YTMusic', 'Initialization failed: Missing required config')
        return
      }
      this.isReady = true
      logger('info', 'YTMusic', 'Initialized successfully')
    } catch (e) {
      logger('error', 'YTMusic', `Initialization error: ${e.message}`)
    }
  }

  _buildHeaders() {
    const headers = {
      ...this.defaultHeaders,
      'X-Goog-Visitor-Id': this.config.VISITOR_DATA || '',
      'X-YouTube-Client-Name': this.config.INNERTUBE_CONTEXT_CLIENT_NAME,
      'X-YouTube-Client-Version': this.config.INNERTUBE_CLIENT_VERSION,
      'X-YouTube-Device': this.config.DEVICE,
      'X-YouTube-Page-CL': this.config.PAGE_CL,
      'X-YouTube-Page-Label': this.config.PAGE_BUILD_LABEL,
      'X-YouTube-Utc-Offset': String(-new Date().getTimezoneOffset()),
      'X-YouTube-Time-Zone': Intl.DateTimeFormat().resolvedOptions().timeZone
    }
    for (const k of Object.keys(headers)) {
      if (headers[k] === undefined || headers[k] === null || headers[k] === '') delete headers[k]
    }
    return headers
  }

  async _post(endpoint, body = {}, query = {}) {
    if (!this.isReady) throw new Error('YTMusic not initialized')
    const params = new URLSearchParams({ alt: 'json', key: this.config.INNERTUBE_API_KEY, ...query }).toString()
    const url = `${this.baseUrl}/youtubei/${this.config.INNERTUBE_API_VERSION || 'v1'}/${endpoint}?${params}`
    const payload = {
      context: {
        capabilities: {},
        client: {
          clientName: this.config.INNERTUBE_CLIENT_NAME || this.config.INNERTUBE_CONTEXT_CLIENT_NAME || 'WEB_REMIX',
          clientVersion: this.config.INNERTUBE_CLIENT_VERSION || '0.0.0',
          experimentIds: [],
          experimentsToken: '',
          gl: this.config.GL,
          hl: this.config.HL,
          locationInfo: { locationPermissionAuthorizationStatus: 'LOCATION_PERMISSION_AUTHORIZATION_STATUS_UNSUPPORTED' },
          musicAppInfo: {
            musicActivityMasterSwitch: 'MUSIC_ACTIVITY_MASTER_SWITCH_INDETERMINATE',
            musicLocationMasterSwitch: 'MUSIC_LOCATION_MASTER_SWITCH_INDETERMINATE',
            pwaInstallabilityStatus: 'PWA_INSTALLABILITY_STATUS_UNKNOWN'
          },
          utcOffsetMinutes: -new Date().getTimezoneOffset()
        },
        request: {
          internalExperimentFlags: [
            { key: 'force_music_enable_outertube_tastebuilder_browse', value: 'true' },
            { key: 'force_music_enable_outertube_playlist_detail_browse', value: 'true' },
            { key: 'force_music_enable_outertube_search_suggestions', value: 'true' }
          ]
        },
        user: { enableSafetyMode: false }
      },
      ...body
    }
    const headers = this._buildHeaders()
    const { body: res } = await makeRequest(url, { method: 'POST', headers, body: payload, timeout: 8000 })
    return res
  }

  async getSongInfo(videoId) {
    if (!this.isReady) {
      logger('warn', 'YTMusic', 'getSongInfo called before initialization')
      return { title: null, artists: [], thumbnail: null, duration: null }
    }
    if (!videoId || typeof videoId !== 'string') {
      logger('warn', 'YTMusic', 'Invalid videoId provided')
      return { title: null, artists: [], thumbnail: null, duration: null }
    }
    try {
      const body = {
        enablePersistentPlaylistPanel: true,
        tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        videoId,
        isAudioOnly: true,
        responsiveSignals: { videoInteraction: [] },
        queueContextParams: ''
      }
      const data = await this._post('next', body, { prettyPrint: 'false' })
      return extract(data)
    } catch (e) {
      logger('error', 'YTMusic', `getSongInfo error: ${e.message}`)
      return { title: null, artists: [], thumbnail: null, duration: null }
    }

    function extract(data) {
      try {
        const contents = data.contents.singleColumnMusicWatchNextResultsRenderer
          .tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0]
          .tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.contents
        const first = contents[0].playlistPanelVideoRenderer
        const title = first.title?.runs?.[0]?.text || null
        const artistRuns = first.longBylineText?.runs || []
        const artists = artistRuns
          .filter(r =>
            r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST'
          )
          .map(r => r.text)
        const thumbs = first.thumbnail?.thumbnails || []
        const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : null
        const duration = first.lengthText?.runs?.[0]?.text || null
        return { title, artists, thumbnail, duration }
      } catch (e) {
        logger('error', 'YTMusic', `extractSongInfo error: ${e.message}`)
        return { title: null, artists: [], thumbnail: null, duration: null }
      }
    }
  }
}

export default class AppleMusicLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.ytm = null
  }

  async setup() {
    const adv = this.config.lyrics.applemusic?.advanceSearch || false
    if (adv) {
      this.ytm = new YTMusic()
      await this.ytm.initialize({})
      logger('info', 'Lyrics', 'Apple Music: Advanced search initialized')
    }
    return true
  }

  _parseSynced(contentArray) {
    const lines = []
    for (const e of contentArray) {
      const txt = e.text?.map(t => t.text).join(' ').trim()
      if (!txt) continue
      const s = e.timestamp ?? 0
      const ed = e.endtime ?? 0
      lines.push({ text: txt, time: s, duration: Math.max(ed - s, 0) })
    }
    return lines
  }

  async _getLyricsByID(id) {
    try {
      const url = APPLE_LYRICS_API + id
      const { body } = await makeRequest(url, { method: 'GET' })
      if (!body) return null
      const synced = body.type === 'Line'
      let lines = []
      if (synced) {
        lines = this._parseSynced(body.content)
      } else {
        const raw = body.plainLyrics ?? ''
        lines = raw.split('\n').map(l => l.trim()).filter(Boolean).map(t => ({ text: t, time: 0, duration: 0 }))
      }
      if (!lines.length) return null
      return { synced, lines }
    } catch {
      return null
    }
  }

  _findBestAppleMatch(results, title, authors) {
    if (!title) return results[0]
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim()
    const scoreStrings = (a, b) => {
      a = normalize(a)
      b = normalize(b)
      if (a === b) return 100
      let m = 0
      const len = Math.max(a.length, b.length)
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) m++
      return Math.round((m / len) * 100)
    }
    let best = null
    let bestScore = -1
    for (const r of results) {
      const ts = scoreStrings(r.songName, title)
      let as = 0
      if (authors.length) as = Math.max(...authors.map(a => scoreStrings(r.artistName, a)))
      const final = ts * 0.7 + as * 0.3
      r.__matchScore = final
      if (final > bestScore) {
        bestScore = final
        best = r
      }
    }
    return best
  }

  async _searchApple(info) {
    let title = null
    let authors = []
    if (info.sourceName === 'youtube') {
      if (!this.ytm || !this.ytm.isReady) {
        logger('warn', 'Lyrics', 'YTMusic not ready, skipping YTM fetch.')
      } else {
        try {
          const res = await this.ytm.getSongInfo(info.identifier)

          if (res && res.title) {
            title = info.title !== res.title ? res.title : _clean(info.title, true)
            authors = Array.isArray(res.artists) ? res.artists : []
          } else {
            logger('warn', 'Lyrics', 'YTMusic returned invalid info, fallback used.')
          }
        } catch (err) {
          logger('error', 'Lyrics', `YTMusic fetch failed: ${err.message}`)
        }
      }
    }

    const query = (() => {
      if (title && authors.length) return `${title} ${authors[0]}`
      if (title) return title
      return `${_clean(info.title, true)} ${_clean(info.author, false)}`
    })()
    let results
    try {
      const url = APPLE_SEARCH_API + encodeURIComponent(query)
      const { body: raw } = await makeRequest(url, { method: 'GET', timeout: 4000 })
      results = JSON.parse(raw)
    } catch (e) {
      logger('error', 'Lyrics', `AppleMusic: Apple search failed (${e.message})`)
      return null
    }
    if (!Array.isArray(results) || !results.length) {
      logger('warn', 'Lyrics', 'AppleMusic: No results returned.')
      return null
    }
    let best = null
    try {
      best = this._findBestAppleMatch(results, _clean(title), authors)
    } catch (e) {
      logger('error', 'Lyrics', `Matching failed (${e.message})`)
    }
    if (!best) {
      logger('warn', 'Lyrics', 'AppleMusic: No strong match, falling back.')
      return results[0]
    }

    return best
  }

  async getLyrics(trackInfo) {
    try {
      const isApple = trackInfo.sourceName === 'applemusic'
      let id = null
      let matched = null
      if (isApple && trackInfo.identifier) {
        id = trackInfo.identifier
        logger('debug', 'Lyrics', `AppleMusic: Direct ID: ${id}`)
      }
      if (!id) {
        matched = await this._searchApple(trackInfo)
        if (!matched) return { loadType: 'empty', data: {} }
        id = matched.id
      }
      const lyr = await this._getLyricsByID(id)
      if (!lyr) return { loadType: 'empty', data: {} }
      const trackName = matched?.songName || trackInfo.title
      return {
        loadType: 'lyrics',
        data: {
          name: trackName,
          synced: lyr.synced,
          lines: lyr.lines
        }
      }
    } catch (e) {
      logger('error', 'Lyrics', `AppleMusic error: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }
}
