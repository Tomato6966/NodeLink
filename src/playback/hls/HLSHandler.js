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
    this.strategy = options.type?.includes('fmp4') ? 'segmented' : 'streaming'
    
    this.fetcher = new SegmentFetcher({ 
      headers: this.headers,
      localAddress: this.localAddress,
      onResolveUrl: this.onResolveUrl
    })
    
    this.processedSegments = new Set()
    this.processedOrder = []
    this.MAX_HISTORY = 200
    this.segmentQueue = []
    this.isFetching = false
    this.stop = false
    this.lastMapUri = null
    this.isLive = false
    this.playlistTimer = null
    this.activeSegmentStream = null
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
    if (this.activeSegmentStream) {
      this.activeSegmentStream.destroy()
      this.activeSegmentStream = null
    }
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
        const bestVariant = parsed.variants.reduce((prev, current) => {
          const hasAudio = (v) => v.codecs?.includes('mp4a') || v.codecs?.includes('opus')
          if (!hasAudio(prev)) return current
          if (!hasAudio(current)) return prev
          return (current.bandwidth > prev.bandwidth) ? current : prev
        }, parsed.variants[0])

        const itag = bestVariant.url.match(/[\/&]itag[\/](\d+)/)?.[1] || 
                     bestVariant.url.match(/[?&]itag=(\d+)/)?.[1] || 'unknown'

        logger('debug', 'HLSHandler', `Selected variant itag: ${itag}, bandwidth: ${bestVariant.bandwidth}, codecs: ${bestVariant.codecs}`)
        this.currentUrl = bestVariant.url
        return setImmediate(() => this._playlistLoop())
      }

      this.isLive = parsed.isLive

      if (this.lastMediaSequence !== -1 && (parsed.mediaSequence < this.lastMediaSequence || parsed.mediaSequence > this.lastMediaSequence + this.maxGap)) {
        logger('warn', 'HLSHandler', `Playlist sequence discontinuity (${this.lastMediaSequence} -> ${parsed.mediaSequence}). Resetting to live edge.`)
        this.segmentQueue = []
        this.processedSegments.clear()
        this.processedOrder = []
        this.highestSequence = -1
        this.preRolled = false
        this.justResynced = true
      }
      this.lastMediaSequence = parsed.mediaSequence

      if (this.isLive && ++this.masterRefreshCounter >= this.MASTER_REFRESH_INTERVAL) {
        this.masterRefreshCounter = 0
        this.currentUrl = this.masterUrl
        return setImmediate(() => this._playlistLoop())
      }

      const isFirstLoad = this.processedSegments.size === 0
      if ((isFirstLoad || this.justResynced) && this.isLive) {
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

  async _fetchSegments() {
    if (this.isFetching || this.stop) return
    this.isFetching = true

    let nextSegmentPromise = null

    const getSegment = async (seg) => {
      try {
        if (this.strategy === 'segmented') {
          return { segment: seg, data: await this.fetcher.fetchSegment(seg, { stream: false }) }
        }
        return { segment: seg, stream: await this.fetcher.fetchSegment(seg, { stream: true }) }
      } catch (err) {
        logger('error', 'HLSHandler', `Segment fetch error ${seg.sequence}: ${err.message}`)
        return null
      }
    }

    while ((this.segmentQueue.length > 0 || nextSegmentPromise) && !this.stop) {
      if (this.isLive && this.segmentQueue.length < 3 && !nextSegmentPromise) {
        await new Promise(r => setTimeout(r, 500))
        if (this.segmentQueue.length === 0) break
      }

      let current
      if (nextSegmentPromise) {
        current = await nextSegmentPromise
        nextSegmentPromise = null
      } else {
        const seg = this.segmentQueue.shift()
        current = await getSegment(seg)
      }

      if (!current) continue

      if (this.segmentQueue.length > 0 && !this.stop) {
        nextSegmentPromise = getSegment(this.segmentQueue.shift())
      }

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
          this.activeSegmentStream = stream
          for await (const chunk of stream) {
            if (this.stop) break
            if (!this.write(chunk)) await new Promise(r => this.once('drain', r))
          }
          this.activeSegmentStream = null
        }
      } catch (err) {
        logger('error', 'HLSHandler', `Segment processing error: ${err.message}`)
      }
    }

    this.isFetching = false
    if (!this.isLive && this.segmentQueue.length === 0 && !this.stop) {
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