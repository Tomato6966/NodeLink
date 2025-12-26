import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest, http1makeRequest } from '../utils.js'

const IV = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])

export default class DeezerSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.searchTerms = ['dzsearch']
    this.patterns = [
      /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]+(?:-[a-z]+)?\/)?(track|album|playlist|artist)\/(\d+)$/,
      /^https?:\/\/link\.deezer\.com\/s\/([a-zA-Z0-9]+)/
    ]
    this.priority = 80

    this.cookie = null
    this.csrfToken = null
    this.licenseToken = null
  }

  async setup() {
    logger('info', 'Sources', 'Initializing Deezer source...')

    const cachedCsrf = this.nodelink.credentialManager.get('deezer_csrf_token')
    const cachedLicense = this.nodelink.credentialManager.get('deezer_license_token')
    const cachedCookie = this.nodelink.credentialManager.get('deezer_cookie')

    if (cachedCsrf && cachedLicense && cachedCookie) {
      this.csrfToken = cachedCsrf
      this.licenseToken = cachedLicense
      this.cookie = cachedCookie
      logger('info', 'Sources', 'Loaded Deezer credentials from CredentialManager.')
      return true
    }

    try {
      let initialCookie = ''
      const arl = this.config.sources?.deezer?.arl

      if (typeof arl === 'string' && arl.length > 0) {
        initialCookie = `arl=${arl}`
      }

      const userDataRes = await makeRequest(
        'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=',
        {
          method: 'GET',
          getCookies: true,
          headers: {
            Cookie: initialCookie
          }
        }
      )

      if (userDataRes.error || !userDataRes.body?.results) {
        throw new Error(
          `Failed to fetch user data: ${userDataRes.error?.message || 'Invalid response.'}`
        )
      }

      const responseCookies =
        userDataRes.headers['set-cookie']?.join('; ') || ''
      this.cookie = initialCookie
        ? `${initialCookie}; ${responseCookies}`
        : responseCookies

      this.csrfToken = userDataRes.body.results.checkForm
      this.licenseToken = userDataRes.body.results.USER.OPTIONS.license_token

      this.nodelink.credentialManager.set('deezer_csrf_token', this.csrfToken, 24 * 60 * 60 * 1000)
      this.nodelink.credentialManager.set('deezer_license_token', this.licenseToken, 24 * 60 * 60 * 1000)
      this.nodelink.credentialManager.set('deezer_cookie', this.cookie, 24 * 60 * 60 * 1000)

      if (!this.csrfToken || !this.licenseToken) {
        throw new Error('CSRF Token or License Token not found in response.')
      }

      logger('info', 'Sources', 'Deezer source setup successfully.')
      return true
    } catch (e) {
      logger('error', 'Sources', `Failed to setup Deezer source: ${e.message}`)
      return false
    }
  }

  async search(query) {
    logger('debug', 'Sources', `Searching Deezer for: "${query}"`)

    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/search?q=${encodeURI(query)}`,
      { method: 'GET' }
    )

    if (error || body.error) {
      return {
        exception: {
          message: error?.message || body.error.message,
          severity: 'common'
        }
      }
    }

    if (body.total === 0) {
      return { loadType: 'empty', data: {} }
    }

    const tracks = body.data
      .filter((item) => item.type === 'track')
      .slice(0, this.config.maxSearchResults || 10)
      .map((item) => this.buildTrack(item))

    return { loadType: 'search', data: tracks }
  }

  async resolve(url) {
    if (url.includes('link.deezer.com')) {
      const res = await http1makeRequest(url, { method: 'GET' })
      const match = res.body.match(/\/(track|album|playlist|artist)\/(\d+)/)
      if (match) {
        const [, type, id] = match
        return await this.resolve(`https://www.deezer.com/${type}/${id}`)
      }
      return { loadType: 'empty', data: {} }
    }

    const pattern = this.patterns[0]
    const match = url.match(pattern)
    if (!match) return { loadType: 'empty', data: {} }

    const [, type, id] = match
    logger(
      'debug',
      'Sources',
      `Resolving Deezer URL of type '${type}' with ID '${id}'`
    )

    const { body, error } = await makeRequest(
      `https://api.deezer.com/2.0/${type}/${id}`,
      {
        method: 'GET'
      }
    )

    if (error || body.error) {
      if (body.error?.code === 800) return { loadType: 'empty', data: {} }
      return {
        exception: {
          message: error?.message || body.error.message,
          severity: 'fault'
        }
      }
    }

    switch (type) {
      case 'track': {
        const track = this.buildTrack(body)
        return { loadType: 'track', data: track }
      }
      // forced album to load as a playlist, because the code is not loading album types, but playlist loadType works.
      case 'album':
      case 'playlist': {
        const playlistData = body
        const tracklistUrl = `${playlistData.tracklist}?limit=${this.config.maxAlbumPlaylistLength || 1000}`
        const tracksRes = await makeRequest(tracklistUrl, { method: 'GET' })

        if (tracksRes.error || !tracksRes.body?.data) {
          return {
            exception: {
              message: 'Could not fetch playlist tracks.',
              severity: 'common'
            }
          }
        }

        const tracks = []
        for (const item of tracksRes.body.data) {
          tracks.push(
            this.buildTrack(
              item,
              playlistData.cover_xl || playlistData.picture_xl
            )
          )
        }

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: playlistData.title,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        }
      }
      case 'artist': {
        const artistData = body
        const topTracksRes = await makeRequest(
          `https://api.deezer.com/2.0/artist/${id}/top?limit=${this.config.maxAlbumPlaylistLength || 25}`
        )

        if (topTracksRes.error || topTracksRes.body.error) {
          return {
            exception: {
              message:
                topTracksRes.error?.message || topTracksRes.body.error.message,
              severity: 'common'
            }
          }
        }

        const tracks = topTracksRes.body.data.map((item) => {
          if (!item.album) item.album = {}
          item.album.cover_xl = artistData.picture_xl
          return this.buildTrack(item)
        })

        return {
          loadType: 'artist',
          data: {
            info: {
              name: `${artistData.name}\'s Top Tracks`,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        }
      }
      default:
        return { loadType: 'empty', data: {} }
    }
  }

  buildTrack(item, artworkUrl = null) {
    const trackInfo = {
      identifier: item.id.toString(),
      isSeekable: false,
      author: item.artist.name,
      length: item.duration * 1000,
      isStream: false,
      position: 0,
      title: item.title,
      uri: item.link,
      artworkUrl: artworkUrl || item.album?.cover_xl || null,
      isrc: item.isrc || null,
      sourceName: 'deezer'
    }

    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {}
    }
  }

  async getTrackUrl(decodedTrack) {
    const { body: trackData } = await makeRequest(
      `https://www.deezer.com/ajax/gw-light.php?method=song.getListData&input=3&api_version=1.0&api_token=${this.csrfToken}`,
      {
        method: 'POST',
        headers: { Cookie: this.cookie },
        body: { sng_ids: [decodedTrack.identifier] },
        disableBodyCompression: true
      }
    )

    if (trackData.error.length) {
      const message = Object.values(trackData.error).join('; ')
      return { exception: { message, severity: 'fault' } }
    }

    const trackInfo = trackData.results.data[0]

    const { body: streamData } = await makeRequest(
      'https://media.deezer.com/v1/get_url',
      {
        method: 'POST',
        body: {
          license_token: this.licenseToken,
          media: [
            {
              type: 'FULL',
              formats: [
                { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
                { cipher: 'BF_CBC_STRIPE', format: 'MP3_256' },
                { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
                { cipher: 'BF_CBC_STRIPE', format: 'MP3_MISC' }
              ]
            }
          ],
          track_tokens: [trackInfo.TRACK_TOKEN]
        },
        disableBodyCompression: true
      }
    )

    if (streamData.error || !streamData?.data[0]?.media[0]?.sources[0]?.url) {
      return {
        exception: { message: 'Could not get stream URL.', severity: 'common' }
      }
    }

    const streamInfo = streamData.data[0].media[0]
    return {
      url: streamInfo.sources[0].url,
      protocol: 'https',
      format: streamInfo.format.startsWith('MP3') ? 'mp3' : 'flac',
      additionalData: trackInfo
    }
  }

  loadStream(decodedTrack, url, format, additionalData) {
    return new Promise(async (resolve) => {
      try {
        const outputStream = new PassThrough()
        const trackKey = this._calculateKey(additionalData.SNG_ID)
        const bufferSize = 2048
        let buf = Buffer.alloc(0)
        let i = 0

        const res = await makeRequest(url, {
          method: 'GET',
          streamOnly: true
        })

        if (res.error || res.statusCode !== 200) {
          const error =
            res.error ||
            new Error(`Request failed with status ${res.statusCode}`)
          logger(
            'error',
            'Sources',
            `Error fetching Deezer stream: ${error.message}`
          )
          return resolve({
            exception: {
              message: error.message,
              severity: 'fault',
              cause: 'Upstream'
            }
          })
        }

        res.stream.on('end', () => outputStream.emit('finishBuffering'))

        res.stream.on('error', (error) => {
          logger(
            'error',
            'Sources',
            `Error in Deezer source stream for track ${decodedTrack.title}: ${error.message}`
          )
          resolve({
            exception: {
              message: error.message,
              severity: 'fault',
              cause: 'Unknown'
            }
          })
        })

        res.stream.on('readable', () => {
          let chunk = null
          while (true) {
            chunk = res.stream.read(bufferSize)

            if (!chunk) {
              if (res.stream.readableLength) {
                chunk = res.stream.read(res.stream.readableLength)
                buf = Buffer.concat([buf, chunk])
              }
              break
            }
            buf = Buffer.concat([buf, chunk])

            while (buf.length >= bufferSize) {
              const bufferSized = buf.subarray(0, bufferSize)

              if (i % 3 === 0) {
                const decipher = crypto
                  .createDecipheriv('bf-cbc', trackKey, IV)
                  .setAutoPadding(false)
                outputStream.push(decipher.update(bufferSized))
                outputStream.push(decipher.final())
              } else {
                outputStream.push(bufferSized)
              }
              i++
              buf = buf.subarray(bufferSize)
            }
          }
        })

        resolve({ stream: outputStream })
      } catch (e) {
        logger(
          'error',
          'Sources',
          `Failed to load Deezer stream for ${decodedTrack.identifier}: ${e.message}`
        )
        resolve({ exception: { message: e.message, severity: 'fault' } })
      }
    })
  }

  _calculateKey(songId) {
    const key = this.config.sources?.deezer?.decryptionKey

    if (typeof key !== 'string' || key.length !== 16) {
      throw new Error(
        'A valid 16-character Deezer decryptionKey is not provided in the configuration.'
      )
    }

    const songIdHash = crypto
      .createHash('md5')
      .update(songId.toString(), 'ascii')
      .digest('hex')
    const trackKey = Buffer.alloc(16)

    for (let i = 0; i < 16; i++) {
      trackKey[i] =
        songIdHash.charCodeAt(i) ^
        songIdHash.charCodeAt(i + 16) ^
        key.charCodeAt(i)
    }

    return trackKey
  }
}
