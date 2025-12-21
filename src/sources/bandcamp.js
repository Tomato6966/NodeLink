import { PassThrough } from 'node:stream'
import { encodeTrack, logger, makeRequest } from '../utils.js'

export default class BandCampSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.baseUrl = 'https://bandcamp.com'
    this.patterns = [
      /^https?:\/\/([^/]+)\.bandcamp\.com\/(track|album)\/([^/?]+)/
    ]
    this.searchTerms = ['bcsearch']
    this.priority = 90
  }

  async setup() {
    logger('info', 'Sources', 'Loaded BandCamp source.')
    return true
  }

  isLinkMatch(link) {
    return this.patterns.some((pattern) => pattern.test(link))
  }

  async search(query) {
    try {
      const request = await makeRequest(
        `${this.baseUrl}/search?q=${encodeURI(query)}&item_type=t&from=results`,
        { method: 'GET' }
      )
      if (request.error || request.statusCode !== 200) {
        return {
          exception: {
            message:
              request.error?.message ||
              `BandCamp returned an invalid status: ${request.statusCode}`,
            severity: 'fault',
            cause: 'Request Failed'
          }
        }
      }

      const { body } = request
      const resultBlocks = body.match(
        /<li class="searchresult data-search"[\s\S]*?<\/li>/g
      )

      if (!resultBlocks || resultBlocks.length === 0) {
        logger(
          'debug',
          'Sources',
          `No results found on BandCamp for: "${query}"`
        )
        return { loadType: 'empty', data: {} }
      }

      const tracks = []
      const maxResults = this.nodelink.options.maxSearchResults

      for (const block of resultBlocks) {
        if (tracks.length >= maxResults) break

        const urlMatch = block.match(/<a class="artcont" href="([^"]+)">/)
        const titleMatch = block.match(
          /<div class="heading">\s*<a[^>]*>\s*(.+?)\s*<\/a>/
        )
        const subheadMatch = block.match(
          /<div class="subhead">([\s\S]*?)<\/div>/
        )
        const artworkMatch = block.match(
          /<div class="art">\s*<img src="([^"]+)"/
        )

        if (titleMatch && subheadMatch && urlMatch) {
          const fullSubhead = subheadMatch[1].trim()
          const artist = fullSubhead.split(' de ').pop().trim()

          const trackInfo = {
            title: titleMatch[1].trim(),
            author: artist,
            uri: urlMatch[1].split('?')[0],
            artworkUrl: artworkMatch ? artworkMatch[1] : null
          }

          tracks.push(this.buildTrack(trackInfo, false))
        }
      }

      if (tracks.length === 0) {
        logger(
          'warn',
          'Sources',
          'Search results found on BandCamp, but no tracks could be parsed.'
        )
        return { loadType: 'empty', data: {} }
      }

      logger(
        'debug',
        'Sources',
        `Found ${tracks.length} tracks on BandCamp for: "${query}"`
      )
      return {
        loadType: 'search',
        data: tracks
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  async resolve(url) {
    try {
      const tralbumData = await this.extractTralbumData(url)
      if (!tralbumData) {
        logger(
          'warn',
          'Sources',
          `No 'tralbum' data found on BandCamp for: ${url}`
        )
        return { loadType: 'empty', data: {} }
      }

      if (tralbumData.trackinfo && tralbumData.trackinfo.length > 1) {
        const tracks = tralbumData.trackinfo
          .map((item) => {
            if (!item.title_link) return null

            const trackUrl = new URL(item.title_link, url).href

            return this.buildTrack({
              identifier: String(item.track_id || item.id),
              isSeekable: true,
              author: tralbumData.artist,
              length: item.duration ? Math.round(item.duration * 1000) : -1,
              isStream: false,
              title: item.title,
              uri: trackUrl,
              artworkUrl: tralbumData.art_id
                ? `https://f4.bcbits.com/img/a${tralbumData.art_id}_10.jpg`
                : null
            })
          })
          .filter((track) => track !== null)

        return {
          loadType: 'playlist',
          data: {
            info: {
              name: tralbumData.current.title,
              selectedTrack: 0
            },
            pluginInfo: {},
            tracks
          }
        }
        //biome-ignore lint: use switch statement instead of if-else chain
      } else {
        const trackData = tralbumData.trackinfo[0]
        const track = this.buildTrack({
          identifier: String(trackData.track_id || trackData.id),
          isSeekable: true,
          author: tralbumData.artist,
          length: trackData.duration
            ? Math.round(trackData.duration * 1000)
            : -1,
          isStream: false,
          title: trackData.title,
          uri: url,
          artworkUrl: tralbumData.art_id
            ? `https://f4.bcbits.com/img/a${tralbumData.art_id}_10.jpg`
            : null
        })
        return { loadType: 'track', data: track }
      }
    } catch (e) {
      return {
        exception: { message: e.message, severity: 'fault', cause: 'Exception' }
      }
    }
  }

  async getTrackUrl(track) {
    try {
      const { body, error, statusCode } = await makeRequest(track.uri, {
        method: 'GET'
      })

      if (error || statusCode !== 200) {
        throw new Error(
          `Failed to fetch track page: ${error?.message || statusCode}`
        )
      }

      const streamUrlMatch = body.match(
        /https?:\/\/t4\.bcbits\.com\/stream\/[a-zA-Z0-9]+\/mp3-128\/\d+\?p=\d+&amp;ts=\d+&amp;t=[a-zA-Z0-9]+&amp;token=\d+_[a-zA-Z0-9]+/
      )

      if (!streamUrlMatch) {
        throw new Error('No stream URL was found in the page content.')
      }

      const streamUrl = streamUrlMatch[0].replace(/&amp;/g, '&')

      return {
        url: streamUrl,
        protocol: 'https',
        format: 'mp3'
      }
    } catch (e) {
      return {
        exception: {
          message: e.message,
          severity: 'fault',
          cause: 'Stream Extraction Failed'
        }
      }
    }
  }

  async loadStream(decodedTrack, url) {
    logger(
      'debug',
      'Sources',
      `Loading BandCamp stream for "${decodedTrack.title}"`
    )
    try {
      const response = await makeRequest(url, {
        method: 'GET',
        streamOnly: true
      })

      if (response.error || !response.stream) {
        throw (
          response.error ||
          new Error('Failed to get stream, no stream object returned.')
        )
      }

      const stream = new PassThrough()
      response.stream.pipe(stream)

      return { stream }
    } catch (err) {
      logger(
        'error',
        'Sources',
        `Failed to load BandCamp stream: ${err.message}`
      )
      return {
        exception: {
          message: err.message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
  }

  async extractTralbumData(url) {
    const { body, error, statusCode } = await makeRequest(url, {
      method: 'GET'
    })
    if (error || statusCode !== 200) {
      logger(
        'error',
        'Sources',
        `Failed to fetch BandCamp page: ${error?.message || statusCode}`
      )
      return null
    }

    const match = body.match(/data-tralbum=(["'])(.+?)\1/)
    if (!match || !match[2]) return null

    const decodedString = match[2].replace(/&quot;/g, '"')
    return JSON.parse(decodedString)
  }

  buildTrack(partialInfo, complete = true) {
    const track = {
      identifier: complete
        ? partialInfo.identifier
        : this.getIdentifierFromUrl(partialInfo.uri),
      isSeekable: complete ? partialInfo.isSeekable : true,
      author: partialInfo.author || 'Unknown Artist',
      length: complete ? partialInfo.length : -1,
      isStream: complete ? partialInfo.isStream : false,
      position: 0,
      title: partialInfo.title || 'Unknown Title',
      uri: partialInfo.uri,
      artworkUrl: partialInfo.artworkUrl,
      isrc: null,
      sourceName: 'bandcamp'
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }

  getIdentifierFromUrl(url) {
    if (!url) return null
    const match = url.match(
      /^https?:\/\/([^/]+)\.bandcamp\.com\/(?:track|album)\/([^/?]+)/
    )
    return match ? `${match[1]}:${match[2]}` : url
  }
}
