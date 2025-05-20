import discordVoice from '@performanc/voice'
import { createAudioResource } from './streamProcessor.js'
import { GatewayEvents, EndReasons } from '../constants.js'

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

    this.streamInfo = { url: null, protocol: null, format: null }
    this.position = 0
    this.connStatus = 'idle'
    this.connection = null
    this.voice = { sessionId: null, token: null, endpoint: null }

    this.emitEvent = (eventType, payload = {}) => {
      try {
        this.session.socket.send(
          JSON.stringify({
            op: 'event',
            type: eventType,
            guildId: this.guildId,
            ...payload
          })
        )
      } catch {}
    }

    this._initConnection()
  }

  _initConnection() {
    if (this.connection) return

    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      encryption: this.nodelink?.options?.audio.encryption
    })

    this.connection.on('stateChange', (_, newState) => this._onConn(newState))
    this.connection.on('playerStateChange', (_, playerState) => this._onPlay(playerState))
    this.connection.on('error', error => this._onError(error))
  }

  _onConn(newState) {
    this.connStatus = newState.status
    switch (newState.status) {
      case 'connected':
        if (this.track && this.isPaused && this.connection.audioStream) {
          this.isPaused = false
          this.connection.unpause('reconnected')
        }
        this._sendUpdate()
        break
      case 'disconnected':
        this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
          code: newState.code,
          reason: newState.closeReason,
          byRemote: true
        })
        this.destroy(false)
        break
      case 'destroyed':
        this.connection = null
        break
      default:
        this._sendUpdate()
    }
  }

  _onPlay(playerState) {
    switch (playerState.status) {
      case 'idle':
        if (
          this.track &&
          [EndReasons.STOPPED, EndReasons.FINISHED, EndReasons.LOAD_FAILED].includes(
            playerState.reason
          )
        ) {
          this.emitEvent(GatewayEvents.TRACK_END, {
            track: this.track,
            reason: playerState.reason
          })
          this._resetTrack()
        }
        break

      case 'playing':
        if (this.track && ['requested', 'reconnected'].includes(playerState.reason)) {
          this.emitEvent(GatewayEvents.TRACK_START, { track: this.track })
        }
        this.isPaused = false
        break
      case 'paused':
        this.isPaused = true
        break
    }
    this._sendUpdate()
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
    this._sendUpdate()
  }

  _resetTrack() {
    this.track = null
    this.isPaused = false
    this.streamInfo = { url: null, protocol: null, format: null }
    this.position = 0
  }

  _realPosition() {
    if (!this.connection?.statistics) return 0
    return this.position + this.connection.statistics.packetsExpected * 20
  }

  async _fetchResource(trackInfo, urlData, seekMs = 0) {
    const fetchedStream = await this.nodelink.sources.getTrackStream(
      trackInfo,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )

    if (fetchedStream.exception) return fetchedStream

    const audioResource = createAudioResource(fetchedStream.stream, urlData.format)
    this.streamInfo = {
      url: urlData.url,
      protocol: urlData.protocol,
      format: urlData.format
    }

    return { stream: audioResource }
  }

  _sendUpdate() {
    if (!this.connection) return
    const currentPosition = this.connection.statistics?.playbackDuration ?? this._realPosition()
    this.emitEvent(GatewayEvents.PLAYER_UPDATE, {
      state: {
        time: Date.now(),
        position: currentPosition,
        connected: this.connStatus === 'connected',
        ping: this.connection.ping ?? 0
      }
    })
  }

  async play({ encoded, info, noReplace = false, startTime = 0, userData = {} }) {
    if (noReplace && this.track) return this.toJSON()

    if (this.track) {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.REPLACED
      })
      this._resetTrack()
    }

    this.track = { encoded, info, userData }
    this.isPaused = false
    this.position = startTime

    const urlData = await this.nodelink.sources.getTrackUrl(info)
    if (urlData.exception) {
      this._onError(new Error(urlData.exception.message))
      this.connection?.stop(EndReasons.LOAD_FAILED)
      return this.toJSON()
    }

    if (!this.connection) {
      this._onError(new Error('Voice connection missing'))
      return this.toJSON()
    }

    await new Promise(resolve => {
      const onConnected = (_, state) => {
        if (state.status === 'connected' && this.connection.udpInfo?.secretKey) {
          this.connection.off('stateChange', onConnected)
          resolve()
        }
      }
      this.connection.on('stateChange', onConnected)
    })

    const fetched = await this._fetchResource(info, urlData, startTime)
    if (fetched.exception) {
      this._onError(new Error(fetched.exception.message))
      this.connection?.stop(EndReasons.LOAD_FAILED)
      return this.toJSON()
    }

    const resource = fetched.stream
    if (this.volumePercent !== 100) resource.setVolume(this.volumePercent / 100)
    this.connection.play(resource)

    await new Promise(resolve => {
      const onPlay = (_, state) => {
        if (state.status === 'playing') {
          this.connection.off('playerStateChange', onPlay)
          resolve()
        }
      }
      this.connection.on('playerStateChange', onPlay)
    })

    return this.toJSON()
  }

  stop() {
    if (!this.track) return this.toJSON()

    if (this.connection?.audioStream) {
      this.connection.stop(EndReasons.STOPPED)
    } else {
      this.emitEvent(GatewayEvents.TRACK_END, {
        track: this.track,
        reason: EndReasons.STOPPED
      })
      this._resetTrack()
    }

    return this.toJSON()
  }

  pause(shouldPause) {
    if (this.isPaused === shouldPause) return this.toJSON()

    this.isPaused = shouldPause
    if (this.connection?.audioStream) {
      shouldPause ? this.connection.pause('requested') : this.connection.unpause('requested')
    }

    return this.toJSON()
  }

  volume(level) {
    const clampedVolume = Math.max(0, Math.min(100, level))
    this.volumePercent = clampedVolume
    this.connection?.audioStream?.setVolume(clampedVolume / 100)
    return this.toJSON()
  }

  async seek(positionMs) {
    // not implemented yet, wait filters
    return this.toJSON()
  }

  updateVoice({ sessionId, token, endpoint } = {}) {
    if (!sessionId || !token || !endpoint) return
    if (!this.connection) this._initConnection()

    this.connection.voiceStateUpdate({ session_id: sessionId })
    this.connection.voiceServerUpdate({ token, endpoint })
    this.connection.connect()
    this.voice = { sessionId, token, endpoint }
  }

  destroy(emitClose = true) {
    if (this.connection) {
      this.connection.stop(EndReasons.CLEANUP)
      this.connection.destroy()
      this.connection = null
    }
    this._resetTrack()
    this.connStatus = 'destroyed'
    this.volumePercent = this.nodelink.options?.initialVolume ?? 100
    this.voice = { sessionId: null, token: null, endpoint: null }

    if (emitClose) {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: 1000,
        reason: 'destroyed by client',
        byRemote: false
      })
    }
  }

  toJSON() {
    return {
      guildId: this.guildId,
      track: this.track,
      volume: this.volumePercent,
      paused: this.isPaused,
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
