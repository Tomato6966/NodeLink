import crypto from 'node:crypto'
import { logger, makeRequest } from '../utils.js'

function getGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export default class MusixmatchLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.guid = getGuid()
  }

  async setup() {
    return true
  }

  signUrl(url) {
    const secret = this.nodelink.options.lyrics?.musixmatch?.signatureSecret
    if (!secret)
      throw new Error('Musixmatch signatureSecret is not configured.')

    const dt = new Date()
    const timestamp = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(
      dt.getUTCDate()
    ).padStart(2, '0')}`
    const signature = crypto
      .createHmac('sha1', secret)
      .update(url + timestamp)
      .digest('base64')

    return `${url}&signature=${encodeURIComponent(signature)}&signature_protocol=sha1`
  }

  async getLyrics(trackInfo) {
    try {
      const searchQuery = `${trackInfo.title} ${trackInfo.author}`
      const searchUrl = this.signUrl(
        `https://apic-desktop.musixmatch.com/ws/1.1/macro.search?app_id=web-desktop-app-v1.0&part=track_artist&q_track_artist=${encodeURIComponent(
          searchQuery
        )}&page_size=5&page=1&guid=${this.guid}`
      )

      const { body: searchResult } = await makeRequest(searchUrl)

      const track =
        searchResult.message.body.macro_result_list.track_list[0]?.track
      if (!track) return { loadType: 'empty', data: {} }

      const lyricsUrl = this.signUrl(
        `https://apic-desktop.musixmatch.com/ws/1.1/track.lyrics.get?track_id=${track.track_id}&guid=${this.guid}`
      )
      const { body: lyricsResult } = await makeRequest(lyricsUrl)

      const lyricsBody = lyricsResult.message.body.lyrics?.lyrics_body
      if (!lyricsBody) return { loadType: 'empty', data: {} }

      const lines = lyricsBody
        .split('\n')
        .map((line) => ({ text: line, time: 0, duration: 0 }))

      return {
        loadType: 'lyrics',
        data: {
          name: 'original',
          synced: false,
          lines
        }
      }
    } catch (e) {
      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics from Musixmatch: ${e.message}`
      )
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
