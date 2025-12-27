import { encodeTrack, logger, http1makeRequest } from '../utils.js'

const DURATION_TOLERANCE = 0.15

export default class GeniusSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.patterns = [
      /https?:\/\/(?:www\.)?genius\.com\/(?:videos|a\/)?([\w-]+)/
    ]
    this.searchTerms = [] 
    this.priority = 100
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Genius source (Video/Audio/Article).')
    return true
  }

  async search(query) {
    return { loadType: 'empty', data: {} }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return null

    try {
      const { body, statusCode } = await http1makeRequest(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        disableBodyCompression: true
      })

      if (statusCode !== 200) {
        throw new Error(`Genius returned status ${statusCode}`)
      }

      let songInfo = null

      const scriptRegex = /<script[^>]*>\s*window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\((.+?)\);\s*<\/script>/s
      const scriptMatch = body.match(scriptRegex)
      
      if (scriptMatch) {
        try {
          const jsonParseArg = scriptMatch[1]
          const parseFunction = new Function('return JSON.parse(' + jsonParseArg + ')')
          songInfo = parseFunction()
        } catch (e) {
          logger('debug', 'Genius', `JavaScript execution failed: ${e.message}`)
        }
      }

      if (!songInfo) {
        throw new Error('Could not extract Genius metadata')
      }

      const songPage = songInfo.songPage || {}
      const songId = songPage.song
      
      if (!songId) {
        throw new Error('Song ID not found in extracted data')
      }

      const trackingData = songPage.trackingData || []
      const title = trackingData.find(x => x.key === 'Title')?.value || 'Unknown Title'
      const artist = trackingData.find(x => x.key === 'Primary Artist')?.value || 'Unknown Artist'
      
      const entities = songInfo.entities || {}
      const songs = entities.songs || {}
      let songData = songs[songId]
      
      if (!songData) {
        const firstKey = Object.keys(songs)[0]
        if (firstKey) {
          songData = songs[firstKey]
        } else {
          throw new Error('Song data not found in entities')
        }
      }

      const media = songData?.media || []
      const tracks = []

      for (const m of media) {
        if ((m.type === 'video' || m.type === 'audio') && m.url) {
          let trackInfo = {
            identifier: m.url, 
            isSeekable: true,
            author: artist,
            length: 0, 
            isStream: false,
            position: 0,
            title: `${title} (${m.provider})`,
            uri: m.url,
            artworkUrl: songData.headerImageUrl || songData.songArtImageUrl,
            isrc: null,
            sourceName: 'genius'
          }

          try {
             const result = await this.nodelink.sources.resolve(m.url)
             if (result.loadType === 'track') {
                const info = result.data.info
                trackInfo.title = info.title
                trackInfo.author = info.author
                trackInfo.length = info.length
                trackInfo.isStream = info.isStream
                trackInfo.isSeekable = info.isSeekable
                trackInfo.artworkUrl = info.artworkUrl || trackInfo.artworkUrl
                trackInfo.isrc = info.isrc
             } else if (result.loadType === 'playlist' && result.data.tracks.length > 0) {
                const info = result.data.tracks[0].info
                trackInfo.title = info.title
                trackInfo.length = info.length
                trackInfo.artworkUrl = info.artworkUrl || trackInfo.artworkUrl
             }
          } catch (e) {
              logger('debug', 'Genius', `Failed to resolve media URL ${m.url}: ${e.message}; using basic info.`)
          }

          tracks.push({
            encoded: encodeTrack(trackInfo),
            info: trackInfo,
            pluginInfo: { provider: m.provider }
          })
        }
      }

      if (tracks.length === 0) {
        const trackInfo = {
          identifier: `genius:${songId}`,
          isSeekable: true,
          author: artist,
          length: 0,
          isStream: false,
          position: 0,
          title: title,
          uri: url,
          artworkUrl: songData?.headerImageUrl || songData?.songArtImageUrl,
          isrc: null,
          sourceName: 'genius'
        }
        tracks.push({
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        })
      }

      return {
        loadType: 'playlist',
        data: {
          info: { name: `${title} - ${artist} (Genius)`, selectedTrack: 0 },
          tracks
        }
      }

    } catch (e) {
      logger('error', 'Genius', `Error resolving URL: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(decodedTrack) {
    if (decodedTrack.uri && (decodedTrack.uri.startsWith('http'))) {
      try {
        const result = await this.nodelink.sources.resolve(decodedTrack.uri)
        
        if (result && (result.loadType === 'track' || (result.loadType === 'playlist' && result.data.tracks.length > 0))) {
          const targetTrack = result.loadType === 'track' ? result.data : result.data.tracks[0]
          const streamInfo = await this.nodelink.sources.getTrackUrl(targetTrack.info)
          return { newTrack: targetTrack, ...streamInfo }
        }
      } catch (e) {
        logger('debug', 'Genius', `Direct resolve failed for ${decodedTrack.uri}: ${e.message}`)
      }
    }

    const query = `${decodedTrack.title} ${decodedTrack.author}`
    try {
      const searchResult = await this.nodelink.sources.searchWithDefault(query)

      if (searchResult.loadType !== 'search' || searchResult.data.length === 0) {
        return {
          exception: {
            message: 'No alternative stream found via default search.',
            severity: 'fault'
          }
        }
      }

      const bestMatch = await this._findBestMatch(searchResult.data, 0, decodedTrack)

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative stream found after filtering.',
            severity: 'fault'
          }
        }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)
      return { newTrack: bestMatch, ...streamInfo }
    } catch (e) {
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }

  async _findBestMatch(list, target, original) {
    const normalizedOriginalTitle = this._normalize(original.title)
    const normalizedOriginalAuthor = this._normalize(original.author)

    const scoredCandidates = list.map((item) => {
      const normalizedItemTitle = this._normalize(item.info.title)
      const normalizedItemAuthor = this._normalize(item.info.author)
      let score = 0

      if (normalizedItemTitle.includes(normalizedOriginalTitle) || normalizedOriginalTitle.includes(normalizedItemTitle)) {
        score += 100
      }

      if (normalizedItemAuthor.includes(normalizedOriginalAuthor) || normalizedOriginalAuthor.includes(normalizedItemAuthor)) {
        score += 100
      }
      
      return { item, score }
    }).filter((c) => c.score >= 0)

    if (scoredCandidates.length === 0) {
      return null
    }

    scoredCandidates.sort((a, b) => b.score - a.score)
    return scoredCandidates[0].item
  }

  _normalize(str) {
    if (!str) return ''
    return str
      .toLowerCase()
      .replace(/feat\.?/g, '')
      .replace(/ft\.?/g, '')
      .replace(/(\s*\(.*\)\s*)/g, '') 
      .replace(/[^\w\s]/g, '')
      .trim()
  }
}