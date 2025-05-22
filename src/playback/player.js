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

    this.emitEvent = (type, payload = {}) => {
      try {
        session.socket.send(JSON.stringify({ op: 'event', type, guildId, ...payload }))
      } catch {}
    }

    this.waitEvent = (event, filter) =>
      new Promise(resolve => {
        const handler = (_, payload) => {
          if (!filter || filter(payload)) {
            this.connection.off(event, handler)
            resolve(payload)
          }
        }
        this.connection.on(event, handler)
      })

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
    this.connection.on('error', err => this._onError(err))
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
      this.destroy(false)
    } else if (state.status === 'destroyed') {
      this.connection = null
    }
    this._sendUpdate()
  }

  _onPlay(state) {
    if (
      state.status === 'idle' &&
      this.track &&
      [EndReasons.STOPPED, EndReasons.FINISHED, EndReasons.LOAD_FAILED].includes(state.reason)
    ) {
      this.emitEvent(GatewayEvents.TRACK_END, { track: this.track, reason: state.reason })
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
      this.emitEvent(GatewayEvents.TRACK_END, { track: this.track, reason: EndReasons.LOAD_FAILED })
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
    return this.connection?.statistics
      ? this.position + this.connection.statistics.packetsExpected * 20
      : 0
  }

  async _fetchResource(info, urlData, seekMs) {
    const fetched = await this.nodelink.sources.getTrackStream(
      info,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )
    if (fetched.exception) return fetched
    const resource = createAudioResource(fetched.stream, urlData.format)
    this.streamInfo = { url: urlData.url, protocol: urlData.protocol, format: urlData.format }
    return { stream: resource }
  }

  _sendUpdate() {
    if (!this.connection) return
    const pos = this.connection.statistics?.playbackDuration ?? this._realPosition()
    this.emitEvent(GatewayEvents.PLAYER_UPDATE, {
      state: {
        time: Date.now(),
        position: pos,
        connected: this.connStatus === 'connected',
        ping: this.connection.ping ?? 0
      }
    })
  }

  async play({ encoded, info, noReplace = false, startTime = 0, userData = {} }) {
    if (noReplace && this.track) return this.toJSON()
    if (this.track) {
      this.emitEvent(GatewayEvents.TRACK_END, { track: this.track, reason: EndReasons.REPLACED })
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

    if (!this.connection) this._initConnection()

    if (!this.connection.udpInfo?.secretKey)
      await this.waitEvent(
        'stateChange',
        s => s.status === 'connected' && this.connection.udpInfo?.secretKey
      )

    const fetched = await this._fetchResource(info, urlData, startTime)
    if (fetched.exception) {
      this._onError(new Error(fetched.exception.message))
      this.connection.stop(EndReasons.LOAD_FAILED)
      return this.toJSON()
    }

    if (this.connection.audioStream) this.connection.audioStream.destroy()

    const resource = fetched.stream
    if (this.volumePercent !== 100) resource.setVolume(this.volumePercent / 100)
    this.connection.play(resource)

    await this.waitEvent('playerStateChange', s => s.status === 'playing')

    return this.toJSON()
  }

  seek(position) {
    // wait filters
  }

  stop() {
    if (!this.track) return this.toJSON()
    if (this.connection?.audioStream) {
      this.connection.stop(EndReasons.STOPPED)
    } else {
      this.emitEvent(GatewayEvents.TRACK_END, { track: this.track, reason: EndReasons.STOPPED })
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
    this.volumePercent = Math.max(0, Math.min(100, level))
    this.connection?.audioStream?.setVolume(this.volumePercent / 100)
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
