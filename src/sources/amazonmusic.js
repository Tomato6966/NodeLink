import { encodeTrack, logger, http1makeRequest, getBestMatch } from '../utils.js'

const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; NodeLinkBot/0.1; +https://nodelink.js.org/)'

function parseISO8601Duration(duration) {
  if (!duration) return 0
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const hours = Number.parseInt(match[1] || '0', 10)
  const minutes = Number.parseInt(match[2] || '0', 10)
  const seconds = Number.parseInt(match[3] || '0', 10)
  return (hours * 3600 + minutes * 60 + seconds) * 1000
}

export default class AmazonMusicSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/music\.amazon\.[a-z.]+\/(?:.*\/)?(track|album|playlist|artist)s?\/([a-z0-9]+)/i,
      /https?:\/\/(?:www\.)?amazon\.[a-z.]+\/dp\/([a-z0-9]+)/i,
    ]
    this.priority = 100
  }

  async setup() {
    return true
  }

  async resolve(url) {
    try {
      const match = url.match(this.patterns[0]) || url.match(this.patterns[1])
      if (!match) return { loadType: 'empty', data: {} }

      let [, type, id] = match
      if (!id) {
        id = type
        type = 'track'
      }

      const trackAsin = url.match(/(?:[?&]|%26)trackAsin=([a-z0-9]+)/i)?.[1]

      if (trackAsin) {
        return await this._resolveTrack(url, trackAsin)
      }

      switch (type) {
        case 'track':
          return await this._resolveTrack(url, id)
        case 'album':
          return await this._resolveAlbum(url, id)
        case 'playlist':
          return await this._resolvePlaylist(url, id)
        case 'artist':
          return await this._resolveArtist(url, id)
        case 'dp':
          return await this._resolveTrack(url, id)
        default:
          return { loadType: 'empty', data: {} }
      }
    } catch (e) {
      logger('error', 'AmazonMusic', `Resolution failed: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' },
      }
    }
  }

  async _resolveTrack(url, id) {
    const data = await this._fetchJsonLd(url, id)
    if (data?.loadType === 'track') return data

    return await this._fallbackToOdesli(url, id)
  }

  async _resolveAlbum(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data

    return await this._fallbackToOdesli(url, id)
  }

  async _resolvePlaylist(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data

    return await this._fallbackToOdesli(url, id)
  }

  async _resolveArtist(url, id) {
    const data = await this._fetchJsonLd(url)
    if (data?.loadType === 'playlist') return data

    return await this._fallbackToOdesli(url, id)
  }

  async _fetchJsonLd(url, targetId) {
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: { 'User-Agent': BOT_USER_AGENT },
      })
      if (statusCode !== 200) return null

      const headerArtist = body.match(/<music-detail-header[^>]*primary-text="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&')
      const headerImage = body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)?.[1]
      const ogImageMatch = body.match(/<meta property="og:image" content="([^"]+)"/)
      const artworkUrl = headerImage || (ogImageMatch ? ogImageMatch[1] : null)

      const jsonLdMatches = body.matchAll(/<script [^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)
      let collection = null
      let trackData = null

      for (const match of jsonLdMatches) {
        try {
          const content = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          const parsed = JSON.parse(content)
          const data = Array.isArray(parsed) ? parsed[0] : parsed
          if (data['@type'] === 'MusicAlbum' || data['@type'] === 'MusicGroup' || data['@type'] === 'Playlist') {
            collection = data
          } else if (data['@type'] === 'MusicRecording') {
            trackData = data
          }
        } catch (_e) {}
      }

      const tracks = []
      let collectionName = headerArtist || 'Unknown Artist'
      let collectionImage = artworkUrl

      if (collection) {
        const artistName = collection.byArtist?.name || (Array.isArray(collection.byArtist) ? collection.byArtist[0]?.name : null) || collection.author?.name
        if (artistName) collectionName = artistName
        if (collection.image) collectionImage = collection.image
      }

      if (collection && collection.track) {
        for (const t of collection.track) {
          const id = t.url?.split('/').pop() || t['@id']?.split('/').pop() || `am-${Buffer.from(t.name).toString('hex')}`
          tracks.push({
            identifier: id,
            isSeekable: true,
            author: t.byArtist?.name || t.author?.name || collectionName,
            length: parseISO8601Duration(t.duration),
            isStream: false,
            position: 0,
            title: t.name,
            uri: t.url || url,
            artworkUrl: collectionImage,
            isrc: t.isrcCode || null,
            sourceName: 'amazonmusic',
          })
        }
      }

      if (tracks.length === 0) {
        const rowMatches = body.matchAll(/<(music-image-row|music-text-row)[^>]*primary-text="([^"]+)"[^>]*primary-href="([^"]+)"(?:[^>]*secondary-text-1="([^"]+)")?[^>]*duration="([^"]+)"(?:[^>]*image-src="([^"]+)")?/g)
        for (const m of rowMatches) {
          const tTitle = m[2].replace(/&amp;/g, '&')
          const tHref = m[3]
          const tArtist = (m[4] || collectionName).replace(/&amp;/g, '&')
          const tDuration = m[5]
          const tImage = m[6] || collectionImage
          const tId = tHref.split('trackAsin=').pop().split('&')[0] || tHref.split('/').pop()

          tracks.push({
            identifier: tId,
            isSeekable: true,
            author: tArtist,
            length: tDuration.includes(':') ? (parseInt(tDuration.split(':')[0]) * 60 + parseInt(tDuration.split(':')[1])) * 1000 : 0,
            isStream: false,
            position: 0,
            title: tTitle,
            uri: `https://music.amazon.com.br/tracks/${tId}`,
            artworkUrl: tImage,
            isrc: null,
            sourceName: 'amazonmusic',
          })
        }
        
        if (tracks.length === 0 && !headerArtist) {
          const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/)
          if (titleMatch) collectionName = titleMatch[1].split(' no Amazon')[0].split(' de ').pop()?.split(' no ')[0] || collectionName
        }
      }

      if (tracks.length > 0) {
        if (targetId) {
          const selected = tracks.find(t => t.identifier === targetId || t.uri.includes(targetId))
          if (selected) {
            return {
              loadType: 'track',
              data: { encoded: encodeTrack(selected), info: selected }
            }
          }
        }

        if (url.includes('/tracks/') && !targetId) {
           return {
             loadType: 'track',
             data: { encoded: encodeTrack(tracks[0]), info: tracks[0] }
           }
        }

        return {
          loadType: 'playlist',
          data: {
            info: { name: collectionName, selectedTrack: 0 },
            tracks: tracks.map(t => ({ encoded: encodeTrack(t), info: t }))
          }
        }
      }

      if (trackData) {
        const artist = trackData.byArtist?.name || trackData.author?.name || 'Unknown Artist'
        let trackImage = trackData.image || artworkUrl
        if (!trackImage) {
          const headerImageMatch = body.match(/<music-detail-header[^>]*image-src="([^"]+)"/)
          if (headerImageMatch) trackImage = headerImageMatch[1]
        }
        return this._buildTrackResult(trackData.name, artist, url, trackImage, trackData.id || trackData.isrcCode || url.split('/').pop(), parseISO8601Duration(trackData.duration), trackData.isrcCode)
      }
    } catch (_e) {}
    return null
  }

  async _fallbackToOdesli(url, targetId) {
    try {
      const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(url.split('?')[0])}`
      const { body, statusCode } = await http1makeRequest(apiUrl)
      if (statusCode === 200 && body.entitiesByUniqueId) {
        let entity = body.entitiesByUniqueId[body.entityUniqueId]
        if (targetId && (!entity || !entity.id.includes(targetId))) {
          const found = Object.values(body.entitiesByUniqueId).find((e) =>
            e.id.includes(targetId),
          )
          if (found) entity = found
        }
        if (entity)
          return this._buildTrackResult(
            entity.title,
            entity.artistName,
            url,
            entity.thumbnailUrl,
            entity.id,
            0,
            entity.isrc
          )
      }
    } catch (_e) {}
    return { loadType: 'empty', data: {} }
  }

  _buildTrackResult(title, author, url, image, id, length = 0, isrc = null) {
    const trackInfo = {
      identifier: id,
      isSeekable: true,
      author: author?.trim() || 'Unknown Artist',
      length: length,
      isStream: false,
      position: 0,
      title: title?.trim() || 'Unknown Track',
      uri: url,
      artworkUrl: image || null,
      isrc: isrc,
      sourceName: 'amazonmusic',
    }
    return {
      loadType: 'track',
      data: { encoded: encodeTrack(trackInfo), info: trackInfo },
    }
  }

  async getTrackUrl(decodedTrack) {
    const query = `${decodedTrack.title} ${decodedTrack.author} official audio`

    try {
      let searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch')
      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        searchResult = await this.nodelink.sources.searchWithDefault(query)
      }

      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        throw new Error('No alternative stream found via default search.')
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)
      if (!bestMatch)
        throw new Error('No suitable alternative stream found after filtering.')

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      logger(
        'warn',
        'AmazonMusic',
        `Mirror search for "${query}" failed: ${e.message}`,
      )
      throw e
    }
  }

  async loadStream() {
    return null
  }
}
