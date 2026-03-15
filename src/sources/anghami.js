import { encodeTrack, getBestMatch, logger, makeRequest } from '../utils.ts'

export default class AnghamiSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['agsearch']
    this.patterns = [
      /^https?:\/\/(?:play\.|www\.)?anghami\.com\/(?:song|album|playlist|artist)\/(\d+)/
    ]
    this.udid = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('')

    this.cookieHeader = ''

    if (this.config.sources.anghami && this.config.sources.anghami.cookies) {
      this.cookieHeader = this.config.sources.anghami.cookies
      this.parseFingerprintFromCookies()
    }
  }

  parseFingerprintFromCookies() {
    if (!this.cookieHeader) return

    const cookies = this.cookieHeader.split(';')
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=')
      if (parts.length >= 2) {
        const name = parts[0]
        const value = parts.slice(1).join('=')

        if (name === 'fingerprint' && value) {
          try {
            const decoded = Buffer.from(value, 'base64').toString('utf-8')
            const json = JSON.parse(decoded)
            if (json.fp) {
              this.udid = json.fp
              logger(
                'info',
                'Anghami',
                `Extracted UDID from config cookies: ${this.udid}`
              )
            }
          } catch (err) {
            logger(
              'warn',
              'Anghami',
              `Failed to decode fingerprint cookie: ${err.message}`
            )
          }
          break
        }
      }
    }
  }

  async setup() {
    return true
  }

  async search(query, _sourceTerm) {
    logger('debug', 'Sources', `Searching Anghami for: "${query}"`)

    const searchUrl = `https://api.anghami.com/gateway.php?type=GETtabsearch&query=${encodeURIComponent(query)}&web2=true&language=en&output=json`
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'X-ANGH-UDID': this.udid,
      'X-ANGH-TS': Math.floor(Date.now() / 1000).toString(),
      Referer: 'https://play.anghami.com/',
      Origin: 'https://play.anghami.com'
    }

    if (this.cookieHeader) {
      headers['Cookie'] = this.cookieHeader
    }

    const { body, error } = await makeRequest(searchUrl, {
      method: 'GET',
      headers
    })

    if (error || !body || !body.sections) {
      return {
        exception: {
          message: error?.message || 'Failed to fetch search results',
          severity: 'common'
        }
      }
    }

    const songsSection = body.sections.find(
      (s) => s.type === 'genericitem' && s.group === 'songs'
    )

    if (!songsSection || !songsSection.data || songsSection.data.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks = songsSection.data.map((item) => this.buildTrack(item))

    return { loadType: 'search', data: tracks }
  }

  async resolve(url) {
    const match = url.match(this.patterns[0])
    if (!match) return { loadType: 'empty', data: {} }

    const [, id] = match
    const type = url.includes('/song/')
      ? 'song'
      : url.includes('/album/')
        ? 'album'
        : url.includes('/playlist/')
          ? 'playlist'
          : url.includes('/artist/')
            ? 'artist'
            : null

    if (!type) return { loadType: 'empty', data: {} }

    logger(
      'debug',
      'Sources',
      `Resolving Anghami URL: ${url} (Type: ${type}, ID: ${id})`
    )

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'X-ANGH-UDID': this.udid,
      'X-ANGH-TS': Math.floor(Date.now() / 1000).toString(),
      Referer: 'https://play.anghami.com/',
      Origin: 'https://play.anghami.com'
    }

    if (this.cookieHeader) {
      headers['Cookie'] = this.cookieHeader
    }

    if (type === 'song') {
      const songDataUrl = `https://api.anghami.com/gateway.php?type=GETsongdata&songId=${id}&output=jsonhp`
      const { body, error } = await makeRequest(songDataUrl, {
        method: 'GET',
        headers
      })

      if (error || !body || body.status !== 'ok') {
        const searchUrl = `https://api.anghami.com/gateway.php?type=GETtabsearch&query=${id}&web2=true&language=en&output=json`
        const { body: searchBody } = await makeRequest(searchUrl, {
          method: 'GET',
          headers
        })

        if (searchBody && searchBody.sections) {
          for (const sec of searchBody.sections) {
            if (sec.data) {
              const match = sec.data.find((s) => s.id === id)
              if (match)
                return { loadType: 'track', data: this.buildTrack(match) }
            }
          }
        }

        return {
          exception: {
            message: error?.message || 'Failed to resolve song',
            severity: 'common'
          }
        }
      }

      const track = this.buildTrack(body)
      return { loadType: 'track', data: track }
    } else if (type === 'album' || type === 'playlist') {
      const apiType = type === 'album' ? 'GETalbumdata' : 'GETplaylistdata'

      const fetchData = async (useBuffered) => {
        const requestUrl = `https://api.anghami.com/gateway.php?type=${apiType}&${type}Id=${id}&web2=true&language=en&output=json${useBuffered ? '&buffered=1' : ''}`
        const { body, error } = await makeRequest(requestUrl, {
          method: 'GET',
          headers
        })
        if (error || !body || body.error) return null

        let tracks = []
        const meta = body.playlist || body.album || {}
        const attributes = meta._attributes || body._attributes || {}
        const name =
          body.title ||
          body.name ||
          meta.title ||
          meta.name ||
          attributes.title ||
          attributes.name ||
          'Unknown Playlist'

        if (body.songbuffers) {
          try {
            const songMap = new Map()
            body.songbuffers.forEach((bufferBase64) => {
              const buffer = Buffer.from(bufferBase64, 'base64')
              const decoded = SongBatchResponse.decode(buffer)
              if (decoded.response) {
                Object.keys(decoded.response).forEach((key) => {
                  songMap.set(key, decoded.response[key])
                })
              }
            })

            const orderStr = body.songorder || attributes.songorder
            if (orderStr) {
              const order = orderStr.split(',')
              order.forEach((songId) => {
                const song = songMap.get(songId.trim())
                if (song) tracks.push(this.buildTrack(song))
              })
              if (tracks.length === 0) {
                order.reverse().forEach((songId) => {
                  const song = songMap.get(songId.trim())
                  if (song) tracks.push(this.buildTrack(song))
                })
              }
            } else {
              songMap.forEach((song) => tracks.push(this.buildTrack(song)))
            }
          } catch (e) {
            logger(
              'error',
              'Anghami',
              `Failed to decode playlist buffer: ${e.message}`
            )
          }
        }

        if (tracks.length === 0 && body.sections) {
          const songsSec = body.sections.find(
            (s) =>
              s.type === 'song' ||
              s.group === 'songs' ||
              s.group === 'album_songs'
          )
          if (songsSec && songsSec.data) {
            tracks = songsSec.data.map((item) => this.buildTrack(item))
          }
        }

        const songsMapData =
          (body.playlist && body.playlist.songs) ||
          body.songs ||
          (body.album && body.album.songs)
        if (tracks.length === 0 && songsMapData) {
          const songsMap = new Map()
          Object.keys(songsMapData).forEach((key) => {
            const s = songsMapData[key]
            if (typeof s !== 'object') return
            const songObj = s._attributes || s
            if (songObj && songObj.id) {
              songsMap.set(songObj.id.toString(), songObj)
            }
          })

          const orderStr =
            meta.songorder || attributes.songorder || body.songorder
          if (orderStr) {
            const order = orderStr.split(',')
            order.forEach((songId) => {
              const song = songsMap.get(songId.toString().trim())
              if (song) tracks.push(this.buildTrack(song))
            })
          }
          if (tracks.length === 0) {
            songsMap.forEach((song) => tracks.push(this.buildTrack(song)))
          }
        }

        if (tracks.length === 0 && Array.isArray(body.data)) {
          tracks = body.data.map((item) => this.buildTrack(item))
        }

        if (tracks.length === 0) return null

        return {
          loadType: 'playlist',
          data: {
            info: { name, selectedTrack: 0 },
            pluginInfo: {},
            tracks
          }
        }
      }

      let result = await fetchData(false)
      if (!result) result = await fetchData(true)

      if (!result) return { loadType: 'empty', data: {} }
      return result
    } else if (type === 'artist') {
      const artistUrl = `https://api.anghami.com/gateway.php?type=GETartistprofile&artistId=${id}&web2=true&language=en&output=json`
      const { body, error } = await makeRequest(artistUrl, {
        method: 'GET',
        headers
      })

      if (error || !body) return { loadType: 'empty', data: {} }

      let tracksData = []
      if (body.sections) {
        const songsSec = body.sections.find(
          (s) => s.group === 'songs' || s.type === 'song'
        )
        if (songsSec) tracksData = songsSec.data
      } else if (Array.isArray(body.data)) {
        tracksData = body.data
      }

      const tracks = tracksData.map((item) => this.buildTrack(item))
      return {
        loadType: 'playlist',
        data: {
          info: {
            name: body.name || body.title || 'Artist Top Tracks',
            selectedTrack: 0
          },
          pluginInfo: {},
          tracks
        }
      }
    }

    return { loadType: 'empty', data: {} }
  }

  async getTrackUrl(decodedTrack) {
    const searchQuery = `${decodedTrack.title} - ${decodedTrack.author}`

    try {
      let searchResult

      searchResult = await this.nodelink.sources.searchWithDefault(searchQuery)

      if (
        !searchResult ||
        searchResult.loadType !== 'search' ||
        searchResult.data.length === 0
      ) {
        return {
          exception: {
            message: 'No suitable alternative found via default search.',
            severity: 'common'
          }
        }
      }

      const bestMatch = getBestMatch(searchResult.data, decodedTrack)

      if (!bestMatch) {
        return {
          exception: {
            message: 'No suitable alternative found after filtering.',
            severity: 'common'
          }
        }
      }

      const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info)

      return {
        ...streamInfo,
        newTrack: bestMatch
      }
    } catch (e) {
      logger(
        'warn',
        'Anghami',
        `Search for "${searchQuery}" failed: ${e.message}`
      )
      return {
        exception: {
          message: e.message,
          severity: 'fault'
        }
      }
    }
  }

  buildTrack(item) {
    const artworkId = item.coverArt || item.AlbumArt || item.cover
    const artworkUrl = artworkId
      ? `https://artwork.anghcdn.co/?id=${artworkId}&size=640`
      : null

    const trackInfo = {
      identifier: item.id.toString(),
      isSeekable: true,
      author: item.artist || item.artistName || 'Unknown Artist',
      length: Math.round(parseFloat(item.duration || 0) * 1000),
      isStream: false,
      position: 0,
      title: item.title || item.name,
      uri: `https://play.anghami.com/song/${item.id}`,
      artworkUrl: artworkUrl,
      isrc: null,
      sourceName: 'anghami'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }
}

const SongBatchResponse = {
  decode(buffer) {
    const reader = new Reader(buffer)
    const result = {
      response: {},
      takendownSongIds: [],
      missingSongIds: []
    }

    while (reader.pos < reader.len) {
      const tag = reader.uint32()
      const fieldNo = tag >>> 3
      const wireType = tag & 7

      switch (fieldNo) {
        case 1:
          reader.skipType(wireType)
          break
        case 2:
          {
            const end = reader.uint32() + reader.pos
            let key = ''
            let value = null
            while (reader.pos < end) {
              const mapTag = reader.uint32()
              const mapFieldNo = mapTag >>> 3
              const mapWireType = mapTag & 7
              switch (mapFieldNo) {
                case 1:
                  key = reader.string()
                  break
                case 2:
                  value = Song.decode(reader, reader.uint32())
                  break
                default:
                  reader.skipType(mapWireType)
                  break
              }
            }
            if (key && value) {
              result.response[key] = value
            }
          }
          break
        case 4:
          result.takendownSongIds.push(reader.string())
          break
        case 5:
          result.missingSongIds.push(reader.string())
          break
        default:
          reader.skipType(wireType)
          break
      }
    }
    return result
  }
}

const Song = {
  decode(reader, len) {
    const end = void 0 === len ? reader.len : reader.pos + len
    const message = {
      id: '',
      title: '',
      album: '',
      albumID: '',
      artist: '',
      artistID: '',
      track: 0,
      year: '',
      duration: 0,
      coverArt: '',
      genre: '',
      keywords: [],
      description: '',
      playervideo: '',
      videoid: '',
      thumbnailid: '',
      artistType: 0,
      artistGender: 0
    }

    while (reader.pos < end) {
      const tag = reader.uint32()
      const fieldNo = tag >>> 3
      const wireType = tag & 7

      switch (fieldNo) {
        case 1:
          message.id = reader.string()
          break
        case 2:
          message.title = reader.string()
          break
        case 3:
          message.album = reader.string()
          break
        case 4:
          message.albumID = reader.string()
          break
        case 5:
          message.artist = reader.string()
          break
        case 6:
          message.artistID = reader.string()
          break
        case 7:
          message.track = reader.int32()
          break
        case 8:
          message.year = reader.string()
          break
        case 9:
          message.duration = reader.float()
          break
        case 10:
          message.coverArt = reader.string()
          break
        case 12:
          message.genre = reader.string()
          break
        case 14:
          message.keywords.push(reader.string())
          break
        case 17:
          message.description = reader.string()
          break
        case 28:
          message.playervideo = reader.string()
          break
        case 46:
          message.videoid = reader.string()
          break
        case 47:
          message.thumbnailid = reader.string()
          break
        case 61:
          message.ArtistArt = reader.string()
          break
        case 77:
          message.artistType = reader.int32()
          break
        case 78:
          message.artistGender = reader.int32()
          break
        default:
          reader.skipType(wireType)
          break
      }
    }
    return message
  }
}

class Reader {
  constructor(buffer) {
    this.buf = buffer
    this.pos = 0
    this.len = buffer.length
  }

  uint32() {
    let value = 0
    let shift = 0
    while (this.pos < this.len) {
      const b = this.buf[this.pos++]
      value |= (b & 127) << shift
      if (b < 128) return value >>> 0
      shift += 7
      if (shift >= 35) throw new Error('Varint too long')
    }
    return value >>> 0
  }

  int32() {
    return this.uint32() | 0
  }

  string() {
    const len = this.uint32()
    const str = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return str
  }

  bool() {
    return this.uint32() !== 0
  }

  float() {
    const value = this.buf.readFloatLE(this.pos)
    this.pos += 4
    return value
  }

  skipType(wireType) {
    switch (wireType) {
      case 0:
        this.uint32()
        break
      case 1:
        this.pos += 8
        break
      case 2:
        this.pos += this.uint32()
        break
      case 5:
        this.pos += 4
        break
      default:
        throw new Error('Unknown wire type: ' + wireType)
    }
  }
}
