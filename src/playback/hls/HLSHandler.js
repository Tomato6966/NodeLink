import { PassThrough } from 'node:stream'
import { http1makeRequest, logger } from '../../utils.js'
import PlaylistParser from './PlaylistParser.js'
import SegmentFetcher from './SegmentFetcher.js'

export default class HLSHandler extends PassThrough {
  constructor(url, options = {}) {
    super({ highWaterMark: options.highWaterMark || 1024 * 1024 * 5 })
    
    this.masterUrl = url
    this.currentUrl = url
    this.headers = options.headers || {}
    this.localAddress = options.localAddress || null
    this.onResolveUrl = options.onResolveUrl || null
    this.strategy = options.strategy || (options.type?.includes('fmp4') ? 'segmented' : 'streaming')
    
    this.fetcher = new SegmentFetcher({ 
      headers: this.headers,
      localAddress: this.localAddress,
      onResolveUrl: this.onResolveUrl
    })
    
    this.processedSegments = new Set()
    this.processedOrder = []
    this.MAX_HISTORY = 200
    this.segmentQueue = []
    this.MAX_PARALLEL_FETCHES = this.strategy === 'segmented' ? 3 : (this.strategy === 'streaming' ? 2 : 1)
    this.isFetching = false
    this.stop = false
    this.lastMapUri = null
    this.isLive = false
    this.playlistTimer = null
    this.activeSegmentStreams = new Map()
    this.lastMediaSequence = -1
    this.highestSequence = -1
    this.maxGap = 30
    this.stuckCount = 0
    this.preRolled = false
    this.justResynced = false
    this.masterRefreshCounter = 0
    this.MASTER_REFRESH_INTERVAL = 3

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
    for (const stream of this.activeSegmentStreams.values()) {
      stream.destroy()
    }
    this.activeSegmentStreams.clear()
    this.segmentQueue = []
    this.processedSegments.clear()
    this.processedOrder = []
    this.lastMediaSequence = -1
    this.highestSequence = -1
    if (!this.destroyed) super.destroy(err)
  }

  _rememberSegment(key) {
    if (this.processedSegments.has(key)) return false
    this.processedSegments.add(key)
    this.processedOrder.push(key)
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

      if (error || statusCode !== 200) {
        if (statusCode === 403 || statusCode === 410) {
          if (this.currentUrl !== this.masterUrl) {
            this.currentUrl = this.masterUrl
            this.justResynced = true
            return setImmediate(() => this._playlistLoop())
          }
        }
        throw new Error(`Playlist fetch failed: ${statusCode}`)
      }

      let parsed
      try {
        parsed = PlaylistParser.parse(playlistContent, this.currentUrl)
      } catch (e) {
        if (this.currentUrl !== this.masterUrl) {
          this.currentUrl = this.masterUrl
          this.justResynced = true
          return setImmediate(() => this._playlistLoop())
        }
        throw e
      }

      if (parsed.isMaster) {
        const sortedVariants = parsed.variants.sort((a, b) => b.bandwidth - a.bandwidth)
        const bestVariant = sortedVariants.find(v => 
          (v.codecs?.includes('mp4a') || v.codecs?.includes('opus')) && 
          !v.codecs?.includes('avc1')
        ) || sortedVariants.find(v => 
          v.codecs?.includes('mp4a') || v.codecs?.includes('opus')
        ) || sortedVariants[0]

        logger('debug', 'HLSHandler', `Selected variant bandwidth: ${bestVariant.bandwidth}, codecs: ${bestVariant.codecs}`)
        this.currentUrl = bestVariant.url
        return setImmediate(() => this._playlistLoop())
      }

      this.isLive = parsed.isLive

      if (this.lastMediaSequence !== -1 && (parsed.mediaSequence < this.lastMediaSequence || parsed.mediaSequence > this.lastMediaSequence + this.maxGap)) {
        if (this.isLive) {
          logger('warn', 'HLSHandler', `Playlist sequence discontinuity (${this.lastMediaSequence} -> ${parsed.mediaSequence}). Resetting to live edge.`)
          this.segmentQueue = []
          this.processedSegments.clear()
          this.processedOrder = []
          this.highestSequence = -1
          this.preRolled = false
          this.justResynced = true
        }
      }
      this.lastMediaSequence = parsed.mediaSequence

      if (this.isLive && ++this.masterRefreshCounter >= this.MASTER_REFRESH_INTERVAL) {
        this.masterRefreshCounter = 0
        this.currentUrl = this.masterUrl
        return setImmediate(() => this._playlistLoop())
      }

      const isFirstLoad = this.processedSegments.size === 0
      if (this.isLive && (isFirstLoad || this.justResynced)) {
        if (this.justResynced) {
          this.processedSegments.clear()
          this.processedOrder = []
          this.highestSequence = -1
        }

        const toTake = 12
        const startIdx = Math.max(0, parsed.segments.length - toTake)
        for (let i = 0; i < startIdx; i++) {
          const seg = parsed.segments[i]
          const key = seg.sequence !== -1 ? seg.sequence : seg.url
          this.processedSegments.add(key)
          this.processedOrder.push(key)
          if (seg.sequence !== -1 && seg.sequence > this.highestSequence) this.highestSequence = seg.sequence
        }
        this.justResynced = false
      } else {
        this.justResynced = false
      }

      const newSegments = parsed.segments.filter(s => {
        if (s.sequence !== -1 && s.sequence <= this.highestSequence) return false
        const key = s.sequence !== -1 ? s.sequence : s.url
        return !this.processedSegments.has(key)
      })

      if (newSegments.length > 0) {
        this.stuckCount = 0
        for (const segment of newSegments) {
          if (segment.discontinuity && this.isLive) {
            logger('debug', 'HLSHandler', 'Discontinuity detected in segment. Clearing queue and re-syncing.')
            this.segmentQueue = []
            this.processedSegments.clear()
            this.processedOrder = []
            this.highestSequence = -1
            this.preRolled = false
            this.justResynced = true
            return setImmediate(() => this._playlistLoop())
          }

          const key = segment.sequence !== -1 ? segment.sequence : segment.url
          this._rememberSegment(key)
          this.segmentQueue.push(segment)
          if (segment.sequence !== -1 && segment.sequence > this.highestSequence) this.highestSequence = segment.sequence
        }
      } else if (this.isLive) {
        if (++this.stuckCount >= 10) {
          logger('warn', 'HLSHandler', 'No new segments for 10 reloads. Refreshing master playlist.')
          this.stuckCount = 0
          this.currentUrl = this.masterUrl
          this.justResynced = true
          return setImmediate(() => this._playlistLoop())
        }
      }

      if (this.segmentQueue.length > 0) {
        if (!this.isFetching) this._fetchSegments()
      }

      if (this.isLive && !playlistContent.includes('#EXT-X-ENDLIST')) {
        this._scheduleNextTick(parsed.targetDuration)
      }
    } catch (err) {
      if (!this.isLive) return this.destroy(err)
      this.playlistTimer = setTimeout(() => this._playlistLoop(), 3000)
    }
  }

  async _fetchWithRetry(segment, attempt = 1) {
    try {
      if (this.strategy === 'segmented') {
        const data = await this.fetcher.fetchSegment(segment, { stream: false })
        return { segment, data }
      }
      const stream = await this.fetcher.fetchSegment(segment, { stream: true })
      return { segment, stream }
    } catch (err) {
      if (this.stop) return null
      const isRecoverable = err.message === 'aborted' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
      if (isRecoverable && attempt <= 3) {
        const delay = Math.pow(2, attempt) * 500
        logger('warn', 'HLSHandler', `Segment fetch failed (attempt ${attempt}/3): ${err.message}. Retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        return this._fetchWithRetry(segment, attempt + 1)
      }
      logger('error', 'HLSHandler', `Segment fetch permanently failed ${segment.sequence}: ${err.message}`)
      return null
    }
  }

  async _fetchSegments() {
    if (this.isFetching || this.stop) return
    this.isFetching = true

    const fetchPool = new Map()

    const fillPool = () => {
      while (fetchPool.size < this.MAX_PARALLEL_FETCHES && this.segmentQueue.length > 0) {
        const seg = this.segmentQueue.shift()
        const key = seg.sequence !== -1 ? seg.sequence : seg.url
        fetchPool.set(key, this._fetchWithRetry(seg))
      }
    }

    while ((this.segmentQueue.length > 0 || fetchPool.size > 0) && !this.stop) {
      fillPool()

      if (this.isLive && fetchPool.size === 0 && this.segmentQueue.length === 0 && !this.preRolled) {
        await new Promise(r => setTimeout(r, 500))
        if (this.segmentQueue.length === 0 && fetchPool.size === 0) break
        continue
      }

      if (fetchPool.size === 0) break

      const [key, promise] = fetchPool.entries().next().value
      fetchPool.delete(key)
      
      const current = await promise
      if (!current) {
        logger('warn', 'HLSHandler', `Skipping failed segment: ${key}`)
        continue
      }

      this.preRolled = true

      try {
        const { segment, data, stream } = current
        if (segment.map && segment.map.uri !== this.lastMapUri) {
          const mapData = await this.fetcher.fetchMap(segment.map, segment.key)
          if (mapData && !this.stop) {
            if (!this.write(mapData)) await new Promise(r => this.once('drain', r))
            this.lastMapUri = segment.map.uri
          }
        }

        if (this.strategy === 'segmented') {
          if (!this.stop && data) {
            if (!this.write(data)) await new Promise(r => this.once('drain', r))
          }
        } else if (stream) {
          this.activeSegmentStreams.set(key, stream)
          for await (const chunk of stream) {
            if (this.stop) break
            if (!this.write(chunk)) await new Promise(r => this.once('drain', r))
          }
          this.activeSegmentStreams.delete(key)
        }
      } catch (err) {
        logger('error', 'HLSHandler', `Segment processing error: ${err.message}`)
      }
    }

    this.isFetching = false
    if (!this.isLive && this.segmentQueue.length === 0 && fetchPool.size === 0 && !this.stop) {
      this.emit('finishBuffering')
      this.end()
    }
  }

  _scheduleNextTick(targetDuration) {
    if (this.stop) return
    const delay = Math.max(0.5, targetDuration / 2) * 1000
    this.playlistTimer = setTimeout(() => this._playlistLoop(), delay)
  }
}