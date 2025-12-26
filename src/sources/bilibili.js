import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { encodeTrack, http1makeRequest, logger, makeRequest } from '../utils.js'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/'
}

export default class BilibiliSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+|av\d+)/,
      /https?:\/\/(?:www\.)?bilibili\.com\/bangumi\/play\/(ep|ss)(\d+)/,
      /https?:\/\/(?:www\.)?bilibili\.com\/audio\/(au|am)(\d+)/,
      /https?:\/\/live\.bilibili\.com\/(\d+)/,
      /https?:\/\/space\.bilibili\.com\/(\d+)/ 
    ]
    this.searchTerms = ['bilibili']
    this.priority = 100
    this.wbiKeys = null
    this.wbiKeysExpiry = 0
    this.cookie = this.nodelink.options.sources?.bilibili?.sessdata 
      ? `SESSDATA=${this.nodelink.options.sources.bilibili.sessdata}` 
      : ''
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Bilibili source (Video, Audio, Live, Space, Lyrics, Login).')
    return true
  }

  async _getWbiKeys() {
    if (this.wbiKeys && Date.now() < this.wbiKeysExpiry) {
      return this.wbiKeys
    }

    const cachedKeys = this.nodelink.credentialManager.get('bilibili_wbi_keys')
    if (cachedKeys) {
      this.wbiKeys = cachedKeys
      this.wbiKeysExpiry = Date.now() + 1000 * 60 * 60
      return this.wbiKeys
    }

    const { body, error } = await makeRequest('https://api.bilibili.com/x/web-interface/nav', {
      method: 'GET',
      headers: { ...HEADERS, Cookie: this.cookie }
    })

    if (error || !body?.data?.wbi_img) {
      throw new Error('Failed to fetch WBI keys')
    }

    const { img_url, sub_url } = body.data.wbi_img
    const imgKey = img_url.slice(
      img_url.lastIndexOf('/') + 1,
      img_url.lastIndexOf('.')
    )
    const subKey = sub_url.slice(
      sub_url.lastIndexOf('/') + 1,
      sub_url.lastIndexOf('.')
    )

    const rawKey = imgKey + subKey
    let mixinKey = ''
    for (const index of MIXIN_KEY_ENC_TAB) {
      if (rawKey[index]) mixinKey += rawKey[index]
    }
    
    this.wbiKeys = mixinKey.slice(0, 32)
    this.wbiKeysExpiry = Date.now() + 1000 * 60 * 60
    this.nodelink.credentialManager.set('bilibili_wbi_keys', this.wbiKeys, 1000 * 60 * 60)
    
    return this.wbiKeys
  }

  _signWbi(params, mixinKey) {
    const currTime = Math.round(Date.now() / 1000)
    const newParams = { ...params, wts: currTime }
    
    const query = Object.keys(newParams)
      .sort()
      .map(key => {
        const value = newParams[key].toString().replace(/[!'()*]/g, '')
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      })
      .join('&')

    const w_rid = crypto
      .createHash('md5')
      .update(query + mixinKey)
      .digest('hex')

    return `${query}&w_rid=${w_rid}`
  }

  async search(query) {
    try {
      let body
      let error

      const searchResponse = await makeRequest(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}`,
        {
          method: 'GET',
          headers: { ...HEADERS, Cookie: this.cookie, Referer: 'https://search.bilibili.com/' }
        }
      )
      body = searchResponse.body
      error = searchResponse.error

      if (!body?.data?.result || !Array.isArray(body.data.result) || body.data.result.length === 0) {
        const allSearchResponse = await makeRequest(
          `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie, Referer: 'https://search.bilibili.com/' }
          }
        )
        body = allSearchResponse.body
        error = allSearchResponse.error
      }

      const results = body?.data?.result || []
      let videos = []

      if (results.length > 0) {
        if (results[0].type === 'video') {
          videos = results
        } else {
          const videoSection = results.find(r => r.result_type === 'video')
          if (videoSection?.data) {
            videos = videoSection.data
          }
        }
      }

      if (!videos || videos.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = []
      for (const item of videos) {
        const durationParts = item.duration.split(':').map(Number)
        let durationMs = 0
        if (durationParts.length === 2) durationMs = (durationParts[0] * 60 + durationParts[1]) * 1000
        else if (durationParts.length === 3) durationMs = (durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]) * 1000

        const trackInfo = {
          identifier: item.bvid,
          isSeekable: true,
          author: item.author,
          length: durationMs,
          isStream: false,
          position: 0,
          title: item.title.replace(/<[^>]*>/g, ''),
          uri: item.arcurl,
          artworkUrl: item.pic.startsWith('//') ? `https:${item.pic}` : item.pic,
          isrc: null,
          sourceName: 'bilibili'
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: { aid: item.aid, cid: item.cid || 0 }
        })
      }

      return { loadType: 'search', data: tracks }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const videoMatch = url.match(this.patterns[0])
    if (videoMatch) {
      const bvidOrAvid = videoMatch[1]
      try {
        let apiUrl = `https://api.bilibili.com/x/web-interface/view?`
        if (bvidOrAvid.startsWith('BV')) {
          apiUrl += `bvid=${bvidOrAvid}`
        } else {
          apiUrl += `aid=${bvidOrAvid.substring(2)}`
        }

        const { body } = await makeRequest(apiUrl, {
          method: 'GET',
          headers: { ...HEADERS, Cookie: this.cookie }
        })

        if (body.code !== 0) {
          const errorMsg = body.message === '啥都木有' ? 'Video not found or deleted' : body.message
          throw new Error(`API Error: ${errorMsg}`)
        }

        const data = body.data
        const trackInfo = {
          identifier: data.bvid,
          isSeekable: true,
          author: data.owner.name,
          length: data.duration * 1000,
          isStream: false,
          position: 0,
          title: data.title,
          uri: `https://www.bilibili.com/video/${data.bvid}`,
          artworkUrl: data.pic,
          isrc: null,
          sourceName: 'bilibili'
        }

        if (data.pages && data.pages.length > 1) {
          const tracks = data.pages.map(page => {
            const pageTrack = { ...trackInfo }
            pageTrack.title = `${data.title} - ${page.part}`
            pageTrack.length = page.duration * 1000
            pageTrack.identifier = `${data.bvid}?p=${page.page}`
            pageTrack.uri = `https://www.bilibili.com/video/${data.bvid}?p=${page.page}`
            
            return {
              encoded: encodeTrack(pageTrack),
              info: pageTrack,
              pluginInfo: { aid: data.aid, cid: page.cid, bvid: data.bvid }
            }
          })

          return {
            loadType: 'playlist',
            data: {
              info: { name: data.title, selectedTrack: 0 },
              tracks
            }
          }
        }

        return {
          loadType: 'track',
          data: {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: { aid: data.aid, cid: data.cid, bvid: data.bvid }
          }
        }
      } catch (e) {
        return { exception: { message: e.message, severity: 'fault' } }
      }
    }

    const bangumiMatch = url.match(this.patterns[1])
    if (bangumiMatch) {
      const type = bangumiMatch[1]
      const id = bangumiMatch[2]
      
      try {
        let apiUrl
        if (type === 'ep') {
          apiUrl = `https://api.bilibili.com/pgc/view/web/season?ep_id=${id}`
        } else {
          apiUrl = `https://api.bilibili.com/pgc/view/web/season?season_id=${id}`
        }

        const { body } = await makeRequest(apiUrl, {
          method: 'GET',
          headers: { ...HEADERS, Cookie: this.cookie }
        })
        
        if (body.code !== 0) throw new Error(`Bangumi API Error: ${body.message}`)
        
        const result = body.result
        const tracks = []

        for (const ep of result.episodes) {
          const trackInfo = {
            identifier: `ep${ep.id}`,
            isSeekable: true,
            author: result.season_title,
            length: ep.duration,
            isStream: false,
            position: 0,
            title: ep.long_title ? `${ep.title} - ${ep.long_title}` : ep.title,
            uri: ep.link,
            artworkUrl: ep.cover,
            isrc: null,
            sourceName: 'bilibili'
          }

          tracks.push({
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: { aid: ep.aid, cid: ep.cid, ep_id: ep.id, bvid: ep.bvid }
          })
        }

        if (type === 'ep') {
          const target = tracks.find(t => t.pluginInfo.ep_id == id)
          if (target) {
            return {
              loadType: 'track',
              data: target
            }
          }
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: result.season_title, selectedTrack: 0 },
            tracks
          }
        }

      } catch (e) {
        return { exception: { message: e.message, severity: 'fault' } }
      }
    }

    const audioMatch = url.match(this.patterns[2])
    if (audioMatch) {
      const type = audioMatch[1]
      const id = audioMatch[2]
      try {
        if (type === 'au') {
          const { body } = await makeRequest(
            `https://www.bilibili.com/audio/music-service-c/web/song/info?sid=${id}`,
            {
              method: 'GET',
              headers: { ...HEADERS, Cookie: this.cookie }
            }
          )
          
          if (body.code !== 0) throw new Error(`Audio API Error: ${body.msg}`)
          
          const data = body.data
          const trackInfo = {
            identifier: `au${data.id}`,
            isSeekable: true,
            author: data.uname,
            length: data.duration * 1000,
            isStream: false,
            position: 0,
            title: data.title,
            uri: `https://www.bilibili.com/audio/au${data.id}`,
            artworkUrl: data.cover,
            isrc: null,
            sourceName: 'bilibili'
          }

          return {
            loadType: 'track',
            data: {
              encoded: encodeTrack(trackInfo),
              info: trackInfo,
              pluginInfo: { sid: data.id, type: 'audio' }
            }
          }
        } else {
          const { body } = await makeRequest(
            `https://www.bilibili.com/audio/music-service-c/web/song/of-menu?sid=${id}&pn=1&ps=100`,
            {
              method: 'GET',
              headers: { ...HEADERS, Cookie: this.cookie }
            }
          )

          if (body.code !== 0) throw new Error(`Album API Error: ${body.msg}`)

          const tracks = body.data.data.map(song => {
            const trackInfo = {
              identifier: `au${song.id}`,
              isSeekable: true,
              author: song.uname,
              length: song.duration * 1000,
              isStream: false,
              position: 0,
              title: song.title,
              uri: `https://www.bilibili.com/audio/au${song.id}`,
              artworkUrl: song.cover,
              isrc: null,
              sourceName: 'bilibili'
            }
            return {
              encoded: encodeTrack(trackInfo),
              info: trackInfo,
              pluginInfo: { sid: song.id, type: 'audio' }
            }
          })

          const { body: infoBody } = await makeRequest(
            `https://www.bilibili.com/audio/music-service-c/web/menu/info?sid=${id}`,
            {
              method: 'GET',
              headers: { ...HEADERS, Cookie: this.cookie }
            }
          )

          return {
            loadType: 'playlist',
            data: {
              info: { name: infoBody?.data?.title || 'Bilibili Album', selectedTrack: 0 },
              tracks
            }
          }
        }
      } catch (e) {
        return { exception: { message: e.message, severity: 'fault' } }
      }
    }

    const liveMatch = url.match(this.patterns[3])
    if (liveMatch) {
      const id = liveMatch[1]
      try {
        const { body } = await makeRequest(
          `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie }
          }
        )

        if (body.code !== 0) throw new Error(`Live API Error: ${body.msg}`)
        
        const data = body.data
        if (data.live_status !== 1) throw new Error('Room is not live')

        const trackInfo = {
          identifier: `live${data.room_id}`,
          isSeekable: false,
          author: `Room ${data.room_id}`,
          length: 0,
          isStream: true,
          position: 0,
          title: data.title,
          uri: `https://live.bilibili.com/${data.room_id}`,
          artworkUrl: data.user_cover,
          isrc: null,
          sourceName: 'bilibili'
        }

        return {
          loadType: 'track',
          data: {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: { room_id: data.room_id, type: 'live' }
          }
        }
      } catch (e) {
        return { exception: { message: e.message, severity: 'fault' } }
      }
    }

    const spaceMatch = url.match(this.patterns[4])
    if (spaceMatch) {
      const mid = spaceMatch[1]
      try {
        const mixinKey = await this._getWbiKeys()
        const query = this._signWbi({
          mid: mid,
          ps: 30,
          tid: 0,
          keyword: '',
          order: 'pubdate'
        }, mixinKey)

        const { body } = await makeRequest(
          `https://api.bilibili.com/x/space/wbi/arc/search?${query}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie }
          }
        )

        if (body.code !== 0) throw new Error(`Space API Error: ${body.message}`)

        const list = body.data?.list?.vlist
        if (!list || list.length === 0) return { loadType: 'empty', data: {} }

        const tracks = list.map(item => {
          const durationParts = item.length.split(':').map(Number)
          let durationMs = 0
          if (durationParts.length === 2) durationMs = (durationParts[0] * 60 + durationParts[1]) * 1000
          else if (durationParts.length === 3) durationMs = (durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2]) * 1000

          const trackInfo = {
            identifier: item.bvid,
            isSeekable: true,
            author: item.author,
            length: durationMs,
            isStream: false,
            position: 0,
            title: item.title,
            uri: `https://www.bilibili.com/video/${item.bvid}`,
            artworkUrl: item.pic,
            isrc: null,
            sourceName: 'bilibili'
          }

          return {
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: { aid: item.aid, bvid: item.bvid, cid: 0 } 
          }
        })

        return {
          loadType: 'playlist',
          data: {
            info: { name: `Uploads by ${list[0].author}`, selectedTrack: 0 },
            tracks
          }
        }
      } catch (e) {
        return { exception: { message: e.message, severity: 'fault' } }
      }
    }

    return { loadType: 'empty', data: {} }
  }

  async getTrackUrl(track) {
    try {
      const isAudio = track.pluginInfo?.type === 'audio' || track.identifier.startsWith('au')
      const isLive = track.pluginInfo?.type === 'live' || track.identifier.startsWith('live')

      if (isAudio) {
        const sid = track.pluginInfo?.sid || track.identifier.replace('au', '')
        const { body } = await makeRequest(
          `https://www.bilibili.com/audio/music-service-c/web/url?sid=${sid}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie }
          }
        )
        if (body.code !== 0 || !body.data.cdns) throw new Error('Failed to get audio stream')
        
        return {
          url: body.data.cdns[0],
          protocol: 'https',
          format: 'mp3'
        }
      }

      if (isLive) {
        const roomId = track.pluginInfo?.room_id || track.identifier.replace('live', '')
        
        const { body } = await makeRequest(
          `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${roomId}&protocol=0,1&format=0,2&codec=0,1&qn=10000&platform=web&pt=web&no_playurl=0&mask=0`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie }
          }
        )

        if (body.code !== 0 || !body.data?.playurl_info) throw new Error('Failed to get live stream info')

        const streams = body.data.playurl_info.playurl.stream
        let targetFormat = null
        let formatType = 'flv'
        let protocol = 'http'

        for (const stream of streams) {
          if (stream.protocol_name === 'http_stream') {
             const fmt = stream.format.find(f => f.format_name === 'flv')
             if (fmt && fmt.codec && fmt.codec.length > 0) {
                targetFormat = fmt.codec[0]
                formatType = 'flv'
                protocol = 'http'
                break
             }
          }
        }
        
        if (!targetFormat) {
           for (const stream of streams) {
              const fmt = stream.format[0]
              if (fmt && fmt.codec && fmt.codec.length > 0) {
                 targetFormat = fmt.codec[0]
                 formatType = fmt.format_name === 'ts' ? 'mpegts' : fmt.format_name
                 protocol = stream.protocol_name === 'http_hls' ? 'hls' : 'http'
                 break 
              }
           }
        }

        if (targetFormat) {
          const urlInfo = targetFormat.url_info[0]
          return {
            url: `${urlInfo.host}${targetFormat.base_url}${urlInfo.extra}`,
            protocol: protocol,
            format: formatType,
            additionalData: {
              headers: { 
                ...HEADERS, 
                Cookie: this.cookie,
                Referer: `https://live.bilibili.com/${roomId}`
              }
            }
          }
        }

        throw new Error('No supported stream format found')
      }

      let aid = track.pluginInfo?.aid
      let cid = track.pluginInfo?.cid
      const bvid = track.pluginInfo?.bvid || track.identifier.split('?')[0]

      if (!cid) {
        const { body } = await makeRequest(
          `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
          {
            method: 'GET',
            headers: { ...HEADERS, Cookie: this.cookie }
          }
        )
        if (body.code !== 0) throw new Error('Failed to fetch video metadata for stream')
        
        aid = body.data.aid
        
        const pMatch = track.identifier.match(/\?p=(\d+)/)
        const pageIndex = pMatch ? parseInt(pMatch[1]) : 1
        const page = body.data.pages.find(p => p.page === pageIndex)
        cid = page ? page.cid : body.data.cid
      }

      const mixinKey = await this._getWbiKeys()
      const query = this._signWbi({
        bvid: bvid,
        cid: cid,
        qn: 120, 
        fnval: 16 
      }, mixinKey)

      const { body } = await makeRequest(
        `https://api.bilibili.com/x/player/wbi/playurl?${query}`,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.bilibili.com/',
            Cookie: this.cookie
          }
        }
      )

      if (body.code !== 0) throw new Error(`Playurl API Error: ${body.message}`)

      const durl = body.data.durl
      const dash = body.data.dash

      let url = null
      let type = 'mp4'

      if (dash) {
        const audio = dash.audio ? dash.audio[0] : null
        const video = dash.video ? dash.video[0] : null
        
        if (audio) {
          url = audio.base_url || audio.backup_url?.[0]
          type = 'm4a' 
        } else if (video) {
          url = video.base_url || video.backup_url?.[0]
          type = 'mp4'
        }
      } else if (durl && durl.length > 0) {
        url = durl[0].url
        type = 'mp4'
      }

      if (!url) throw new Error('No playable stream found')

      return {
        url: url,
        protocol: 'https',
        format: type,
        additionalData: {
          headers: {
            'Referer': 'https://www.bilibili.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Cookie: this.cookie
          }
        }
      }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      let type = decodedTrack.format
      
      if (!type) {
        if (url.includes('.m3u8')) type = 'mpegts'
        else if (url.includes('.flv')) type = 'flv'
        else type = 'mp4'
      }

      const response = await http1makeRequest(url, {
        method: 'GET',
        headers: additionalData?.headers || {},
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw response.error || new Error('Failed to get stream')
      }

      const stream = new PassThrough()
      
      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', (err) => stream.destroy(err))

      return { stream: stream, type: type }
    } catch (err) {
      return { exception: { message: err.message, severity: 'common' } }
    }
  }
}
