import { encodeTrack, http1makeRequest, logger } from '../utils.ts'

const RSS_PATTERN = /https?:\/\/.+(\.rss|\.rrs)(\?.*)?$/i
const PODCAST_RSS_PATTERN = /https?:\/\/.+\/podcast\/rss(\?.*)?$/i

export default class RssSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [RSS_PATTERN, PODCAST_RSS_PATTERN]
    this.priority = 50
  }

  async setup() {
    return true
  }

  async resolve(url) {
    try {
      const { body, statusCode, headers } = await http1makeRequest(url)
      if (statusCode !== 200 || typeof body !== 'string') {
        return { loadType: 'empty', data: {} }
      }

      const contentType = (headers?.['content-type'] || '').toLowerCase()
      if (!contentType.includes('xml') && !body.includes('<rss')) {
        return { loadType: 'empty', data: {} }
      }

      const channelXml = this._extractFirstTag(body, 'channel') || ''
      const channelTitle =
        this._extractTagText(channelXml, 'title') || 'RSS Feed'
      const channelImage =
        this._extractTagAttr(channelXml, 'itunes:image', 'href') ||
        this._extractTagText(
          this._extractFirstTag(channelXml, 'image') || '',
          'url'
        ) ||
        null

      const items = this._extractItems(body)
      if (items.length === 0) {
        return { loadType: 'empty', data: {} }
      }

      const tracks = []
      for (const itemXml of items) {
        const title = this._extractTagText(itemXml, 'title') || 'Untitled'
        const author =
          this._extractTagText(itemXml, 'itunes:author') ||
          this._extractTagText(itemXml, 'dc:creator') ||
          this._extractTagText(channelXml, 'itunes:author') ||
          this._extractTagText(channelXml, 'author') ||
          'Unknown Artist'
        const enclosureTag = this._extractEnclosureTag(itemXml)
        const enclosureUrl = this._extractAttribute(enclosureTag, 'url')
        const enclosureType = this._extractAttribute(enclosureTag, 'type')
        const link = this._extractTagText(itemXml, 'link') || enclosureUrl || url
        const guid = this._extractTagText(itemXml, 'guid') || link
        const durationText = this._extractTagText(itemXml, 'itunes:duration')
        const artwork =
          this._extractTagAttr(itemXml, 'itunes:image', 'href') ||
          channelImage ||
          null

        if (!enclosureUrl) continue

        const trackInfo = {
          identifier: guid,
          isSeekable: true,
          author: author?.trim() || 'Unknown Artist',
          length: this._parseDurationMs(durationText),
          isStream: false,
          position: 0,
          title: title?.trim() || 'Untitled',
          uri: enclosureUrl,
          artworkUrl: artwork,
          isrc: null,
          sourceName: 'rss'
        }

        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {
            enclosureType,
            itemUrl: link,
            feedUrl: url
          }
        })
      }

      if (tracks.length === 0) return { loadType: 'empty', data: {} }

      return {
        loadType: 'playlist',
        data: {
          info: { name: channelTitle, selectedTrack: 0 },
          pluginInfo: { feedUrl: url },
          tracks
        }
      }
    } catch (e) {
      logger('error', 'RSS', `Resolve failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(track) {
    const url = track?.uri
    if (!url) {
      return {
        exception: { message: 'Missing enclosure URL.', severity: 'common' }
      }
    }

    const format = this._guessFormatFromUrl(url)
    return {
      url,
      protocol: url.startsWith('https://') ? 'https' : 'http',
      format
    }
  }

  _extractItems(xml) {
    const items = []
    const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
    let match
    while ((match = re.exec(xml)) !== null) {
      items.push(match[1])
    }
    return items
  }

  _extractFirstTag(xml, tag) {
    const tagRe = this._buildTagRegex(tag)
    const match = tagRe.exec(xml)
    return match ? match[1] : null
  }

  _extractTagText(xml, tag) {
    const content = this._extractFirstTag(xml, tag)
    if (!content) return null
    const cdataMatch = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i)
    if (cdataMatch) return cdataMatch[1].trim()
    return content.replace(/<[^>]+>/g, '').trim()
  }

  _extractTagAttr(xml, tag, attr) {
    const tagRe = new RegExp(
      `<${this._escape(tag)}\\b[^>]*>`,
      'i'
    )
    const match = tagRe.exec(xml)
    if (!match) return null
    return this._extractAttribute(match[0], attr)
  }

  _extractAttribute(tag, attr) {
    if (!tag) return null
    const attrRe = new RegExp(`${this._escape(attr)}=(["'])([^"']+)\\1`, 'i')
    const match = attrRe.exec(tag)
    return match ? match[2] : null
  }

  _buildTagRegex(tag) {
    return new RegExp(
      `<${this._escape(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${this._escape(tag)}>`,
      'i'
    )
  }

  _extractEnclosureTag(xml) {
    const match = xml.match(/<enclosure\b[^>]*\/?>/i)
    return match ? match[0] : ''
  }

  _escape(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  _parseDurationMs(text) {
    if (!text) return 0
    const trimmed = String(text).trim()
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10) * 1000
    }

    const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10))
    if (parts.some((p) => Number.isNaN(p))) return 0
    if (parts.length === 3) {
      return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000
    }
    if (parts.length === 2) {
      return (parts[0] * 60 + parts[1]) * 1000
    }
    return 0
  }

  _guessFormatFromUrl(url) {
    const lower = url.toLowerCase().split('?')[0]
    if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'm4a'
    if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'ogg'
    if (lower.endsWith('.wav')) return 'wav'
    if (lower.endsWith('.m3u8')) return 'm3u8'
    if (lower.endsWith('.mp3')) return 'mp3'
    return 'mp3'
  }
}
