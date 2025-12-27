import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import crypto from 'node:crypto'
import { encodeTrack, logger, makeRequest, http1makeRequest } from '../utils.js'

const API_BASE = 'https://api.vk.com/method/'
const API_VERSION = '5.131'
const BASE64_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/='
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0'

async function manageVkHlsStream(url, outputStream, cookie, localAddress) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Referer': 'https://vk.com/',
    'Origin': 'https://vk.com',
    'Cookie': cookie || ''
  }

  try {
    const { body: manifest, error, statusCode } = await http1makeRequest(url, { headers, localAddress })
    if (error || statusCode !== 200) throw new Error(`Failed to fetch manifest: ${statusCode}`)

    const lines = manifest.split('\n').map(l => l.trim())
    const segments = []
    let currentKey = null
    let mediaSequence = 0

    const mediaSeqLine = lines.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
    if (mediaSeqLine) mediaSequence = parseInt(mediaSeqLine.split(':')[1], 10)

    const keyMap = new Map()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([^,]+)/)
        const method = methodMatch ? methodMatch[1] : 'NONE'
        
        if (method === 'NONE') {
          currentKey = null
        } else {
          const uriMatch = line.match(/URI="([^"]+)"/)
          if (uriMatch) {
            const keyUrl = new URL(uriMatch[1], url).toString()
            if (!keyMap.has(keyUrl)) {
              const { body: keyData, error: keyError } = await http1makeRequest(keyUrl, { 
                headers, 
                localAddress,
                responseType: 'buffer' 
              })
              if (!keyError) keyMap.set(keyUrl, keyData)
            }
            currentKey = { method, data: keyMap.get(keyUrl) }
          }
        }
      } else if (line.startsWith('#EXTINF:')) {
        const segmentUrl = lines[++i]
        if (segmentUrl && !segmentUrl.startsWith('#')) {
          segments.push({
            url: new URL(segmentUrl, url).toString(),
            key: currentKey ? { ...currentKey } : null,
            sequence: mediaSequence++
          })
        }
      }
    }

    for (const segment of segments) {
      if (outputStream.destroyed) break

      try {
        const { body: encryptedData, error: segError } = await http1makeRequest(segment.url, { 
          headers, 
          localAddress,
          responseType: 'buffer',
          timeout: 10000
        })
        
        if (segError || !encryptedData) continue

        let data = encryptedData
        if (segment.key && segment.key.method === 'AES-128' && segment.key.data) {
          try {
            const iv = Buffer.alloc(16)
            iv.writeUInt32BE(segment.sequence, 12)
            
            const decipher = crypto.createDecipheriv('aes-128-cbc', segment.key.data, iv)
            decipher.setAutoPadding(false)
            data = Buffer.concat([decipher.update(encryptedData), decipher.final()])
          } catch (decErr) {
            logger('error', 'VKMusic-HLS', `Decryption failed for segment ${segment.sequence}: ${decErr.message}`)
            continue
          }
        }

        const mp3Payloads = []
        for (let i = 0; i <= data.length - 188; i += 188) {
          if (data[i] !== 0x47) continue
          const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2]
          if (pid === 0x100) {
            const adaptationField = (data[i + 3] & 0x20) >> 5
            const payloadExists = (data[i + 3] & 0x10) >> 4
            if (payloadExists) {
              let offset = 4
              if (adaptationField) offset += data[i + 4] + 1
              if (offset < 188) {
                let payload = data.slice(i + offset, i + 188)
                if (payload[0] === 0x00 && payload[1] === 0x00 && payload[2] === 0x01) {
                  const headerLen = payload[8]
                  payload = payload.slice(9 + headerLen)
                }
                mp3Payloads.push(payload)
              }
            }
          }
        }

        const mp3Buffer = Buffer.concat(mp3Payloads)
        if (mp3Buffer.length > 0) {
          if (!outputStream.write(mp3Buffer)) {
            await new Promise(resolve => outputStream.once('drain', resolve))
          }
        }
      } catch (e) {
        logger('error', 'VKMusic-HLS', `Segment processing error (Seq ${segment.sequence}): ${e.message}`)
      }
    }

    if (!outputStream.destroyed) {
      outputStream.emit('finishBuffering')
      outputStream.end()
    }
  } catch (e) {
    logger('error', 'VKMusic-HLS', `HLS management failed: ${e.message}`)
    if (!outputStream.destroyed) outputStream.destroy(e)
  }
}

export default class VKMusicSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.vkmusic || {}
    this.searchTerms = ['vksearch']
    this.patterns = [
      /vk\.(?:com|ru)\/.*?[?&]z=audio_playlist(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
      /vk\.(?:com|ru)\/(?:music\/(?:playlist|album)\/)(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
      /vk\.(?:com|ru)\/audio(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/)(?<hash>[a-z0-9]+))?/i,
      /vk\.(?:com|ru)\/artist\/(?<id>[^/?#\s&]+)/i,
      /vk\.(?:com|ru)\/audios(?<id>-?\d+)/i
    ]
    this.priority = 80
    this.userId = 0
    this.hasToken = false
    this.accessToken = this.config.userToken || null
    this.tokenExpiry = 0
    this.cookie = this.config.userCookie || ''
  }
    
      async setup() {
        const cachedToken = this.nodelink.credentialManager.get('vk_access_token')
        if (cachedToken) {
          this.accessToken = cachedToken
          this.hasToken = true
          logger('info', 'VKMusic', 'Loaded access token from CredentialManager.')
          return true
        }

        if (this.accessToken || this.cookie) {
          try {
            if (!this.accessToken && this.cookie) {
              await this._refreshAccessToken()
            }
            const response = await this._apiRequest('users.get', {})
            if (response && response[0]) {
              this.userId = response[0].id
              this.hasToken = true
              logger('info', 'VKMusic', `Loaded VKMusic source. Logged in as: ${response[0].first_name} ${response[0].last_name} (${this.userId})`)
              return true
            }
          } catch (e) {
            logger('warn', 'VKMusic', `Auth failed: ${e.message}. Falling back to scraping mode.`)
          }
        } else {
          logger('warn', 'VKMusic', 'No auth provided. Running in scraping mode.')
        }
        return true
      }
    
      async _refreshAccessToken() {
        if (!this.cookie) throw new Error('No cookie provided for token refresh')
        const { body, error, statusCode } = await http1makeRequest('https://login.vk.ru/?act=web_token', {
          method: 'POST',
          headers: {
            'Host': 'login.vk.ru',
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://vk.ru/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://vk.ru',
            'Cookie': this.cookie,
            'Connection': 'keep-alive'
          },
          body: 'version=1&app_id=6287487',
          disableBodyCompression: true,
          localAddress: this.nodelink.routePlanner?.getIP()
        })
        if (error || statusCode !== 200) throw new Error(`Failed to refresh token: ${error?.message || statusCode}`)
        if (body.type === 'okay' && body.data?.access_token) {
          this.accessToken = body.data.access_token
          this.tokenExpiry = body.data.expires * 1000
          this.userId = body.data.user_id
          this.nodelink.credentialManager.set('vk_access_token', this.accessToken, body.data.expires * 1000 - Date.now())
          return this.accessToken
        }
        throw new Error(`Invalid act=web_token response: ${JSON.stringify(body)}`)
      }
    
      async search(query) {
        if (!this.hasToken) return { exception: { message: 'VKMusic search requires valid auth.', severity: 'common' } }
        try {
          const res = await this._apiRequest('audio.search', {
            q: query,
            count: this.nodelink.options.maxSearchResults || 10,
            sort: 2,
            auto_complete: 1
          })
          if (!res || !res.items || res.items.length === 0) return { loadType: 'empty', data: {} }
          const tracks = res.items.map(item => this.buildTrack(item))
          return { loadType: 'search', data: tracks }
        } catch (e) {
          return { exception: { message: e.message, severity: 'fault' } }
        }
      }
    
  async resolve(url) {
    const playlistMatch =
      url.match(this.patterns[0]) || url.match(this.patterns[1])
    if (playlistMatch) {
      const { owner, id, hash } = playlistMatch.groups
      return this._resolvePlaylist(owner, id, hash, url)
    }

    const trackMatch = url.match(this.patterns[2])
    if (trackMatch) return this._resolveTrack(url)

    const artistMatch = url.match(this.patterns[3])
    if (artistMatch) {
      const artistId = artistMatch.groups.id
      if (this.hasToken) {
        const res = await this.search(decodeURIComponent(artistId))
        if (res.loadType === 'search') {
          return {
            loadType: 'playlist',
            data: {
              info: {
                name: `Artist: ${decodeURIComponent(artistId)}`,
                selectedTrack: 0,
              },
              tracks: res.data,
            },
          }
        }
        return res
      }
      return this._scrapePlaylist(url)
    }

    const audiosMatch = url.match(this.patterns[4])
    if (audiosMatch)
      return this._resolvePlaylist(audiosMatch.groups.id, '-1', null, url)

    return { loadType: 'empty', data: {} }
  }  async _resolvePlaylist(ownerId, playlistId, accessKey, url) {
    if (this.hasToken) {
        try {
            const params = {
                owner_id: ownerId,
                album_id: playlistId,
                count: this.nodelink.options.maxAlbumPlaylistLength || 100
            }
            if (accessKey) params.access_key = accessKey
            const res = await this._apiRequest('audio.get', params)
            if (res && res.items && res.items.length > 0) {
                let playlistTitle = `VK Playlist ${ownerId}_${playlistId}`
                try {
                    const plList = await this._apiRequest('audio.getPlaylists', { owner_id: ownerId, count: 50 })
                    const pl = plList?.items?.find(p => p.id == playlistId)
                    if (pl) playlistTitle = pl.title
                } catch {} 
                const tracks = res.items.map(item => this.buildTrack(item))
                return { loadType: 'playlist', data: { info: { name: playlistTitle, selectedTrack: 0 }, tracks } }
            }
        } catch (e) {
            logger('debug', 'VKMusic', `API playlist resolution failed: ${e.message}. Falling back to scraping.`)
        } 
    }
    return this._scrapePlaylist(url)
  }

  async _resolveTrack(url) {
    if (this.hasToken) {
      try {
        const trackMatch = url.match(this.patterns[1])
        const { owner, id, hash } = trackMatch.groups
        const audios = `${owner}_${id}${hash ? `_${hash}` : ''}`
        const res = await this._apiRequest('audio.getById', { audios })
        if (res?.[0]) return { loadType: 'track', data: this.buildTrack(res[0]) }
      } catch (e) {
        logger(
          'debug',
          'VKMusic',
          `API track resolution failed: ${e.message}. Falling back to scraping.`,
        )
      }
    }
    return this._scrapeTrack(url)
  }

  async _scrapeTrack(url) {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (statusCode !== 200) throw new Error(`Status ${statusCode}`)
      const dataAudioMatch = body.match(/data-audio="([^"]+)"/)
      if (!dataAudioMatch) {
        const execMatch = body.match(
          /class="AudioPlayerBlock__root"[^>]+data-exec="([^"]+)"/,
        )
        if (execMatch) {
          const escapedJson = execMatch[1].replace(/&quot;/g, '"')
          const execData = JSON.parse(escapedJson)
          const meta = execData?.['AudioPlayerBlock/init']?.firstAudio
          if (meta) return { loadType: 'track', data: this._parseMeta(meta) }
        }
        throw new Error('Could not find track data in page')
      }
      const data = JSON.parse(dataAudioMatch[1].replace(/&quot;/g, '"'))
      return { loadType: 'track', data: this._parseMeta(data) }
    } catch (e) {
      return {
        exception: { message: `Scraping failed: ${e.message}`, severity: 'fault' },
      }
    }
  }

  async _scrapePlaylist(url) {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': USER_AGENT },
      })
      if (statusCode !== 200) throw new Error(`Status ${statusCode}`)
      const playlistTitleMatch =
        body.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
        body.match(/class="AudioPlaylistSnippet__title"[^>]*>([^<]+)<\/div>/)
      const playlistTitle = playlistTitleMatch
        ? playlistTitleMatch[1].trim()
        : 'VK Playlist'
      const tracks = []
      const audioMatches = body.matchAll(/data-audio="([^"]+)"/g)
      for (const match of audioMatches) {
        try {
          const data = JSON.parse(match[1].replace(/&quot;/g, '"'))
          const parsed = this._parseMeta(data)
          if (parsed) tracks.push(parsed)
        } catch (_e) {}
      }
      if (tracks.length === 0) {
        const execMatch = body.match(/data-exec="([^"]+)"/)
        if (execMatch) {
          try {
            const execData = JSON.parse(execMatch[1].replace(/&quot;/g, '"'))
            const list =
              execData?.['AudioPlaylistSnippet/init']?.playlist?.list ||
              (execData?.['AudioPlayerBlock/init']?.firstAudio
                ? [execData['AudioPlayerBlock/init'].firstAudio]
                : [])
            for (const meta of list) {
              const parsed = this._parseMeta(meta)
              if (parsed) tracks.push(parsed)
            }
          } catch (_e) {}
        }
      }
      if (tracks.length === 0) return { loadType: 'empty', data: {} }
      return {
        loadType: 'playlist',
        data: { info: { name: playlistTitle, selectedTrack: 0 }, tracks },
      }
    } catch (e) {
      return {
        exception: {
          message: `Playlist scraping failed: ${e.message}`,
          severity: 'fault',
        },
      }
    }
  }

  _parseMeta(data) {
      if (!Array.isArray(data) || data.length < 6) return null
      const trackId = data[0], ownerId = data[1], title = data[3], artist = data[4], duration = data[5]
      let rawUrl = data[2]
      const coverUrl = data[14] ? data[14].split(',')[0] : null
      if (rawUrl && rawUrl.includes('audio_api_unavailable')) rawUrl = this._unmask_url(rawUrl, this.userId)
      const id = `${ownerId}_${trackId}`
      const trackInfo = { identifier: id, isSeekable: true, author: artist, length: duration * 1000, isStream: false, position: 0, title, uri: `https://vk.com/audio${id}`, artworkUrl: coverUrl, isrc: null, sourceName: 'vkmusic' }
      return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: { streamUrl: rawUrl } }
  }

  buildTrack(item) {
    const artist = item.artist, title = item.title, duration = item.duration * 1000, id = `${item.owner_id}_${item.id}`
    let uri = item.url || ''
    if (uri && uri.includes('audio_api_unavailable')) uri = this._unmask_url(uri, this.userId)
    const trackInfo = { identifier: id, isSeekable: true, author: artist, length: duration, isStream: false, position: 0, title, uri: `https://vk.com/audio${id}`, artworkUrl: item.album?.thumb?.photo_600 || item.album?.thumb?.photo_300 || null, isrc: null, sourceName: 'vkmusic' }
    return { encoded: encodeTrack(trackInfo), info: trackInfo, pluginInfo: { access_key: item.access_key, streamUrl: uri } }
  }

  async getTrackUrl(decodedTrack) {
      let url = decodedTrack.pluginInfo?.streamUrl
      if (!url && this.hasToken) {
        try {
            let audios = decodedTrack.identifier
            if (decodedTrack.pluginInfo?.access_key) audios += `_${decodedTrack.pluginInfo.access_key}`
            const res = await this._apiRequest('audio.getById', { audios })
            if (res && res.length > 0) {
                url = res[0].url
                if (url && url.includes('audio_api_unavailable')) url = this._unmask_url(url, this.userId)
            }
        } catch(e) {}
      }
      if (!url) {
          const scrapeRes = await this._scrapeTrack(`https://vk.com/audio${decodedTrack.identifier}`)
          if (scrapeRes.loadType === 'track' && scrapeRes.data.pluginInfo?.streamUrl) url = scrapeRes.data.pluginInfo.streamUrl
      }
    if (url) {
      const isHls = url.includes('.m3u8')
      return {
        url,
        protocol: isHls ? 'hls' : 'https',
        format: isHls ? 'mpegts' : 'mp3',
      }
    }
      const query = `${decodedTrack.title} ${decodedTrack.author}`
      const searchRes = await this.nodelink.sources.searchWithDefault(query)
      if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
          const best = searchRes.data[0]
          const streamInfo = await this.nodelink.sources.getTrackUrl(best.info)
          return { newTrack: best, ...streamInfo }
      }
      return { exception: { message: 'Failed to retrieve track URL.', severity: 'fault' } }
  }

  async loadStream(track, url, protocol) {
      try {
        if (url.includes('.m3u8')) {
            const stream = new PassThrough()
            manageVkHlsStream(url, stream, this.cookie, this.nodelink.routePlanner?.getIP())
            return { stream, type: 'mp3' }
        }
        const { stream, error } = await http1makeRequest(url, { method: 'GET', streamOnly: true, headers: { 'User-Agent': USER_AGENT, 'Cookie': this.cookie } })
        if (error) throw error
        return { stream, type: 'mp3' }
      } catch (e) {
          return { exception: { message: e.message, severity: 'fault' } }
      }
  }

  async _apiRequest(method, params) {
    if (this.cookie && (!this.accessToken || (this.tokenExpiry && Date.now() >= this.tokenExpiry - 60000))) await this._refreshAccessToken()
    const url = new URL(API_BASE + method)
    params.access_token = this.accessToken
    params.v = API_VERSION
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]))
    const { body, error, statusCode } = await makeRequest(url.toString(), { method: 'GET', headers: { 'User-Agent': 'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)' }, localAddress: this.nodelink.routePlanner?.getIP() })
    if (error || statusCode !== 200) {
        if ((statusCode === 401 || (body && body.error?.error_code === 5)) && this.cookie) {
          await this._refreshAccessToken()
          return this._apiRequest(method, params)
        }
        throw new Error(error?.message || `HTTP ${statusCode}`)
    }
    if (body.error) {
        if (body.error.error_code === 5 && this.cookie) {
          await this._refreshAccessToken()
          return this._apiRequest(method, params)
        }
        throw new Error(`VK API Error ${body.error.error_code}: ${body.error.error_msg}`)
    }
    return body.response
  }

  _b64_decode(enc) {
    let dec = '', e = 0, n = 0
    for (let i = 0; i < enc.length; i++) {
        const c = enc[i], r = BASE64_CHARS.indexOf(c)
        if (r === -1) continue 
        const cond = n % 4
        e = cond ? 64 * e + r : r
        n++
        if (cond) dec += String.fromCharCode(255 & (e >> (-2 * n & 6)))
    }
    return dec
  }

  _unmask_url(mask_url, vk_id) {
    if (!mask_url.includes('audio_api_unavailable')) return mask_url
    try {
        const parts = mask_url.split('?extra=')[1].split('#'), extra0 = parts[0], extra1 = parts[1]
        const split1 = this._b64_decode(extra1).split(String.fromCharCode(11)), base = split1[1]
        const maskUrlArr = this._b64_decode(extra0).split('')
        const urlLen = maskUrlArr.length, indexes = new Array(urlLen)
        let index = parseInt(base, 10) ^ vk_id
        for (let n = urlLen - 1; n >= 0; n--) {
            index = (urlLen * (n + 1) ^ index + n) % urlLen
            indexes[n] = index
        }
        for (let n = 1; n < urlLen; n++) {
            const c = maskUrlArr[n], idx = indexes[urlLen - 1 - n]
            maskUrlArr[n] = maskUrlArr[idx], maskUrlArr[idx] = c
        }
        return maskUrlArr.join('')
    } catch(e) {
        logger('error', 'VKMusic', `Failed to unmask URL: ${e.message}`)
        return null
    }
  }
}