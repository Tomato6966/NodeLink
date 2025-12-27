import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest, http1makeRequest, loadHLSPlaylist } from '../utils.js'

const DECRYPTION_KEY = 'IFYOUWANTTHEARTISTSTOGETPAIDDONOTDOWNLOADFROMMIXCLOUD'

export default class MixcloudSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.patterns = [
      /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<user>[^/]+)\/(?!stream|uploads|favorites|listens|playlists)(?<slug>[^/]+)\/?/i,
      /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<user>[^/]+)\/playlists\/(?<playlist>[^/]+)\/?/i,
      /https?:\/\/(?:(?:www|beta|m)\.)?mixcloud\.com\/(?<id>[^/]+)\/(?<type>uploads|favorites|listens|stream)?\/?/i
    ]
    this.searchTerms = ['mcsearch']
    this.priority = 90
  }

  async setup() {
    return true
  }

  async _request(query) {
    const apiUrl = `https://app.mixcloud.com/graphql?query=${encodeURIComponent(query)}`
    return makeRequest(apiUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, this.nodelink)
  }

  async search(query) {
    try {
      const apiUrl = `https://api.mixcloud.com/search/?q=${encodeURIComponent(query)}&type=cloudcast`
      let { body, statusCode, error } = await http1makeRequest(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        disableBodyCompression: true
      })

      if (error) throw error

      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch {
          logger('warn', 'Mixcloud', 'Failed to parse search API response as JSON')
          return { loadType: 'empty', data: {} }
        }
      }

      if (statusCode !== 200 || !body?.data) {
        logger('warn', 'Mixcloud', `Search API returned status ${statusCode}`)
        return { loadType: 'empty', data: {} }
      }

      if (body.data.length === 0) return { loadType: 'empty', data: {} }

      const tracks = body.data.map(item => {
        const pathParts = item.url.split('mixcloud.com/')[1].split('/').filter(Boolean)
        const trackInfo = {
          identifier: `${pathParts[0]}_${pathParts[1]}`,
          isSeekable: true,
          author: item.user?.name || pathParts[0],
          length: (item.audio_length || 0) * 1000,
          isStream: false,
          position: 0,
          title: item.name,
          uri: item.url,
          artworkUrl: item.pictures?.large || item.pictures?.medium || null,
          isrc: null,
          sourceName: 'mixcloud'
        }
        return {
          encoded: encodeTrack(trackInfo),
          info: trackInfo,
          pluginInfo: {}
        }
      }).slice(0, this.nodelink.options.maxSearchResults || 10)

      return { loadType: 'search', data: tracks }
    } catch (e) {
      logger('error', 'Mixcloud', `Search failed: ${e.message}`)
      return { loadType: 'empty', data: {} }
    }
  }

  _decrypt(ciphertextB64) {
    const ciphertext = Buffer.from(ciphertextB64, 'base64')
    const key = Buffer.from(DECRYPTION_KEY)
    const decrypted = Buffer.alloc(ciphertext.length)

    for (let i = 0; i < ciphertext.length; i++) {
      decrypted[i] = ciphertext[i] ^ key[i % key.length]
    }

    return decrypted.toString('utf-8')
  }

  async resolve(url) {
    if (this.patterns[0].test(url)) return this._resolveTrack(url)
    if (this.patterns[1].test(url)) return this._resolvePlaylist(url)
    if (this.patterns[2].test(url)) return this._resolveUser(url)

    return { loadType: 'empty', data: {} }
  }

  async _resolveTrack(url) {
    const match = url.match(this.patterns[0])
    const { user: username, slug } = match.groups
    try {
      const query = `{
        cloudcastLookup(lookup: {username: "${username}", slug: "${slug}"}) {
          audioLength
          name
          url
          owner { displayName username }
          picture(width: 1024, height: 1024) { url }
          streamInfo { hlsUrl url }
          restrictedReason
        }
      }`

      const { body, statusCode } = await this._request(query)

      if (statusCode !== 200 || !body.data?.cloudcastLookup) {
        return { loadType: 'empty', data: {} }
      }

      const data = body.data.cloudcastLookup
      if (data.restrictedReason) {
        throw new Error(`Track restricted: ${data.restrictedReason}`)
      }

      const track = this._parseTrackData(data)

      return {
        loadType: 'track',
        data: track
      }
    } catch (e) {
      logger('error', 'Mixcloud', `Track resolution failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async _resolvePlaylist(url) {
    const match = url.match(this.patterns[1])
    const { user, playlist: slug } = match.groups
    try {
      const queryTemplate = (cursor) => `{
        playlistLookup(lookup: {username: "${user}", slug: "${slug}"}) {
          name
          items(first: 100${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                cloudcast {
                  audioLength
                  name
                  url
                  owner { displayName username }
                  picture(width: 1024, height: 1024) { url }
                  streamInfo { hlsUrl url }
                }
              }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }`

      const tracks = []
      let cursor = null
      let hasNextPage = true
      let playlistName = 'Mixcloud Playlist'

      while (hasNextPage && tracks.length < (this.config.maxAlbumPlaylistLength || 1000)) {
        const { body, statusCode } = await this._request(queryTemplate(cursor))
        if (statusCode !== 200 || !body.data?.playlistLookup) break

        const data = body.data.playlistLookup
        playlistName = data.name
        
        for (const edge of data.items.edges) {
          const track = edge.node.cloudcast
          if (!track) continue
          tracks.push(this._parseTrackData(track))
        }

        cursor = data.items.pageInfo.endCursor
        hasNextPage = data.items.pageInfo.hasNextPage
      }

      return {
        loadType: 'playlist',
        data: {
          info: { name: playlistName, selectedTrack: 0 },
          tracks
        }
      }
    } catch (e) {
      logger('error', 'Mixcloud', `Playlist resolution failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  async _resolveUser(url) {
    const match = url.match(this.patterns[2])
    const { id: username, type = 'uploads' } = match.groups
    try {
      const queryType = type === 'stream' ? 'stream' : type
      const queryTemplate = (cursor) => `{
        userLookup(lookup: {username: "${username}"}) {
          displayName
          ${queryType}(first: 100${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                ${type === 'stream' ? '... on Cloudcast { audioLength name url owner { displayName username } picture(width: 1024, height: 1024) { url } streamInfo { hlsUrl url } }' : 'audioLength name url owner { displayName username } picture(width: 1024, height: 1024) { url } streamInfo { hlsUrl url }'}
              }
            }
            pageInfo { endCursor hasNextPage }
          }
        }
      }`

      const tracks = []
      let cursor = null
      let hasNextPage = true
      let userDisplayName = username

      while (hasNextPage && tracks.length < (this.config.maxAlbumPlaylistLength || 1000)) {
        const { body, statusCode } = await this._request(queryTemplate(cursor))
        if (statusCode !== 200 || !body.data?.userLookup?.[queryType]) break

        const data = body.data.userLookup
        userDisplayName = data.displayName
        const list = data[queryType]
        
        for (const edge of list.edges) {
          if (!edge.node.url) continue
          tracks.push(this._parseTrackData(edge.node))
        }

        cursor = list.pageInfo.endCursor
        hasNextPage = list.pageInfo.hasNextPage
      }

      return {
        loadType: 'playlist',
        data: {
          info: { name: `${userDisplayName} (${type})`, selectedTrack: 0 },
          tracks
        }
      }
    } catch (e) {
      logger('error', 'Mixcloud', `User resolution failed: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }

  _parseTrackData(data) {
    const pathParts = data.url.split('mixcloud.com/')[1].split('/').filter(Boolean)
    const trackInfo = {
      identifier: `${pathParts[0]}_${pathParts[1]}`,
      isSeekable: true,
      author: data.owner?.displayName || pathParts[0],
      length: (data.audioLength || 0) * 1000,
      isStream: false,
      position: 0,
      title: data.name,
      uri: data.url,
      artworkUrl: data.picture?.url || null,
      isrc: null,
      sourceName: 'mixcloud'
    }
    return {
      encoded: encodeTrack(trackInfo),
      info: trackInfo,
      pluginInfo: {
        encryptedHls: data.streamInfo?.hlsUrl,
        encryptedUrl: data.streamInfo?.url
      }
    }
  }

  async getTrackUrl(decodedTrack) {
    let { encryptedHls, encryptedUrl } = decodedTrack.pluginInfo || {}

    if (!encryptedHls && !encryptedUrl) {
      const res = await this._resolveTrack(decodedTrack.uri)
      if (res.loadType === 'track') {
        encryptedHls = res.data.pluginInfo.encryptedHls
        encryptedUrl = res.data.pluginInfo.encryptedUrl
      }
    }

    if (encryptedUrl) {
      return {
        url: this._decrypt(encryptedUrl),
        protocol: 'https',
        format: 'aac'
      }
    }

    if (encryptedHls) {
      return {
        url: this._decrypt(encryptedHls),
        protocol: 'hls',
        format: 'aac'
      }
    }

    throw new Error('No stream URL available for Mixcloud track')
  }

  async loadStream(decodedTrack, url, protocol) {
    try {
      if (protocol === 'hls') {
        const stream = new PassThrough()
        loadHLSPlaylist(url, stream)
        return { stream, type: 'aac' }
      }

      const options = {
        method: 'GET',
        streamOnly: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.mixcloud.com/'
        }
      }

      const response = await http1makeRequest(url, options)

      if (response.error || !response.stream) {
        throw response.error || new Error('Failed to get stream')
      }

      const stream = new PassThrough()
      response.stream.on('data', (chunk) => stream.write(chunk))
      response.stream.on('end', () => stream.emit('finishBuffering'))
      response.stream.on('error', (error) => {
        logger('error', 'Mixcloud', `Upstream stream error: ${error.message}`)
        stream.emit('error', error)
        stream.emit('finishBuffering')
      })

      return { stream, type: protocol === 'hls' ? 'aac' : 'm4a' }
    } catch (e) {
      logger('error', 'Mixcloud', `Failed to load stream: ${e.message}`)
      return { exception: { message: e.message, severity: 'fault' } }
    }
  }
}