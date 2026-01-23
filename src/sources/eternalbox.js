import { PassThrough, Readable } from 'node:stream'
import * as MP4Box from 'mp4box'
import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const SAMPLE_RATES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350
])

const _createAdtsHeader = (sampleLength, profile, samplingIndex, channelCount) => {
  const frameLength = sampleLength + 7
  const profileIndex = profile - 1

  return Buffer.from([
    0xff,
    0xf1,
    ((profileIndex & 0x03) << 6) |
      ((samplingIndex & 0x0f) << 2) |
      ((channelCount & 0x04) >> 2),
    ((channelCount & 0x03) << 6) | ((frameLength & 0x1800) >> 11),
    (frameLength & 0x7f8) >> 3,
    ((frameLength & 0x7) << 5) | 0x1f,
    0xfc
  ])
}

export default class EternalboxSource {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.sources?.eternalbox || {}
    this.baseUrl = this.config.baseUrl || 'https://eternalboxmirror.xyz'
    this.searchTerms = ['eternalbox', 'ebox', 'jukebox']
    this.patterns = [
      /https?:\/\/(?:www\.)?eternalboxmirror\.xyz\/jukebox_go\.html\?id=([A-Za-z0-9]+)/i,
      /https?:\/\/(?:www\.)?eternalboxmirror\.xyz\/api\/analysis\/analyse\/([A-Za-z0-9]+)/i,
      /https?:\/\/(?:www\.)?eternalboxmirror\.xyz\/api\/audio\/jukebox\/([A-Za-z0-9]+)/i,
      /https?:\/\/(?:www\.)?eternalboxmirror\.xyz\/api\/audio\/jukebox\/([A-Za-z0-9]+)\/location/i
    ]
    this.priority = 60
    this.cache = new Map()
    this.cacheSizeBytes = 0
    this.cacheMaxBytes = this.config.cacheMaxBytes ?? 20 * 1024 * 1024
  }

  async setup() {
    logger('info', 'Sources', 'Loaded Eternalbox source.')
    return true
  }

  async search(query) {
    if (!query) return { loadType: 'empty', data: {} }

    if (this._looksLikeId(query)) {
      return this.resolve(this._buildJukeboxUrl(query))
    }

    const limit =
      this.config.searchResults || this.nodelink.options.maxSearchResults || 10
    const url = `${this.baseUrl}/api/analysis/search?query=${encodeURIComponent(
      query
    )}&results=${limit}`

    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: this._buildApiHeaders()
      })

      if (statusCode !== 200) return { loadType: 'empty', data: {} }

      const items = this._extractItems(body)
      if (!items.length) return { loadType: 'empty', data: {} }

      const tracks = items
        .map((item) => this._buildTrackFromItem(item))
        .filter(Boolean)

      if (!tracks.length) return { loadType: 'empty', data: {} }
      return { loadType: 'search', data: tracks }
    } catch (err) {
      logger('error', 'Eternalbox', `Search failed: ${err.message}`)
      return { exception: { message: err.message, severity: 'fault' } }
    }
  }

  async resolve(url) {
    const id = this._extractId(url)
    if (!id) return { loadType: 'empty', data: {} }

    try {
      const [analysisPayload, ogAudioSource] = await Promise.all([
        this._fetchAnalysis(id),
        this._fetchOgAudioSource(id)
      ])
      if (!analysisPayload?.info) return { loadType: 'empty', data: {} }

      const spotifyData =
        analysisPayload.info?.service === 'SPOTIFY'
          ? await this._fetchSpotifyInfo(analysisPayload.info?.id || id)
          : null

      const trackData = this._buildTrack(
        analysisPayload,
        id,
        ogAudioSource,
        spotifyData
      )

      if (this._isEternalEnabled() && analysisPayload?.analysis) {
        this._primeAnalysisCache(id, analysisPayload.analysis)
      }

      return { loadType: 'track', data: trackData }
    } catch (err) {
      logger('error', 'Eternalbox', `Resolve failed: ${err.message}`)
      return { exception: { message: err.message, severity: 'fault' } }
    }
  }

  async getTrackUrl(track) {
    const id = track.identifier || this._extractId(track.uri)
    if (!id) {
      return {
        exception: {
          message: 'Missing Eternalbox id for stream URL.',
          severity: 'common'
        }
      }
    }

    return {
      url: this._buildStreamUrl(id),
      protocol: 'https',
      format: 'm4a',
      additionalData: {
        headers: this._buildStreamHeaders(id)
      }
    }
  }

  async loadStream(_decodedTrack, url, _protocol, additionalData) {
    try {
      const id = this._extractId(url)
      const headers = {
        ...this._buildStreamHeaders(id),
        ...(additionalData?.headers || {})
      }

      if (this._isEternalEnabled() && id) {
        const eternal = await this._getOrCreateEternalCache(id, headers)
        if (eternal?.stream) {
          return { stream: eternal.stream, type: eternal.type }
        }
      }

      const out = new PassThrough()
      let stopped = false
      let currentStream = null
      let reconnects = 0
      let lastHeaders = null
      const maxReconnects = this.config.maxReconnects ?? 0
      const reconnectDelayMs = this.config.reconnectDelayMs ?? 1000
      const allowInfinite = maxReconnects === 0

      const cleanupCurrent = () => {
        if (currentStream && !currentStream.destroyed) {
          currentStream.destroy()
        }
        currentStream = null
      }

      const scheduleReconnect = () => {
        if (stopped) return
        if (!allowInfinite && reconnects >= maxReconnects) {
          out.end()
          return
        }
        reconnects += 1
        setTimeout(() => {
          startRequest().catch((err) => {
            logger('error', 'Eternalbox', `Reconnect failed: ${err.message}`)
            scheduleReconnect()
          })
        }, reconnectDelayMs)
      }

      const startRequest = async () => {
        if (stopped) return
        const response = await http1makeRequest(url, {
          method: 'GET',
          streamOnly: true,
          headers
        })

        if (!response.stream || response.statusCode >= 400) {
          throw new Error(
            `Stream request failed with status ${response.statusCode}`
          )
        }

        lastHeaders = response.headers || null
        currentStream = response.stream
        currentStream.pipe(out, { end: false })
        currentStream.on('end', () => {
          cleanupCurrent()
          scheduleReconnect()
        })
        currentStream.on('error', (err) => {
          logger('error', 'Eternalbox', `Stream error: ${err.message}`)
          cleanupCurrent()
          scheduleReconnect()
        })
      }

      out.on('close', () => {
        stopped = true
        cleanupCurrent()
      })
      out.on('error', () => {
        stopped = true
        cleanupCurrent()
      })

      startRequest().catch((err) => {
        logger('error', 'Eternalbox', `Failed to load stream: ${err.message}`)
        scheduleReconnect()
      })

      const contentType =
        lastHeaders?.['content-type'] || 'audio/mp4; codecs="mp4a.40.2"'
      return { stream: out, type: contentType }
    } catch (err) {
      logger('error', 'Eternalbox', `Failed to load stream: ${err.message}`)
      return { exception: { message: err.message, severity: 'common' } }
    }
  }

  _extractItems(body) {
    if (Array.isArray(body)) return body
    if (Array.isArray(body?.results)) return body.results
    if (Array.isArray(body?.data)) return body.data
    if (Array.isArray(body?.tracks)) return body.tracks
    if (Array.isArray(body?.items)) return body.items
    if (Array.isArray(body?.results?.items)) return body.results.items
    if (Array.isArray(body?.results?.data)) return body.results.data
    return []
  }

  _buildTrackFromItem(item) {
    const info = item?.info || item?.track || item
    const id = info?.id || item?.id
    if (!id) return null
    return this._buildTrack({ info }, id)
  }

  async _fetchAnalysis(id) {
    const url = `${this.baseUrl}/api/analysis/analyse/${id}`
    const { body, statusCode } = await http1makeRequest(url, {
      headers: this._buildApiHeaders(id)
    })
    if (statusCode !== 200) return null
    return body
  }

  _buildTrack(payload, id, ogAudioSource = null, spotifyData = null) {
    const info = payload?.info || payload || {}
    const analysis = payload?.analysis || null
    const spotifyTitle = spotifyData?.name || null
    const spotifyArtists = Array.isArray(spotifyData?.artists)
      ? spotifyData.artists.map((a) => a?.name).filter(Boolean).join(', ')
      : null
    const title = spotifyTitle || info?.title || info?.name || 'Unknown'
    const author = spotifyArtists || info?.artist || info?.author || 'Unknown'
    const duration = Number.parseInt(info?.duration ?? info?.length ?? -1, 10)
    const summarySeconds = Number.parseFloat(
      analysis?.audio_summary?.duration ?? NaN
    )
    const summaryMs = Number.isFinite(summarySeconds)
      ? Math.round(summarySeconds * 1000)
      : -1
    const length = Number.isFinite(duration) && duration > 0 ? duration : summaryMs
    const infiniteStream = this.config.infiniteStream ?? true
    const isStream = Boolean(infiniteStream)

    const track = {
      identifier: id,
      isSeekable: !isStream,
      author,
      length: isStream ? -1 : length,
      isStream,
      position: 0,
      title,
      uri: info?.url || this._buildJukeboxUrl(id),
      artworkUrl:
        spotifyData?.album?.images?.[0]?.url ||
        info?.artwork ||
        info?.image ||
        null,
      isrc: spotifyData?.external_ids?.isrc || info?.isrc || null,
      sourceName: 'eternalbox'
    }

    const includeAnalysis = this.config.includeAnalysis ?? true
    const includeSummary = this.config.includeAnalysisSummary ?? true

    const pluginInfo = {
      service: info?.service || null,
      sourceUrl: info?.url || null,
      analysisUrl: `${this.baseUrl}/api/analysis/analyse/${id}`,
      streamUrl: this._buildStreamUrl(id),
      ogAudioSourceUrl: `${this.baseUrl}/api/audio/jukebox/${id}/location`,
      ogAudioSource: ogAudioSource
    }

    if (includeSummary) {
      pluginInfo.analysisSummary = this._buildAnalysisSummary(
        analysis,
        length
      )
    }

    if (spotifyData) {
      pluginInfo.spotify = {
        id: spotifyData?.id || id,
        url: spotifyData?.external_urls?.spotify || info?.url || null,
        isrc: spotifyData?.external_ids?.isrc || null,
        artworkUrl: spotifyData?.album?.images?.[0]?.url || null,
        durationMs: spotifyData?.duration_ms || null,
        previewUrl: spotifyData?.preview_url || null
      }
    }

    if (includeAnalysis && analysis) {
      pluginInfo.analysis = analysis
    }

    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo
    }
  }

  _extractId(input) {
    if (!input || typeof input !== 'string') return null
    if (input.startsWith('eternalbox:')) return input.slice('eternalbox:'.length)
    if (input.startsWith('ebox:')) return input.slice('ebox:'.length)

    try {
      const url = new URL(input)
      const idFromQuery = url.searchParams.get('id')
      if (idFromQuery) return idFromQuery

      const match =
        url.pathname.match(/\/analyse\/([A-Za-z0-9]+)/i) ||
        url.pathname.match(/\/jukebox\/([A-Za-z0-9]+)/i)
      if (match) return match[1]
    } catch (_e) {}

    return null
  }

  _looksLikeId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9]{10,40}$/.test(value)
  }

  _buildJukeboxUrl(id) {
    if (!id) return this.baseUrl
    return `${this.baseUrl}/jukebox_go.html?id=${id}`
  }

  _buildStreamUrl(id) {
    return `${this.baseUrl}/api/audio/jukebox/${id}`
  }

  _buildApiHeaders() {
    return {
      Accept: 'application/json'
    }
  }

  _buildStreamHeaders(id) {
    return {
      Accept: '*/*',
      Referer: this._buildJukeboxUrl(id),
      Origin: this.baseUrl,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    }
  }

  async _fetchOgAudioSource(id) {
    const url = `${this.baseUrl}/api/audio/jukebox/${id}/location`
    try {
      const { body, statusCode } = await http1makeRequest(url, {
        headers: this._buildApiHeaders(id)
      })
      if (statusCode !== 200) return null
      return body?.url || null
    } catch (_err) {
      return null
    }
  }

  async _fetchSpotifyInfo(id) {
    if (!this.config.enrichSpotify) return null
    const spotify = this.nodelink.sources?.getSource('spotify')
    if (!spotify || typeof spotify._apiRequest !== 'function') return null

    try {
      if (typeof spotify.setup === 'function') {
        await spotify.setup()
      }
      if (!spotify.accessToken) return null
      return await spotify._apiRequest(`/tracks/${id}`)
    } catch (_err) {
      return null
    }
  }

  _buildAnalysisSummary(analysis, length) {
    if (!analysis || typeof analysis !== 'object') {
      return {
        durationMs: length > 0 ? length : null,
        beats: null,
        bars: null,
        sections: null,
        tatums: null,
        segments: null
      }
    }

    return {
      durationMs: length > 0 ? length : null,
      beats: Array.isArray(analysis.beats) ? analysis.beats.length : null,
      bars: Array.isArray(analysis.bars) ? analysis.bars.length : null,
      sections: Array.isArray(analysis.sections) ? analysis.sections.length : null,
      tatums: Array.isArray(analysis.tatums) ? analysis.tatums.length : null,
      segments: Array.isArray(analysis.segments) ? analysis.segments.length : null
    }
  }

  _isEternalEnabled() {
    return this.config.eternalStream ?? true
  }

  _primeAnalysisCache(id, analysis) {
    if (!id || !analysis) return
    const existing = this.cache.get(id)
    if (existing?.analysis) return
    this.cache.set(id, { analysis })
  }

  _clearCache() {
    this.cache.clear()
    this.cacheSizeBytes = 0
  }

  async _getOrCreateEternalCache(id, headers) {
    const cached = this.cache.get(id)
    if (cached?.streamReady && cached?.frames?.length) {
      return {
        stream: this._createEternalStream(cached, id),
        type: 'audio/aac'
      }
    }

    const analysis = cached?.analysis || (await this._fetchAnalysis(id))?.analysis
    if (!analysis?.beats?.length || !analysis?.segments?.length) return null

    const audioBuffer = await this._fetchAudioBufferWithLimit(id, headers)
    if (!audioBuffer) return null

    const parsed = this._parseMp4ToAdtsFrames(audioBuffer)
    if (!parsed?.frames?.length) return null

    const beatFrames = this._buildBeatFrameMap(
      analysis.beats,
      parsed.frameStarts,
      parsed.frameEnds
    )
    const neighborData = this._buildBeatNeighbors(
      analysis.beats,
      analysis.segments,
      analysis.bars
    )

    const entry = {
      analysis,
      frames: parsed.frames,
      frameStarts: parsed.frameStarts,
      frameEnds: parsed.frameEnds,
      beatFrames,
      beatNeighbors: neighborData.neighbors,
      lastBranchPoint: neighborData.lastBranchPoint,
      streamReady: true,
      sizeBytes: parsed.totalBytes
    }

    if (entry.sizeBytes > this.cacheMaxBytes) {
      return null
    }

    if (this.cacheSizeBytes + entry.sizeBytes > this.cacheMaxBytes) {
      this._clearCache()
    }

    this.cache.set(id, entry)
    this.cacheSizeBytes += entry.sizeBytes

    return { stream: this._createEternalStream(entry, id), type: 'audio/aac' }
  }

  async _fetchAudioBufferWithLimit(id, headers) {
    const url = this._buildStreamUrl(id)
    try {
      const head = await http1makeRequest(url, { method: 'HEAD', headers })
      const lengthHeader = head?.headers?.['content-length']
      const length = lengthHeader ? Number.parseInt(lengthHeader, 10) : null
      if (Number.isFinite(length) && length > this.cacheMaxBytes) {
        logger(
          'warn',
          'Eternalbox',
          `Audio exceeds cache limit (${length} > ${this.cacheMaxBytes}).`
        )
        return null
      }
    } catch (_err) {
      // ignore
    }

    const response = await http1makeRequest(url, {
      method: 'GET',
      streamOnly: true,
      headers
    })

    if (!response.stream || response.statusCode >= 400) return null

    return await new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      const stream = response.stream

      stream.on('data', (chunk) => {
        total += chunk.length
        if (total > this.cacheMaxBytes) {
          stream.destroy(new Error('Cache limit exceeded'))
          reject(new Error('Cache limit exceeded'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', (err) => reject(err))
    }).catch((err) => {
      logger('error', 'Eternalbox', `Cache download failed: ${err.message}`)
      return null
    })
  }

  _parseMp4ToAdtsFrames(buffer) {
    const mp4boxFile = MP4Box.createFile()
    const frames = []
    const frameStarts = []
    const frameEnds = []
    let audioConfig = null
    let timescale = null
    let totalBytes = 0

    mp4boxFile.onReady = (info) => {
      const audioTrack = info.tracks.find((t) => t.codec?.startsWith('mp4a'))
      if (!audioTrack) return
      timescale = audioTrack.timescale
      audioConfig = this._getAudioConfig(audioTrack)
      mp4boxFile.setExtractionOptions(audioTrack.id, null, { nbSamples: 1 })
      mp4boxFile.start()
    }

    mp4boxFile.onSamples = (_id, _user, samples) => {
      if (!audioConfig || !timescale) return
      for (const sample of samples) {
        if (!sample?.data) continue
        const sampleData =
          sample.data instanceof ArrayBuffer
            ? Buffer.from(sample.data)
            : Buffer.from(sample.data.buffer || sample.data)

        const adts = _createAdtsHeader(
          sampleData.byteLength,
          audioConfig.profile,
          audioConfig.samplingIndex,
          audioConfig.channelCount
        )
        const frame = Buffer.concat([adts, sampleData])
        frames.push(frame)
        totalBytes += frame.length
        const start = sample.dts / timescale
        const end = (sample.dts + sample.duration) / timescale
        frameStarts.push(start)
        frameEnds.push(end)
      }
    }

    mp4boxFile.onError = (e) => {
      logger('error', 'Eternalbox', `MP4 parse error: ${e}`)
    }

    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    )
    arrayBuffer.fileStart = 0
    mp4boxFile.appendBuffer(arrayBuffer)
    mp4boxFile.flush()

    return {
      frames,
      frameStarts,
      frameEnds,
      totalBytes
    }
  }

  _getAudioConfig(track) {
    const samplingIndex = SAMPLE_RATES.indexOf(track.audio.sample_rate)
    if (samplingIndex === -1) throw new Error('Unsupported sample rate for ADTS')

    let profile = 2
    if (track.codec) {
      const codecParts = track.codec.split('.')
      if (codecParts.length >= 3) {
        const profileVal = Number.parseInt(codecParts[2], 10)
        if (Number.isFinite(profileVal) && profileVal > 0) profile = profileVal
      }
    }

    return {
      samplingIndex,
      channelCount: track.audio.channel_count,
      profile
    }
  }

  _buildBeatFrameMap(beats, frameStarts, frameEnds) {
    const beatFrames = []
    for (const beat of beats) {
      const startIdx = this._findFrameIndex(frameStarts, beat.start)
      const endIdx = this._findFrameIndex(frameEnds, beat.start + beat.duration)
      beatFrames.push({
        startFrame: startIdx,
        endFrame: Math.max(startIdx, endIdx)
      })
    }
    return beatFrames
  }

  _findFrameIndex(frameTimes, target) {
    let low = 0
    let high = frameTimes.length - 1
    let result = frameTimes.length - 1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (frameTimes[mid] >= target) {
        result = mid
        high = mid - 1
      } else {
        low = mid + 1
      }
    }

    return result
  }

  _buildBeatNeighbors(beats, segments, bars) {
    const maxNeighbors = this.config.maxBranches ?? 4
    const maxThreshold = this.config.maxBranchThreshold ?? 80
    const thresholdStart = this.config.branchThresholdStart ?? 10
    const thresholdStep = this.config.branchThresholdStep ?? 5
    const targetDivisor = this.config.branchTargetDivisor ?? 6
    const addLastEdge = this.config.addLastEdge ?? true
    const justBackwards = this.config.justBackwards ?? false
    const justLongBranches = this.config.justLongBranches ?? false
    const removeSequentialBranches = this.config.removeSequentialBranches ?? true
    const useFilteredSegments = this.config.useFilteredSegments ?? true

    const rawSegments = Array.isArray(segments) ? segments : []
    const segmentsToUse = useFilteredSegments
      ? this._filterSegments(rawSegments)
      : rawSegments
    const quanta = this._buildBeatQuanta(
      beats,
      segmentsToUse,
      bars,
      rawSegments
    )
    this._precalculateNearestNeighbors(quanta, maxNeighbors, maxThreshold)

    let threshold = thresholdStart
    let count = 0
    const targetBranchCount = Math.floor(quanta.length / targetDivisor)

    for (threshold = thresholdStart; threshold < maxThreshold; threshold += thresholdStep) {
      count = this._collectNearestNeighbors(
        quanta,
        threshold,
        justBackwards,
        justLongBranches
      )
      if (count >= targetBranchCount) break
    }

    if (addLastEdge) {
      const longest = this._longestBackwardBranch(quanta)
      this._insertBestBackwardBranch(
        quanta,
        threshold,
        longest < 50 ? 65 : 55
      )
    }

    this._calculateReachability(quanta)
    const lastBranchPoint = this._findBestLastBeat(quanta)
    this._filterOutBadBranches(quanta, lastBranchPoint)
    if (removeSequentialBranches) {
      this._filterOutSequentialBranches(quanta, lastBranchPoint)
    }

    const neighbors = quanta.map((q) => q.neighbors.map((n) => n.dest.which))
    return { neighbors, lastBranchPoint }
  }

  _buildBeatQuanta(beats, segments, bars, rawSegments) {
    const quanta = beats.map((beat, index) => ({
      ...beat,
      which: index,
      prev: null,
      next: null,
      indexInParent: 0,
      parent: null,
      overlappingSegments: [],
      oseg: null,
      all_neighbors: [],
      neighbors: [],
      reach: 0
    }))

    for (let i = 0; i < quanta.length; i++) {
      quanta[i].prev = i > 0 ? quanta[i - 1] : null
      quanta[i].next = i < quanta.length - 1 ? quanta[i + 1] : null
    }

    const barQuanta = Array.isArray(bars)
      ? bars.map((bar, index) => ({
          ...bar,
          which: index,
          prev: null,
          next: null,
          children: []
        }))
      : []

    for (let i = 0; i < barQuanta.length; i++) {
      barQuanta[i].prev = i > 0 ? barQuanta[i - 1] : null
      barQuanta[i].next = i < barQuanta.length - 1 ? barQuanta[i + 1] : null
    }

    if (barQuanta.length > 0) {
      let barIndex = 0
      for (const q of quanta) {
        while (
          barIndex < barQuanta.length - 1 &&
          q.start >= barQuanta[barIndex].start + barQuanta[barIndex].duration
        ) {
          barIndex++
        }
        const parent = barQuanta[barIndex]
        q.parent = parent
        q.indexInParent = parent.children.length
        parent.children.push(q)
      }
    }

    const segmentList = Array.isArray(segments) ? segments : []
    for (let i = 0; i < segmentList.length; i++) {
      segmentList[i].which = i
    }

    const rawSegmentList = Array.isArray(rawSegments) ? rawSegments : segmentList
    for (let i = 0; i < rawSegmentList.length; i++) {
      rawSegmentList[i].which = rawSegmentList[i].which ?? i
    }

    let segIdx = 0
    let firstSegIdx = 0
    for (const q of quanta) {
      const beatEnd = q.start + q.duration
      while (
        firstSegIdx < rawSegmentList.length &&
        rawSegmentList[firstSegIdx].start < q.start
      ) {
        firstSegIdx++
      }

      if (firstSegIdx < rawSegmentList.length) {
        q.oseg = rawSegmentList[firstSegIdx]
      }

      while (
        segIdx < segmentList.length &&
        segmentList[segIdx].start + segmentList[segIdx].duration <= q.start
      ) {
        segIdx++
      }
      let cursor = segIdx
      while (cursor < segmentList.length && segmentList[cursor].start < beatEnd) {
        q.overlappingSegments.push(segmentList[cursor])
        cursor++
      }
    }

    return quanta
  }

  _precalculateNearestNeighbors(quanta, maxNeighbors, maxThreshold) {
    for (const q of quanta) {
      this._calculateNearestNeighborsForQuantum(
        quanta,
        maxNeighbors,
        maxThreshold,
        q
      )
    }
  }

  _calculateNearestNeighborsForQuantum(quanta, maxNeighbors, maxThreshold, q1) {
    const edges = []
    if (!q1.overlappingSegments.length) {
      q1.all_neighbors = []
      return
    }

    for (const q2 of quanta) {
      if (q2.which === q1.which) continue

      let sum = 0
      for (let j = 0; j < q1.overlappingSegments.length; j++) {
        const seg1 = q1.overlappingSegments[j]
        let distance = 100
        if (j < q2.overlappingSegments.length) {
          const seg2 = q2.overlappingSegments[j]
          if (seg1.which === seg2.which) {
            distance = 100
          } else {
            distance = this._getSegDistance(seg1, seg2)
          }
        }
        sum += distance
      }

      const parentDistance = q1.indexInParent === q2.indexInParent ? 0 : 100
      const totalDistance = sum / q1.overlappingSegments.length + parentDistance
      if (totalDistance < maxThreshold) {
        edges.push({
          src: q1,
          dest: q2,
          distance: totalDistance,
          deleted: false
        })
      }
    }

    edges.sort((a, b) => a.distance - b.distance)
    q1.all_neighbors = edges.slice(0, maxNeighbors)
  }

  _collectNearestNeighbors(quanta, threshold, justBackwards, justLongBranches) {
    let branchingCount = 0
    const minLongBranch = Math.floor(quanta.length / 5)

    for (const q of quanta) {
      q.neighbors = this._extractNearestNeighbors(
        q,
        threshold,
        justBackwards,
        justLongBranches,
        minLongBranch
      )
      if (q.neighbors.length > 0) branchingCount++
    }

    return branchingCount
  }

  _extractNearestNeighbors(q, maxThreshold, justBackwards, justLongBranches, minLongBranch) {
    const neighbors = []
    for (const neighbor of q.all_neighbors) {
      if (neighbor.deleted) continue
      if (justBackwards && neighbor.dest.which > q.which) continue
      if (
        justLongBranches &&
        Math.abs(neighbor.dest.which - q.which) < minLongBranch
      ) {
        continue
      }
      if (neighbor.distance <= maxThreshold) neighbors.push(neighbor)
    }
    return neighbors
  }

  _getSegDistance(seg1, seg2) {
    const timbreWeight = this.config.timbreWeight ?? 1
    const pitchWeight = this.config.pitchWeight ?? 10
    const loudStartWeight = this.config.loudStartWeight ?? 1
    const loudMaxWeight = this.config.loudMaxWeight ?? 1
    const durationWeight = this.config.durationWeight ?? 100
    const confidenceWeight = this.config.confidenceWeight ?? 1

    const timbre = this._euclidean(seg1.timbre, seg2.timbre)
    const pitch = this._euclidean(seg1.pitches, seg2.pitches)
    const loudStart = Math.abs(seg1.loudness_start - seg2.loudness_start)
    const loudMax = Math.abs(seg1.loudness_max - seg2.loudness_max)
    const duration = Math.abs(seg1.duration - seg2.duration)
    const confidence = Math.abs(seg1.confidence - seg2.confidence)

    return (
      timbre * timbreWeight +
      pitch * pitchWeight +
      loudStart * loudStartWeight +
      loudMax * loudMaxWeight +
      duration * durationWeight +
      confidence * confidenceWeight
    )
  }

  _euclidean(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return 100
    let sum = 0
    for (let i = 0; i < a.length; i++) {
      const delta = (b[i] ?? 0) - (a[i] ?? 0)
      sum += delta * delta
    }
    return Math.sqrt(sum)
  }

  _longestBackwardBranch(quanta) {
    let longest = 0
    for (const q of quanta) {
      for (const neighbor of q.neighbors) {
        const delta = q.which - neighbor.dest.which
        if (delta > longest) longest = delta
      }
    }
    return (longest * 100) / quanta.length
  }

  _insertBestBackwardBranch(quanta, threshold, maxThreshold) {
    const branches = []
    for (const q of quanta) {
      for (const neighbor of q.all_neighbors) {
        if (neighbor.deleted) continue
        const delta = q.which - neighbor.dest.which
        if (delta > 0 && neighbor.distance < maxThreshold) {
          const percent = (delta * 100) / quanta.length
          branches.push({ percent, q, neighbor })
        }
      }
    }

    if (branches.length === 0) return
    branches.sort((a, b) => b.percent - a.percent)
    const best = branches[0]
    if (best.neighbor.distance > threshold) {
      best.q.neighbors.push(best.neighbor)
    }
  }

  _calculateReachability(quanta) {
    const maxIter = 1000
    for (const q of quanta) {
      q.reach = quanta.length - q.which
    }

    for (let iter = 0; iter < maxIter; iter++) {
      let changeCount = 0
      for (let i = 0; i < quanta.length; i++) {
        const q = quanta[i]
        let changed = false
        for (const neighbor of q.neighbors) {
          const q2 = neighbor.dest
          if (q2.reach > q.reach) {
            q.reach = q2.reach
            changed = true
          }
        }
        if (i < quanta.length - 1) {
          const q2 = quanta[i + 1]
          if (q2.reach > q.reach) {
            q.reach = q2.reach
            changed = true
          }
        }
        if (changed) {
          changeCount++
          for (let j = 0; j < q.which; j++) {
            const q2 = quanta[j]
            if (q2.reach < q.reach) q2.reach = q.reach
          }
        }
      }
      if (changeCount === 0) break
    }
  }

  _findBestLastBeat(quanta) {
    const reachThreshold = 50
    let longest = 0
    let longestReach = 0
    for (let i = quanta.length - 1; i >= 0; i--) {
      const q = quanta[i]
      const distanceToEnd = quanta.length - i
      const reach = ((q.reach - distanceToEnd) * 100) / quanta.length
      if (reach > longestReach && q.neighbors.length > 0) {
        longestReach = reach
        longest = i
        if (reach >= reachThreshold) break
      }
    }
    return longest
  }

  _filterOutBadBranches(quanta, lastIndex) {
    for (let i = 0; i < lastIndex; i++) {
      const q = quanta[i]
      q.neighbors = q.neighbors.filter(
        (neighbor) => neighbor.dest.which < lastIndex
      )
    }
  }

  _hasSequentialBranch(q, neighbor, lastBranchPoint) {
    if (q.which === lastBranchPoint) return false
    const qp = q.prev
    if (!qp) return false
    const distance = q.which - neighbor.dest.which
    for (const n of qp.neighbors) {
      const odistance = qp.which - n.dest.which
      if (distance === odistance) return true
    }
    return false
  }

  _filterOutSequentialBranches(quanta, lastBranchPoint) {
    for (let i = quanta.length - 1; i >= 1; i--) {
      const q = quanta[i]
      const newList = []
      for (const neighbor of q.neighbors) {
        if (!this._hasSequentialBranch(q, neighbor, lastBranchPoint)) {
          newList.push(neighbor)
        }
      }
      q.neighbors = newList
    }
  }

  _filterSegments(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return []

    const threshold = 0.3
    const filtered = [segments[0]]
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]
      const last = filtered[filtered.length - 1]
      const similar =
        this._timbralDistance(seg, last) < 1 &&
        (seg.confidence ?? 1) < threshold
      if (similar) {
        filtered[filtered.length - 1] = {
          ...last,
          duration: last.duration + seg.duration
        }
      } else {
        filtered.push(seg)
      }
    }

    return filtered
  }

  _timbralDistance(seg1, seg2) {
    const a = seg1?.timbre || []
    const b = seg2?.timbre || []
    let sum = 0
    for (let i = 0; i < 3; i++) {
      const delta = (b[i] ?? 0) - (a[i] ?? 0)
      sum += delta * delta
    }
    return Math.sqrt(sum)
  }

  _createEternalStream(entry, id) {
    const frames = entry.frames
    const beatFrames = entry.beatFrames
    const neighbors = entry.beatNeighbors
    const minBranchChance = this.config.minRandomBranchChance ?? 0.18
    const maxBranchChance = this.config.maxRandomBranchChance ?? 0.5
    const branchChanceDelta = this.config.randomBranchChanceDelta ?? 0.018
    const lastBranchPoint = entry.lastBranchPoint ?? 0

    let currentBeat = 0
    let currentFrame = beatFrames[0]?.startFrame ?? 0
    let endFrame = beatFrames[0]?.endFrame ?? frames.length - 1
    let isStopped = false
    let isPaused = false
    let curBranchChance = minBranchChance
    const neighborOffsets = new Array(neighbors.length).fill(0)

    const stream = new PassThrough()

    const chooseNextBeat = () => {
      let nextSequential = currentBeat + 1
      if (nextSequential >= beatFrames.length) {
        stream.emit('eternalboxJump', {
          id,
          fromBeat: currentBeat,
          toBeat: 0,
          type: 'loop'
        })
        nextSequential = 0
      }

      const seedBeat = nextSequential
      const neighborList = neighbors[seedBeat] || []

      if (neighborList.length === 0) {
        return seedBeat
      }

      if (seedBeat === lastBranchPoint) {
        curBranchChance = minBranchChance
        return this._selectNextNeighbor(
          neighborList,
          neighborOffsets,
          seedBeat,
          id,
          stream
        )
      }

      curBranchChance += branchChanceDelta
      if (curBranchChance > maxBranchChance) curBranchChance = maxBranchChance

      const shouldJump = Math.random() < curBranchChance
      if (shouldJump) {
        curBranchChance = minBranchChance
        return this._selectNextNeighbor(
          neighborList,
          neighborOffsets,
          seedBeat,
          id,
          stream
        )
      }

      return seedBeat
    }

    const schedulePump = () => {
      if (isStopped) return
      setImmediate(pump)
    }

    const pump = () => {
      if (isStopped || isPaused) return
      while (true) {
        while (currentFrame <= endFrame) {
          const ok = stream.write(frames[currentFrame])
          if (!ok) {
            isPaused = true
            stream.once('drain', () => {
              isPaused = false
              schedulePump()
            })
            return
          }
          currentFrame++
        }

        const nextBeat = chooseNextBeat()
        currentBeat = nextBeat ?? 0
        currentFrame = beatFrames[currentBeat]?.startFrame ?? 0
        endFrame = beatFrames[currentBeat]?.endFrame ?? frames.length - 1
      }
    }

    stream.on('close', () => {
      isStopped = true
    })
    stream.on('finish', () => {
      isStopped = true
    })

    schedulePump()
    return stream
  }

  _selectNextNeighbor(neighborList, neighborOffsets, currentBeat, id, stream) {
    const offset = neighborOffsets[currentBeat] || 0
    const nextBeat = neighborList[offset % neighborList.length]
    neighborOffsets[currentBeat] = (offset + 1) % neighborList.length

    stream.emit('eternalboxJump', {
      id,
      fromBeat: currentBeat,
      toBeat: nextBeat,
      type: 'jump'
    })
    return nextBeat
  }
}
