import { logger } from '../../utils.js'

export default class PlaylistParser {
  static parse(content, baseUrl) {
    if (!content.includes('#EXT')) {
      throw new Error('Invalid HLS playlist format')
    }

    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      const { variants, audioGroups } = this.parseMaster(lines, baseUrl)
      return { isMaster: true, variants, audioGroups }
    }

    const result = {
      isMaster: false,
      mediaSequence: 0,
      targetDuration: 5,
      isLive: !content.includes('#EXT-X-ENDLIST'),
      segments: []
    }

    let currentKey = null
    let currentMap = null
    let mediaSequence = 0
    let lastByteRange = null

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.split(':')[1], 10)
        result.mediaSequence = mediaSequence
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        result.targetDuration = parseFloat(line.split(':')[1])
      }
    }

    let segmentIndex = 0
    let pendingDiscontinuity = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        pendingDiscontinuity = true
      } else if (line.startsWith('#EXT-X-KEY:')) {
        currentKey = this.parseAttributes(line, baseUrl)
      } else if (line.startsWith('#EXT-X-MAP:')) {
        currentMap = this.parseAttributes(line, baseUrl)
      } else if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split(':')[1].split(',')[0])
        let j = i + 1
        while (j < lines.length && lines[j].startsWith('#')) {
          if (lines[j].startsWith('#EXT-X-BYTERANGE:')) {
            lastByteRange = this.parseByteRange(lines[j], lastByteRange)
          }
          j++
        }

        if (j < lines.length) {
          const segmentUrl = lines[j]
          result.segments.push({
            url: new URL(segmentUrl, baseUrl).toString(),
            duration,
            key: currentKey,
            map: currentMap,
            byteRange: lastByteRange,
            sequence: mediaSequence + segmentIndex,
            discontinuity: pendingDiscontinuity
          })
          segmentIndex++
          lastByteRange = null
          pendingDiscontinuity = false
          i = j
        }
      }
    }

    return result
  }

  static parseMaster(lines, baseUrl) {
    const variants = []
    const audioGroups = {}

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-MEDIA:')) {
            const attrs = this.parseAttributes(lines[i], baseUrl)
            if (attrs.type === 'AUDIO' && attrs.groupid) {
                if (!audioGroups[attrs.groupid]) audioGroups[attrs.groupid] = []
                audioGroups[attrs.groupid].push(attrs)
            }
        } else if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const attrLine = lines[i]
        const urlLine = lines[++i]
        if (!urlLine) break

        const attrs = this.parseAttributes(attrLine, baseUrl)
        variants.push({
          url: new URL(urlLine, baseUrl).toString(),
          bandwidth: parseInt(attrs.bandwidth || 0, 10),
          codecs: attrs.codecs || '',
          audio: attrs.audio
        })
      }
    }
    return { variants: variants.sort((a, b) => b.bandwidth - a.bandwidth), audioGroups }
  }

  static parseAttributes(line, baseUrl) {
    const attrs = {}
    const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g
    let match
    while ((match = regex.exec(line)) !== null) {
      const key = match[1].toLowerCase().replace(/-/g, '')
      const value = match[2] || match[3]
      attrs[key] = value
    }

    if (attrs.uri) attrs.uri = new URL(attrs.uri, baseUrl).toString()
    if (attrs.iv && typeof attrs.iv === 'string' && attrs.iv.startsWith('0x')) {
      attrs.iv = Buffer.from(attrs.iv.substring(2), 'hex')
    }
    return attrs
  }

  static parseByteRange(line, lastRange) {
    const match = line.match(/:?(\d+)(?:@(\d+))?/)
    if (!match) return null
    const length = parseInt(match[1], 10)
    let offset = match[2] ? parseInt(match[2], 10) : null
    if (offset === null && lastRange) offset = lastRange.offset + lastRange.length
    return { length, offset: offset || 0 }
  }
}
