export default class PlaylistParser {
  static parse(content, baseUrl) {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
    
    // 4.3.4: Detect Master Playlist
    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
      return { isMaster: true, variants: this.parseMaster(lines, baseUrl) }
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

    const mediaSequenceLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))
    if (mediaSequenceLine) {
      mediaSequence = parseInt(mediaSequenceLine.split(':')[1], 10)
      result.mediaSequence = mediaSequence
    }

    const targetDurationLine = lines.find((l) => l.startsWith('#EXT-X-TARGETDURATION:'))
    if (targetDurationLine) {
      result.targetDuration = parseInt(targetDurationLine.split(':')[1], 10)
    }

    let segmentIndex = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith('#EXT-X-KEY:')) {
        currentKey = this.parseKey(line, baseUrl)
      } else if (line.startsWith('#EXT-X-MAP:')) {
        currentMap = this.parseMap(line, baseUrl)
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        lastByteRange = this.parseByteRange(line, lastByteRange)
      } else if (line.startsWith('#EXTINF:')) {
        const segmentUrl = lines[++i]
        if (segmentUrl && !segmentUrl.startsWith('#')) {
          const absoluteUrl = new URL(segmentUrl, baseUrl).toString()
          const sequence = mediaSequence + segmentIndex
          
          result.segments.push({
            url: absoluteUrl,
            key: currentKey,
            map: currentMap,
            byteRange: lastByteRange,
            sequence
          })
          segmentIndex++
          lastByteRange = null 
        }
      }
    }

    return result
  }

  static parseMaster(lines, baseUrl) {
    const variants = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const attrLine = lines[i]
        const url = new URL(lines[++i], baseUrl).toString()
        const bandwidthMatch = attrLine.match(/BANDWIDTH=(\d+)/)
        const codecsMatch = attrLine.match(/CODECS="([^"]+)"/)
        
        variants.push({
          url,
          bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0,
          codecs: codecsMatch ? codecsMatch[1] : ''
        })
      }
    }

    return variants.sort((a, b) => b.bandwidth - a.bandwidth)
  }

  static parseKey(line, baseUrl) {
    const methodMatch = line.match(/METHOD=([^,]+)/)
    const method = methodMatch ? methodMatch[1] : 'NONE'
    if (method === 'NONE') return null

    const uriMatch = line.match(/URI="([^"]+)"/) 
    const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/)
    if (!uriMatch) return null

    return {
      method,
      uri: new URL(uriMatch[1], baseUrl).toString(),
      iv: ivMatch ? Buffer.from(ivMatch[1], 'hex') : null
    }
  }

  static parseMap(line, baseUrl) {
    const uriMatch = line.match(/URI="([^"]+)"/) 
    const rangeMatch = line.match(/BYTERANGE="([^"]+)"/) 
    if (!uriMatch) return null

    return {
      uri: new URL(uriMatch[1], baseUrl).toString(),
      byteRange: rangeMatch ? this.parseByteRange(`#EXT-X-BYTERANGE:${rangeMatch[1]}`, null) : null
    }
  }

  static parseByteRange(line, lastRange) {
    const match = line.match(/:(\d+)(?:@(\d+))?/) 
    if (!match) return null

    const length = parseInt(match[1], 10)
    let offset = match[2] ? parseInt(match[2], 10) : null

    if (offset === null && lastRange) {
      offset = lastRange.offset + lastRange.length
    }

    return { length, offset: offset || 0 }
  }
}