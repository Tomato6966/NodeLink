import crypto from 'node:crypto'
import { logger, makeRequest } from '../utils.js'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
]

export default class BilibiliLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.wbiKeys = null
    this.wbiKeysExpiry = 0
  }

  async setup() {
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
      method: 'GET'
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

  async getLyrics(track) {
    if (track.info.sourceName !== 'bilibili') return { loadType: 'empty', data: {} }

    try {
      let bvid = track.info.identifier
      let aid = track.pluginInfo?.aid
      let cid = track.pluginInfo?.cid

      if (!aid || !cid) {
         if (bvid.includes('?p=')) bvid = bvid.split('?p=')[0]
         const { body } = await makeRequest(
          `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
          { method: 'GET' }
        )
        if (body.code === 0) {
          aid = body.data.aid
          cid = body.data.cid
        }
      }

      if (!aid || !cid) return { loadType: 'empty', data: {} }

      const mixinKey = await this._getWbiKeys()
      const query = this._signWbi({
        bvid: bvid,
        cid: cid
      }, mixinKey)

      const { body } = await makeRequest(
        `https://api.bilibili.com/x/player/wbi/v2?${query}`,
        { method: 'GET' }
      )

      if (body.code !== 0 || !body.data.subtitle?.subtitles) {
        return { loadType: 'empty', data: {} }
      }

      const subtitles = body.data.subtitle.subtitles
      if (subtitles.length === 0) return { loadType: 'empty', data: {} }

      const subUrl = subtitles[0].subtitle_url
      if (!subUrl) return { loadType: 'empty', data: {} }

      const { body: subData } = await makeRequest(subUrl.startsWith('//') ? `https:${subUrl}` : subUrl, { method: 'GET' })
      
      if (!subData?.body) return { loadType: 'empty', data: {} }

      const lines = subData.body.map(line => ({
        time: Math.floor(line.from * 1000),
        duration: Math.floor((line.to - line.from) * 1000),
        text: line.content
      }))

      return {
        loadType: 'lyrics',
        data: {
          name: 'Bilibili CC',
          synced: true,
          lines: lines
        }
      }

    } catch (e) {
      logger('error', 'Lyrics', `Bilibili lyrics failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }
}
