import discordVoice from '@performanc/voice'
import { EndReasons, GatewayEvents } from '../constants.js'
import { SeekeableError } from '@ecliptia/seekeable-node'
import { logger } from '../utils.js'
import {
  createAudioResource,
  createSeekeableAudioResource
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
    this.logger = this.nodelink.logger

    this.track = null
    this.isPaused = false
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
    this.filters = {}
    this.position = 0
    this.connStatus = 'idle'
    this.connection = null
    this.voice = { sessionId: null, token: null, endpoint: null }
    this.streamInfo = null
    this.streamToDestroy = null

    logger(
      'debug',
      'Player',
      `New player created for guild ${this.guildId} in session ${this.session.id}`
    )

    this.emitEvent = (type, payload = {}) => {
      this.nodelink.statsManager.incrementPlaybackEvent(type)

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

    this._lastPosition = 0
    this._stuckTime = 0
    this._lastStreamDataTime = 0
    this._isRecovering = false
    this._initConnection()
  }

  _initConnection() {
    if (this.connection) return
    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      encryption: this.nodelink.options?.audio.encryption
    })
    this.connection.on('stateChange', (_, s) => {
      logger(
        'debug',
        'Player',
        `Voice connection state change for guild ${this.guildId} in session ${this.session.id}: ${s.status}`
      )
      this._onConn(s)
    })
    this.connection.on('playerStateChange', (_, s) => this._onPlay(s))
    this.connection.on('error', (err) => {
      logger(
        'error',
        'Player',
        `Voice connection error for guild ${this.guildId} in session ${this.session.id}:`,
        err
      )
      this._onError(err)
    })
    this.connection.on('audioStream', (audioStream) => {
      audioStream.on('data', () => {
        this._lastStreamDataTime = Date.now()
      })
    })
  }

  _onConn(state) {
    this.connStatus = state.status
    if (state.status === 'connected') {
      logger(
        'info',
        'Player',
        `Voice connection established for guild ${this.guildId} in session ${this.session.id}`
      )
      if (this.track && this.isPaused && this.connection.audioStream) {
        this.isPaused = false
        this.connection.unpause('reconnected')
        logger(
          'debug',
          'Player',
          `Unpaused track on reconnection for guild ${this.guildId}`
        )
      }
    } else if (state.status === 'reconnecting') {
      logger(
        'info',
        'Player',
        `Voice connection is reconnecting for guild ${this.guildId}`
      )
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
    logger(
      'debug',
      'Player',
      `Player state change for guild ${this.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`
    )

    if (state.status === 'playing' && this.streamToDestroy) {
      if (this.streamToDestroy !== this.connection.audioStream) {
        logger(
          'debug',
          'Player',
          `Destroying old stream after seek for guild ${this.guildId}`
        )
        this.streamToDestroy.destroy()
        this.streamToDestroy = null
      }
    }

    if (
      state.status === 'idle' &&
      this.track &&
      [
        EndReasons.STOPPED,
        EndReasons.FINISHED,
        EndReasons.LOAD_FAILED
      ].includes(state.reason)
    ) {
      this.connection.audioStream?.destroy()

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
      if (error.message.includes('ECONNRESET')) {
        logger(
          'warn',
          'Player',
          `Voice connection reset for guild ${this.guildId}. The library will attempt to reconnect.`
        )
        return
      }

      const isStreamError =
        error.message.includes('stream') ||
        error.message.includes('timeout') ||
        error.name === 'AbortError'

      if (isStreamError) {
        logger(
          'warn',
          'Player',
          `Stream error detected for guild ${this.guildId}. Stopping playback.`
        )
        this.stop()
      } else {
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
      fetched.type || urlData.format,
      this.nodelink,
      this.filters
    )
    return { stream: resource }
  }

  _sendUpdate() {
    if (!this.connection || this.isPaused || this.connStatus === 'destroyed')
      return false

    const position = this._realPosition()

    const threshold = this.nodelink.options.trackStuckThresholdMs
    if (threshold > 0) {
      if (this._lastPosition === position) {
        this._stuckTime += this.nodelink.options.playerUpdateInterval
        if (this._stuckTime >= threshold && !this._isRecovering) {
          const stuckTime = this._stuckTime
          this._stuckTime = 0
          logger(
            'warn',
            'Player',
            `Player for guild ${this.guildId} is stuck. Attempting to recover...`,
            {
              lastPosition: this._lastPosition,
              currentPosition: position,
              stuckTime: stuckTime,
              threshold: threshold,
              connStatus: this.connStatus,
              lastStreamDataTime:
                this._lastStreamDataTime > 0
                  ? new Date(this._lastStreamDataTime).toISOString()
                  : 'never',
              statistics: this.connection?.statistics
            }
          )
          this._isRecovering = true

          this.seek(this._lastPosition)
            .then((success) => {
              if (success) {
                logger(
                  'info',
                  'Player',
                  `Player for guild ${this.guildId} recovered successfully.`
                )
              } else {
                logger(
                  'error',
                  'Player',
                  `Player for guild ${this.guildId} recovery failed. Stopping track.`
                )
                this.emitEvent(GatewayEvents.TRACK_STUCK, {
                  guildId: this.guildId,
                  track: this.track,
                  thresholdMs: threshold,
                  reason: 'Recovery attempt failed'
                })
                this.stop()
              }
              this._isRecovering = false
            })
            .catch((err) => {
              logger(
                'error',
                'Player',
                `Player for guild ${this.guildId} recovery attempt threw an error: ${err.message}. Stopping track.`
              )
              this.emitEvent(GatewayEvents.TRACK_STUCK, {
                guildId: this.guildId,
                track: this.track,
                thresholdMs: threshold,
                reason: `Recovery attempt failed: ${err.message}`
              })
              this.stop()
              this._isRecovering = false
            })
        }
      } else {
        this._stuckTime = 0
        this._isRecovering = false
      }
    }

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

  async play({ encoded, info, noReplace = false, startTime = 0, endTime = 0 }) {
    logger('debug', 'Player', `play() called for guild ${this.guildId}`, {
      encoded,
      noReplace,
      startTime,
      endTime,
      track: info
    })

    if (noReplace && this.track) {
      logger(
        'debug',
        'Player',
        `play() aborted for guild ${this.guildId} due to noReplace=true`
      )
      return false
    }

    if (this.track) {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.REPLACED
      })
      this._resetTrack()
    }

    this.track = { encoded, info, endTime }

    const urlData = await this.nodelink.sources.getTrackUrl(info)
    this.streamInfo = { ...urlData, trackInfo: info }
    logger('debug', 'Player', `Got track URL for guild ${this.guildId}`, {
      urlData
    })

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (!this.connection.udpInfo?.secretKey) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )
      await this.waitEvent(
        'stateChange',
        (s) => s.status === 'connected' && this.connection.udpInfo?.secretKey
      )
    }

    if (!this.connection.udpInfo?.secretKey) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(info, urlData, startTime)
    if (fetched.exception) {
      const err = new Error(fetched.exception.message)
      this._onError(err)
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

    logger('debug', 'Player', `Playing resource for guild ${this.guildId}`)
    this.connection.play(resource)
    await this.waitEvent('playerStateChange', (s) => s.status === 'playing')
    return true
  }

  async seek(position, endTime) {
    if (!this.track) return false
    if (!this.track.info.isSeekable && !this.track.info.isStream) return false

    const seekPosition =
      position === null || position === undefined
        ? this._realPosition()
        : position

    if (seekPosition === 0 && this._realPosition() < 1000) {
      logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.')
      return false
    }

    if (
      seekPosition < 0 ||
      (this.track.info.length > 0 && seekPosition > this.track.info.length)
    )
      return false

    const sourceName = this.track.info.sourceName
    const unsupportedSources = ['deezer', 'local']

    let seekPromise
    if (!unsupportedSources.includes(sourceName) && this.streamInfo?.url) {
      seekPromise = this._seekeableSeek(
        seekPosition,
        endTime !== undefined ? endTime : this.track.endTime
      )
    } else {
      seekPromise = this._legacySeek(
        seekPosition,
        endTime !== undefined ? endTime : this.track.endTime
      )
    }

    const result = await seekPromise
    if (result) {
      this.emitEvent(GatewayEvents.SEEK, { position: this.position })
    }
    return result
  }

  async _seekeableSeek(position, endTime) {
    logger(
      'debug',
      'Player',
      `Seeking with Seekeable to ${position}ms for guild ${this.guildId}`
    )
    this.position = position

    try {
      if (this.streamToDestroy) {
        this.streamToDestroy.destroy()
      }
      this.streamToDestroy = this.connection.audioStream

      const url = this.streamInfo.url

      const resource = await createSeekeableAudioResource(
        url,
        position,
        endTime,
        this.nodelink,
        this.filters,
        this // Pass the player object
      )

      if (this.volumePercent !== 100) {
        resource.setVolume(this.volumePercent / 100)
      }
      resource.setFilters(this.filters)

      this.connection.play(resource)

      return true
    } catch (e) {
      if (e instanceof SeekeableError) {
        logger(
          'error',
          'Player',
          `Seekeable seek failed for guild ${this.guildId}: ${e.message} (Code: ${e.code}, URL: ${e.url || 'N/A'}). Falling back to old method.`
        )
        this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
          track: this.track,
          exception: {
            message: e.message,
            severity: 'fault',
            cause: `SeekeableError: ${e.code}`
          }
        })
        this.emitEvent(GatewayEvents.TRACK_END, {
          track: this.track,
          reason: EndReasons.LOAD_FAILED
        })
        return this._legacySeek(position, endTime)
      }
      logger(
        'error',
        'Player',
        `Seekeable seek failed for guild ${this.guildId}: ${e.message}. Falling back to old method.`
      )
      return this._legacySeek(position, endTime)
    }
  }

  async _legacySeek(position, endTime) {
    if (!this.track) return false
    if (position < 0 || position > this.track.info.length) return false

    logger(
      'debug',
      'Player',
      `Seeking with legacy method to ${position}ms for guild ${this.guildId}`
    )

    this.position = position

    await this.play({
      encoded: this.track.encoded,
      info: this.track.info,
      startTime: position,
      endTime: endTime,
      isSeek: true
    })

    return true
  }

  stop() {
    if (!this.track) return false
    if (this.connection && this.connStatus !== 'destroyed') {
      if (this.connection.audioStream) {
        this.connection.stop(EndReasons.STOPPED)
      } else {
        this.emitEvent(GatewayEvents.TRACK_END, {
          track: this.track,
          reason: EndReasons.STOPPED
        })
        this._resetTrack()
      }
    } else {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.STOPPED
      })
      this._resetTrack()
    }
    return true
  }

  pause(shouldPause) {
    if (this.isPaused === shouldPause) return false
    logger(
      'debug',
      'Player',
      `Setting pause to ${shouldPause} for guild ${this.guildId}`
    )
    this.isPaused = shouldPause
    if (this.connection?.audioStream) {
      if (shouldPause) {
        this.connection.pause('requested')
      } else {
        this.connection.unpause('requested')
      }
    }
    this.emitEvent(GatewayEvents.PAUSE, { paused: this.isPaused })
    return true
  }

  volume(level) {
    logger(
      'debug',
      'Player',
      `Setting volume to ${level} for guild ${this.guildId}`
    )
    this.volumePercent = Math.max(0, Math.min(1000, level))
    this.connection?.audioStream?.setVolume(this.volumePercent / 100)
    this.emitEvent(GatewayEvents.VOLUME_CHANGED, { volume: this.volumePercent })
    return true
  }

  setFilters(filters) {
    if (!this.track) return false
    logger(
      'debug',
      'Player',
      `Applying filters for guild ${this.guildId}:`,
      filters
    )

    if (filters.filters && Object.keys(filters.filters).length === 0) {
      this.filters = {}
    } else {
      const newFilterSettings = JSON.parse(
        JSON.stringify(this.filters.filters || {})
      )

      for (const key in filters.filters) {
        if (
          filters.filters[key] === null ||
          filters.filters[key] === undefined
        ) {
          delete newFilterSettings[key]
        } else {
          newFilterSettings[key] = {
            ...(newFilterSettings[key] || {}),
            ...filters.filters[key]
          }
        }
      }
      this.filters = { ...this.filters, filters: newFilterSettings }
    }

    if (this.connection?.audioStream) {
      this.connection.audioStream.setFilters(this.filters)
    }

    this.emitEvent(GatewayEvents.FILTERS_CHANGED, { filters: this.filters })

    return true
  }

  updateVoice({ sessionId, token, endpoint } = {}) {
    if (!sessionId || !token || !endpoint) return
    logger('debug', 'Player', `Updating voice state for guild ${this.guildId}`)
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
    logger('debug', 'Player', `Destroying player for guild ${this.guildId}`)
    if (this.connection) {
      try {
        if (this.connection.audioStream) {
          this.connection.stop(EndReasons.CLEANUP)
        }
        this.connection.destroy()
        this.connection = null
      } catch (err) {
        logger(
          'error',
          'internal',
          `Failed to destroy connection for guild ${this.guildId}: ${err.message}`
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
