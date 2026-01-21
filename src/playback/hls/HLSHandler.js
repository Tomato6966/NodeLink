import { PassThrough } from 'node:stream'
import { http1makeRequest, logger } from '../../utils.js'
import PlaylistParser from './PlaylistParser.js'
import SegmentFetcher from './SegmentFetcher.js'

export default class HLSHandler extends PassThrough {
  constructor(url, options = {}) {
    super({ highWaterMark: options.highWaterMark || 1024 * 1024 * 5 })
    
    this.currentUrl = url
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.strategy = options.type?.includes('fmp4') ? 'segmented' : 'streaming'
    
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
    this.activeSegmentStream = null

    this.on('error', (err) => { this.destroy(err) })
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
    if (this.activeSegmentStream) {
      this.activeSegmentStream.destroy()
      this.activeSegmentStream = null
    }
    this.segmentQueue = []
    this.processedSegments.clear()
    this.processedOrder = []
    if (!this.destroyed) super.destroy(err)
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
        headers: this.headers, method: 'GET', localAddress: this.localAddress
      })
      if (error || statusCode !== 200) throw new Error(`Playlist fetch failed: ${statusCode}`)

      const parsed = PlaylistParser.parse(playlistContent, this.currentUrl)
      if (parsed.isMaster) {
        this.currentUrl = parsed.variants[0].url
        return setImmediate(() => this._playlistLoop())
      }

      const isFirstLoad = !this.isLive && this.processedSegments.size === 0
      this.isLive = parsed.isLive

      if (isFirstLoad && this.isLive) {
        const toSkip = Math.max(0, parsed.segments.length - 3)
        for (let i = 0; i < toSkip; i++) {
          this.processedSegments.add(parsed.segments[i].url)
          this.processedOrder.push(parsed.segments[i].url)
        }
      }

      const newSegments = parsed.segments.filter(s => !this.processedSegments.has(s.url))
      for (const segment of newSegments) {
        this._rememberSegment(segment.url)
        this.segmentQueue.push(segment)
      }

      if (this.segmentQueue.length > 0 && !this.isFetching) this._fetchSegments()

      if (this.isLive && !playlistContent.includes('#EXT-X-ENDLIST')) {
        const delay = Math.max(1, parsed.targetDuration) * 1000
        this.playlistTimer = setTimeout(() => this._playlistLoop(), delay)
      }
    } catch (err) {
      if (!this.isLive) return this.destroy(err)
      this.playlistTimer = setTimeout(() => this._playlistLoop(), 5000)
    }
  }

  async _fetchSegments() {
    if (this.isFetching || this.stop) return
    this.isFetching = true

    while (this.segmentQueue.length > 0 && !this.stop) {
      const segment = this.segmentQueue.shift()
      try {
        if (segment.map && segment.map.uri !== this.lastMapUri) {
          const mapData = await this.fetcher.fetchMap(segment.map, segment.key)
          if (mapData && !this.stop) {
            if (!this.write(mapData)) await new Promise(r => this.once('drain', r))
            this.lastMapUri = segment.map.uri
          }
        }

        if (this.strategy === 'segmented') {
          const data = await this.fetcher.fetchSegment(segment, { stream: false })
          if (!this.stop) {
            if (!this.write(data)) await new Promise(r => this.once('drain', r))
          }
        } else {
          const segmentStream = await this.fetcher.fetchSegment(segment, { stream: true })
          this.activeSegmentStream = segmentStream
          
          for await (const chunk of segmentStream) {
            if (this.stop) break
            if (!this.write(chunk)) await new Promise(r => this.once('drain', r))
          }
          this.activeSegmentStream = null
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