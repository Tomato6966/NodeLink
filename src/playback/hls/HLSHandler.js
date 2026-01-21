import { PassThrough } from 'node:stream'
import { http1makeRequest, logger } from '../../utils.js'
import PlaylistParser from './PlaylistParser.js'
import SegmentFetcher from './SegmentFetcher.js'

export default class HLSHandler extends PassThrough {
  constructor(url, options = {}) {
    super({ highWaterMark: options.highWaterMark || 1024 * 1024 * 2 }) // 2MB default
    
    this.currentUrl = url
    this.options = options
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.chunkReadahead = options.chunkReadahead || 3
    this.liveBuffer = options.liveBuffer || 20000
    
    this.fetcher = new SegmentFetcher({ 
      headers: this.headers,
      localAddress: this.localAddress
    })
    
    this.processedSegments = new Set()
    this.processedOrder = []
    this.MAX_HISTORY = 100

    this.segmentQueue = []
    this.isFetching = false
    this.stop = false
    this.lastMapUri = null
    this.isLive = false
    this.playlistTimer = null

    this.on('close', () => { this.destroy() })
    this.on('error', () => { this.destroy() })

    this._start()
  }

  async _start() {
    await this._playlistLoop()
  }

  destroy(err) {
    if (this.stop) return
    this.stop = true
    
    if (this.playlistTimer) {
      clearTimeout(this.playlistTimer)
      this.playlistTimer = null
    }

    this.segmentQueue = []
    this.processedSegments.clear()
    this.processedOrder = []
    
    super.destroy(err)
  }

  _rememberSegment(url) {
    if (this.processedSegments.has(url)) return false
    this.processedSegments.add(url)
    this.processedOrder.push(url)
    if (this.processedOrder.length > this.MAX_HISTORY) {
      this.processedSegments.delete(this.processedOrder.shift())
    }
    return true
  }

  async _playlistLoop() {
    if (this.stop) return

    try {
      const { body: playlistContent, error, statusCode } = await http1makeRequest(this.currentUrl, {
        headers: this.headers,
        method: 'GET',
        localAddress: this.localAddress
      })

      if (error || statusCode !== 200) {
        throw new Error(`Failed to fetch playlist: ${statusCode}`)
      }

      const parsed = PlaylistParser.parse(playlistContent, this.currentUrl)

      if (parsed.isMaster) {
        this.currentUrl = parsed.variants[0].url
        return setImmediate(() => this._playlistLoop())
      }

      const isFirstLoad = !this.isLive && this.processedSegments.size === 0
      this.isLive = parsed.isLive

      let segmentsToAdd = parsed.segments

      if (isFirstLoad && this.isLive) {
        const segmentsToSkip = Math.max(0, parsed.segments.length - this.chunkReadahead)
        segmentsToAdd = parsed.segments.slice(segmentsToSkip)
        
        for (let i = 0; i < segmentsToSkip; i++) {
          this.processedSegments.add(parsed.segments[i].url)
          this.processedOrder.push(parsed.segments[i].url)
        }
      }

      for (const segment of segmentsToAdd) {
        if (this._rememberSegment(segment.url)) {
          this.segmentQueue.push(segment)
        }
      }

      if (this.segmentQueue.length > 0 && !this.isFetching) {
        this._fetchSegments()
      }

      if (this.isLive && !playlistContent.includes('#EXT-X-ENDLIST')) {
        this.playlistTimer = setTimeout(() => this._playlistLoop(), parsed.targetDuration * 1000)
      }
    } catch (err) {
      logger('error', 'HLSHandler', `Playlist error: ${err.message}`)
      if (!this.isLive) return this.destroy(err)
      
      this.playlistTimer = setTimeout(() => this._playlistLoop(), 5000)
    }
  }

  async _fetchSegments() {
    if (this.isFetching || this.stop) return
    this.isFetching = true

    while (this.segmentQueue.length > 0 && !this.stop) {
      if (this.writableLength >= this.writableHighWaterMark) {
        await new Promise((resolve) => this.once('drain', resolve))
        if (this.stop) break
      }

      const segment = this.segmentQueue.shift()

      try {
        if (segment.map && segment.map.uri !== this.lastMapUri) {
          const mapData = await this.fetcher.fetchMap(segment.map)
          if (mapData && !this.stop) {
            this.write(mapData)
            this.lastMapUri = segment.map.uri
          }
        }

        const data = await this.fetcher.fetchSegment(segment)
        
        if (!this.stop) {
          this.write(data)
        }
      } catch (err) {
        logger('error', 'HLSHandler', `Segment error ${segment.sequence}: ${err.message}`)
      }
    }

    this.isFetching = false
    
    if (!this.isLive && this.segmentQueue.length === 0 && !this.stop) {
      this.emit('finishBuffering')
      this.end()
    }
  }
}