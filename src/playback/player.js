import discordVoice from '@performanc/voice'
import { EndReasons, GatewayEvents } from '../constants.js'
import { logger } from '../utils.js'
import {
  createAudioResource,
  createFFmpegAudioResource
} from './streamProcessor.js'

export class Player {
  constructor(options) {
    if (
      !options.nodelink ||
      !options.session?.socket ||
      !options.session.userId ||
      !options.guildId
    )
      throw new Error('Missing required options')

    this.nodelink = options.nodelink
    this.session = options.session
    this.guildId = options.guildId

    this.track = null
    this.isPaused = false
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
    this.filters = {}
    this.position = 0
    this.connStatus = 'idle'
    this.connection = null
    this.voice = { sessionId: null, token: null, endpoint: null }
    this.streamInfo = null

    this.emitEvent = (type, payload = {}) => {
      try {
        this.session.socket.send(
          JSON.stringify({
            op: 'event',
            type,
            guildId: this.guildId,
            ...payload
          })
        )
      } catch {}
    }

    this.waitEvent = (event, filter) =>
      new Promise((resolve) => {
        const handler = (_, payload) => {
          if (!filter || filter(payload)) {
            this.connection.off(event, handler)
            resolve(payload)
          }
        }
        this.connection.on(event, handler)
      })

    this._lastPosition = null
    this._stuckCount = 0
    this._initConnection()
  }

  _initConnection() {
    if (this.connection) return
    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      encryption: this.nodelink.options?.audio.encryption
    })
    this.connection.on('stateChange', (_, s) => this._onConn(s))
    this.connection.on('playerStateChange', (_, s) => this._onPlay(s))
    this.connection.on('error', (err) => this._onError(err))
  }

  _onConn(state) {
    this.connStatus = state.status
    if (state.status === 'connected') {
      if (this.track && this.isPaused && this.connection.audioStream) {
        this.isPaused = false
        this.connection.unpause('reconnected')
      }
    } else if (state.status === 'disconnected') {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: state.code,
        reason: state.closeReason,
        byRemote: true
      })
    } else if (state.status === 'destroyed') {
      this.connection = null
    }
    this._sendUpdate()
  }

  _onPlay(state) {
    if (
      state.status === 'idle' &&
      this.track &&
      [
        EndReasons.STOPPED,
        EndReasons.FINISHED,
        EndReasons.LOAD_FAILED
      ].includes(state.reason)
    ) {
      this._stopUpdater()
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: state.reason
      })
      this._resetTrack()
    } else if (
      state.status === 'playing' &&
      this.track &&
      ['requested', 'reconnected'].includes(state.reason)
    ) {
      this.emitEvent(GatewayEvents.TRACK_START, { track: this.track })
      this.isPaused = false
    } else if (state.status === 'paused') {
      this.isPaused = true
    }
  }

  _onError(error) {
    if (this.track) {
      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: error.message,
          severity: 'fault',
          cause: `${error.name}: ${error.message}`
        }
      })
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.LOAD_FAILED
      })
      this._resetTrack()
    }
  }

  _resetTrack() {
    this.track = null
    this.isPaused = false
    this.position = 0
  }

  _realPosition() {
    const timescale = this.filters.filters?.timescale || {
      speed: 1.0,
      rate: 1.0
    }
    const playbackSpeed = (timescale.speed || 1.0) * (timescale.rate || 1.0)

    return this.connection?.statistics
      ? this.position +
          this.connection.statistics.packetsExpected * 20 * playbackSpeed
      : 0
  }

  async _fetchResource(info, urlData, startTime) {
    if (startTime)
      urlData.additionalData = { startTime, ...urlData.additionalData }

    const track = urlData?.newTrack ? urlData?.newTrack?.info : info
    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )
    if (fetched.exception) return fetched
    const resource = createAudioResource(
      fetched.stream,
      urlData.format,
      this.nodelink,
      this.filters
    )
    return { stream: resource }
  }

  _startUpdater() {
    if (this._updater) return
    this._updater = setInterval(() => {
      if (!this.track || this.isPaused) return
      if (!this._sendUpdate()) this._stopUpdater()
    }, this.nodelink.options?.playerUpdateInterval ?? 2000)
  }

  _stopUpdater() {
    if (this._updater) {
      clearInterval(this._updater)
      this._updater = null
    }
  }

  _sendUpdate() {
    if (!this.connection || this.isPaused) return false

    const position = this._realPosition()

    this._lastPosition = position

    this.session.socket.send(
      JSON.stringify({
        op: GatewayEvents.PLAYER_UPDATE,
        guildId: this.guildId,
        state: {
          time: Date.now(),
          position,
          connected: this.connStatus === 'connected',
          ping: this.connection.ping ?? 0
        }
      })
    )
    return true
  }

  async play({
    encoded,
    info,
    noReplace = false,
    startTime = 0,
    isSeek = false
  }) {
    if (noReplace && this.track && !isSeek) {
      return false
    }

    if (this.track && !isSeek) {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.REPLACED
      })
      this._resetTrack()
    }

    this.track = { encoded, info }

    const urlData = await this.nodelink.sources.getTrackUrl(info)
    this.streamInfo = { ...urlData, trackInfo: info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      if (!isSeek) {
        logger(
          'player',
          'error',
          `Load failed for track from source "${info.sourceName}": ${err.message}`
        )
        this._onError(err)
      } else {
        logger('player', 'error', `Seek failed on getTrackUrl: ${err.message}`)
      }
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (!this.connection.udpInfo?.secretKey) {
      await this.waitEvent(
        'stateChange',
        (s) => s.status === 'connected' && this.connection.udpInfo?.secretKey
      )
    }

    const fetched = await this._fetchResource(info, urlData, startTime)
    if (fetched.exception) {
      const err = new Error(fetched.exception.message)
      if (!isSeek) {
        logger(
          'player',
          'error',
          `Load failed while fetching resource from source "${info.sourceName}": ${err.message}`
        )
        this._onError(err)
      } else {
        logger('player', 'error', `Seek fetch failed: ${err.message}`)
      }
      return false
    }

    if (this.connection.audioStream) {
      this.connection.audioStream?.destroy()
    }

    const resource = fetched.stream
    if (this.volumePercent !== 100) {
      resource.setVolume(this.volumePercent / 100)
    }

    this.setFilters(this.filters)

    this.connection.play(resource)
    await this.waitEvent('playerStateChange', (s) => s.status === 'playing')
    this._startUpdater()
    return true
  }

  async seek(position) {
    if (!this.track) return false
    if (!this.track.info.isSeekable && !this.track.info.isStream) return false
    if (
      position < 0 ||
      position > this.track.info.length ||
      (position == 0 && position == this.position)
    )
      return false

    const sourceName = this.track.info.sourceName
    const unsupportedSources = ['deezer', 'local']

    if (!unsupportedSources.includes(sourceName) && this.streamInfo?.url) {
      return this._ffmpegSeek(position)
    } else {
      return this._legacySeek(position)
    }
  }

  async _ffmpegSeek(position) {
    logger('player', 'info', `Seeking with FFmpeg to ${position}ms`)
    this.position = position

    try {
      const url = this.streamInfo.url
      const format = this.streamInfo.format

      const resource = createFFmpegAudioResource(
        url,
        format,
        position,
        this.nodelink,
        this.filters
      )

      if (this.volumePercent !== 100) {
        resource.setVolume(this.volumePercent / 100)
      }
      resource.setFilters(this.filters)

      this.connection.play(resource)

      this._startUpdater()
      return true
    } catch (e) {
      logger(
        'player',
        'error',
        `FFmpeg seek failed: ${e.message}. Falling back to old method.`
      )
      return this._legacySeek(position)
    }
  }

  async _legacySeek(position) {
    if (!this.track) return false
    if (position < 0 || position > this.track.info.length) return false

    logger('player', 'info', `Seeking to ${position}ms`)

    this.position = position

    await this.play({
      encoded: this.track.encoded,
      info: this.track.info,
      startTime: position,
      isSeek: true
    })

    return true
  }

  stop() {
    if (!this.track) return false
    if (this.connection?.audioStream) {
      this.connection.stop(EndReasons.STOPPED)
    } else {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.STOPPED
      })
      this._resetTrack()
    }
    this._stopUpdater()
    return true
  }

  pause(shouldPause) {
    if (this.isPaused === shouldPause) return false
    this.isPaused = shouldPause
    if (this.connection?.audioStream) {
      if (shouldPause) {
        this.connection.pause('requested')
        this._stopUpdater()
      } else {
        this.connection.unpause('requested')
        this._startUpdater()
      }
    }
    return true
  }

  volume(level) {
    this.volumePercent = Math.max(0, Math.min(100, level))
    this.connection?.audioStream?.setVolume(this.volumePercent / 100)
    return true
  }

  setFilters(filters) {
    if (!this.track) return false

    const newFilterSettings = JSON.parse(
      JSON.stringify(this.filters.filters || {})
    )
    for (const key in filters.filters) {
      newFilterSettings[key] = {
        ...(newFilterSettings[key] || {}),
        ...filters.filters[key]
      }
    }

    this.filters = { ...this.filters, filters: newFilterSettings }

    if (this.connection?.audioStream) {
      this.connection.audioStream.setFilters(this.filters)
    }

    return true
  }

  updateVoice({ sessionId, token, endpoint } = {}) {
    if (!sessionId || !token || !endpoint) return
    if (!this.connection) this._initConnection()
    this.connection.voiceStateUpdate({ session_id: sessionId })
    this.connection.voiceServerUpdate({ token, endpoint })
    this.connection.connect(() => {
      if (this.connection.audioStream && !this.isPaused) {
        this.connection.unpause('reconnected')
      }
    })

    this.voice = { sessionId, token, endpoint }
  }

  destroy(emitClose = true) {
    if (this.connection) {
      try {
        this.connection.stop(EndReasons.CLEANUP)
        this.connection.destroy()
        this.connection = null
      } catch (err) {
        logger(
          'error',
          'internal',
          `Failed to destroy connection: ${err.message}`
        )
      }
    }
    if (emitClose) {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: 1000,
        reason: 'destroyed by client',
        byRemote: false
      })
    }
    this._resetTrack()
    this._stopUpdater()
    this.connStatus = 'destroyed'
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
  }

  toJSON() {
    return {
      guildId: this.guildId,
      track: this.track,
      volume: this.volumePercent,
      paused: this.isPaused,
      filters: this.filters,
      state: {
        time: Date.now(),
        position: this._realPosition(),
        connected: this.connStatus === 'connected',
        ping: this.connection?.ping ?? 0
      },
      voice: { ...this.voice }
    }
  }
}
