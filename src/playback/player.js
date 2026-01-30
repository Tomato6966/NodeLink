import { SeekError } from '@ecliptia/seekable-stream'
import discordVoice from '@performanc/voice'
import { EndReasons, GatewayEvents } from '../constants.js'
import { logger } from '../utils.js'

let createAudioResource
let createSeekeableAudioResource

async function getStreamProcessor() {
  if (createAudioResource) return

  const processor = await import('./processing/streamProcessor.js')
  createAudioResource = processor.createAudioResource
  createSeekeableAudioResource = processor.createSeekeableAudioResource
}

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
    this.holoTrack = null
    this.nextTrack = null
    this.nextResource = null
    this.isPaused = false
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
    this.filters = {}
    this.position = 0
    this.connStatus = 'idle'
    this.connection = null
    this.voice = {
      sessionId: null,
      token: null,
      endpoint: null,
      channelId: null
    }
    this.streamInfo = null
    this.lastManualReconnect = 0
    this.audioMixer = null
    this._initAudioMixer()
    this.fading = this.nodelink.options?.audio?.fading
    this._fadeTimers = { trackEnd: null, pause: null, stop: null }
    this._isResuming = false
    this._pendingTrackStartFade = false
    this._lyricsBasePosition = 0
    this._lyricsBasePackets = 0
    this._lyricsMarkerTimer = null

    this.isLyricsSubscribed = false
    this.currentLyrics = null
    this.lyricsLineIndex = -1
    this.skipTrackSource = false

    logger(
      'debug',
      'Player',
      `New player created for guild ${this.guildId} in session ${this.session.id}`
    )

    this.emitEvent = (type, payload = {}) => {
      this.nodelink.statsManager.incrementPlaybackEvent(type)
      const eventData = JSON.stringify({
        op: 'event',
        type,
        guildId: this.guildId,
        ...payload
      })

      if (this.session.isPaused) {
        this.session.eventQueue.push(eventData)
        logger(
          'debug',
          'Player',
          `Queued event ${type} for paused session ${this.session.id}`
        )
        return
      }

      try {
        this.session.socket.send(eventData)
      } catch {}
    }

    this.emitEvent(GatewayEvents.PLAYER_CREATED, {
      guildId: this.guildId,
      player: this.toJSON()
    })

    this.waitEvent = (
      event,
      filter,
      timeout = this.nodelink.options.eventTimeoutMs ?? 15000
    ) =>
      new Promise((resolve, reject) => {
        const handler = (_, payload) => {
          if (!filter || filter(payload)) {
            clearTimeout(timeoutId)
            this.connection?.off(event, handler)
            resolve(payload)
          }
        }

        const timeoutId = setTimeout(() => {
          this.connection?.off(event, handler)
          reject(
            new Error(
              `Event ${event} timed out after ${timeout}ms for guild ${this.guildId}`
            )
          )
        }, timeout)

        this.connection.on(event, handler)
      })

    this._lastPosition = 0
    this._stuckTime = 0
    this._lastStreamDataTime = 0
    this._isRecovering = false
    this.destroying = false
    this.isUpdatingTrack = false
    this._initConnection()
  }

  async _initAudioMixer() {
    const { AudioMixer } = await import('./processing/AudioMixer.js')
    this.audioMixer = new AudioMixer(
      this.nodelink.options?.mix ?? {
        enabled: true,
        defaultVolume: 0.8,
        maxLayersMix: 5,
        autoCleanup: true
      }
    )

    this.audioMixer.on('mixStarted', (data) => {
      this.emitEvent(GatewayEvents.MIX_STARTED, {
        mixId: data.id,
        track: data.track,
        volume: data.volume
      })
    })

    this.audioMixer.on('mixEnded', (data) => {
      this.emitEvent(GatewayEvents.MIX_ENDED, {
        mixId: data.id,
        reason: data.reason
      })
    })

    this.audioMixer.on('mixError', (data) => {
      logger(
        'error',
        'Player',
        `Mix error for ${data.id}: ${data.error.message}`
      )
    })
  }

  _initConnection() {
    if (this.connection || this.destroying) return
    this.connection = discordVoice.joinVoiceChannel({
      guildId: this.guildId,
      userId: this.session.userId,
      channelId: this.voice.channelId || this.guildId, // dave somehow accepted guildId lol
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
        if (this.isLyricsSubscribed && !this.isPaused && this.track) {
          this._syncLyrics()
        }
      })
    })

    if (this.nodelink.voiceRelay?.attach) {
      this.nodelink.voiceRelay.attach(this.connection, this.guildId)
    }
  }

  _onConn(state) {
    if (this.destroying) return
    this.connStatus = state.status
    if (state.status === 'connected') {
      logger(
        'info',
        'Player',
        `Voice connection established for guild ${this.guildId} in session ${this.session.id}`
      )
      this.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
        guildId: this.guildId,
        voice: { ...this.voice }
      })
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
      this.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
        guildId: this.guildId,
        voice: { ...this.voice }
      })
    } else if (state.status === 'disconnected') {
      this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
        code: state.code,
        reason: state.closeReason,
        byRemote: true
      })
    } else if (state.status === 'destroyed') {
      logger(
        'warn',
        'Player',
        `Voice connection destroyed for guild ${this.guildId}`
      )
    }
    this._sendUpdate()
  }

  _onPlay(state) {
    if (this.destroying) return
    logger(
      'debug',
      'Player',
      `Player state change for guild ${this.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`
    )

    if (
      state.status === 'idle' &&
      this.track &&
      [
        EndReasons.STOPPED,
        EndReasons.FINISHED,
        EndReasons.LOAD_FAILED
      ].includes(state.reason)
    ) {
      if (state.reason === EndReasons.FINISHED && this.nextResource) {
        const resource = this.nextResource
        const nextTrack = this.nextTrack

        this._emitTrackEnd(EndReasons.GAPLESS)

        this.track = nextTrack
        this.nextTrack = null
        this.nextResource = null

        this.position = 0
        this._lyricsBasePosition = 0
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0

        this.connection.play(resource)

        return
      }

      if ((this.isUpdatingTrack || this._isSeeking) && state.reason === 'finished') {
        logger(
          'debug',
          'Player',
          `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.guildId}.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Track ended for guild ${this.guildId}. Reason: ${state.reason}. Current position: ${this.position}`
      )
      this.connection.audioStream?.destroy()

      this._emitTrackEnd(state.reason)
      this._resetTrack()
    } else if (
      state.status === 'playing' &&
      this.track &&
      !this._isSeeking &&
      ['requested', 'reconnected'].includes(state.reason)
    ) {
      const wasResuming = this._isResuming
      this._isResuming = false
      this.isPaused = false

      if (!wasResuming && !this._isRestoring) {
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0
        this._fading('trackStart')
        this._emitTrackStart()
      }
    } else if (state.status === 'paused') {
      this.isPaused = true
    }
  }

  _onError(error) {
    if (this.destroying) return
    if (this.track) {
      let severity = 'fault'
      let cause = 'UNKNOWN_ERROR'
      let shouldStop = true
      logger(
        'debug',
        'Player',
        `Handling player error for guild ${this.guildId}: ${error.message}`
      )

      if (error.message.includes('ECONNRESET')) {
        const now = Date.now()
        const reconnectCooldown = 5000

        if (now - (this.lastManualReconnect || 0) < reconnectCooldown) {
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Manual reconnect on cooldown. Relying on library.`
          )
        } else {
          this.lastManualReconnect = now
          logger(
            'warn',
            'Player',
            `Voice connection reset for guild ${this.guildId}. Attempting to manually reconnect.`
          )
          this.updateVoice(this.voice, true)
        }

        severity = 'suspicious'
        cause = 'VOICE_CONNECTION_RESET'
        shouldStop = false
      } else if (
        error.message.includes('stream') ||
        error.message.includes('timeout') ||
        error.name === 'AbortError'
      ) {
        logger(
          'warn',
          'Player',
          `Stream error detected for guild ${this.guildId}. Stopping playback.`
        )
        severity = 'common'
        cause = 'STREAM_ERROR'
        shouldStop = true
      } else if (error instanceof SeekError) {
        logger(
          'error',
          'Player',
          `Seek error for guild ${this.guildId}: ${error.message}. Stopping playback.`
        )
        severity = 'fault'
        cause = 'SEEK_ERROR'
        shouldStop = true
      } else {
        logger(
          'error',
          'Player',
          `Unhandled player error for guild ${this.guildId}:`,
          error
        )
        severity = 'fault'
        cause = `${error.name || 'Error'}: ${error.message}`
        shouldStop = true
      }

      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: error.message,
          severity: severity,
          cause: cause
        }
      })

      if (shouldStop) {
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        this.stop()
      }
    }
  }

  _resetTrack() {
    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
    }

    this.track = null
    this.holoTrack = null
    this.isPaused = false
    this.position = 0
    this.currentLyrics = null
    this.lyricsLineIndex = -1
    this._fading('reset')
    this._lyricsBasePosition = 0
    this._lyricsBasePackets = this.connection?.statistics?.packetsExpected ?? 0
    if (this._lyricsMarkerTimer) {
      clearTimeout(this._lyricsMarkerTimer)
      this._lyricsMarkerTimer = null
    }
  }

  async _emitTrackStart() {
    const trackToEmit = await this._resolveTrackForEvent(this.track)
    this.holoTrack = trackToEmit

    this.emitEvent(GatewayEvents.TRACK_START, {
      track: trackToEmit,
      playingQuality: this.streamInfo?.format?.itag || null
    })

    if (trackToEmit?.info?.sourceName === 'eternalbox') {
      const info = trackToEmit.info
      const pluginInfo = trackToEmit.pluginInfo || {}
      const links = {
        jukeboxPage: `https://eternalboxmirror.xyz/jukebox_go.html?id=${info.identifier}`,
        analysisUrl: pluginInfo.analysisUrl || null,
        streamUrl: pluginInfo.streamUrl || null,
        ogAudioSource: pluginInfo.ogAudioSource || null,
        spotifyUrl: pluginInfo.spotify?.url || info.uri || null
      }

      this.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
        track: trackToEmit,
        eternalbox: {
          id: info.identifier,
          service: pluginInfo.service || null,
          analysisSummary: pluginInfo.analysisSummary || null,
          spotify: pluginInfo.spotify || null,
          links
        }
      })
    }

    if (this.isLyricsSubscribed) {
      this._loadLyrics()
    }
  }

  _emitTrackEnd(reason) {
    const trackToEmit = this.holoTrack || this.track
    this.emitEvent(GatewayEvents.TRACK_END, {
      track: trackToEmit,
      reason: reason
    })

    if (this.audioMixer?.autoCleanup) {
      this.audioMixer.clearLayers('MAIN_ENDED')
    }
  }

  async _resolveTrackForEvent(track) {
    if (!this.nodelink.options.enableHoloTracks) {
      return track
    }

    try {
      const source = this.nodelink.sources.getSource(track.info.sourceName)
      if (source && typeof source.resolveHoloTrack === 'function') {
        const holoTrack = await source.resolveHoloTrack(track, {
          fetchChannelInfo: this.nodelink.options.fetchChannelInfo,
          resolveExternalLinks: this.nodelink.options.resolveExternalLinks
        })
        return holoTrack || track
      }
    } catch (err) {
      logger('warn', 'Player', `Failed to resolve Holo track: ${err.message}`)
    }

    return track
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
    await getStreamProcessor()

    const additionalData = { ...urlData.additionalData }
    if (startTime !== undefined) additionalData.startTime = startTime

    urlData.additionalData = {
      ...urlData.additionalData,
      positionCallback: () => this._realPosition()
    }

    const track = urlData?.newTrack ? urlData?.newTrack?.info : info
    const fetched = await this.nodelink.sources.getTrackStream(
      track,
      urlData.url,
      urlData.protocol,
      additionalData
    )
    if (fetched.exception) return fetched
    if (fetched.stream?.on) {
      fetched.stream.on('eternalboxJump', (data) => {
        this.emitEvent(GatewayEvents.ETERNALBOX_JUMP, {
          track: this.holoTrack || this.track,
          eternalbox: data
        })
      })
      fetched.stream.on('icyMetadata', (data) => {
        this.emitEvent(GatewayEvents.STREAM_METADATA, {
          track: this.holoTrack || this.track,
          stream: data
        })
      })
    }
    const resource = createAudioResource(
      fetched.stream,
      fetched.type || urlData.format,
      this.nodelink,
      this.filters,
      this.volumePercent / 100,
      this.audioMixer
    )
    return { stream: resource }
  }

  _sendUpdate() {
    if (
      !this.connection ||
      this.isPaused ||
      this.connStatus === 'destroyed' ||
      this.destroying
    )
      return false

    const position = this._realPosition()

    const threshold = this.nodelink.options.trackStuckThresholdMs
    if (threshold > 0 && !this.isUpdatingTrack && this.track) {
      if (this._lastPosition === position) {
        this._stuckTime += this.nodelink.options.playerUpdateInterval
        if (
          this._stuckTime >= threshold &&
          !this._isRecovering &&
          this.connStatus === 'connected'
        ) {
          const stuckTime = this._stuckTime
          this._stuckTime = 0

          if (this.streamInfo?.format === 'mp4') {
            logger(
              'error',
              'Player',
              `Player for guild ${this.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Playback of MP4 track is stuck'
            })
            this.stop()
            return false
          }

          if (!this.track.info.isSeekable) {
            logger(
              'warn',
              'Player',
              `Player for guild ${this.guildId} is stuck on a non-seekable track. Stopping track.`
            )
            this.emitEvent(GatewayEvents.TRACK_STUCK, {
              guildId: this.guildId,
              track: this.track,
              thresholdMs: threshold,
              reason: 'Track is not seekable'
            })
            this.stop()
            return false
          }

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
    this._syncLyrics()

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

  async _startPlayback(startTime = 0) {
    if (!this.track) return false

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, null, this._isRecovering)
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }
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

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )

      await this.waitEvent(
        'stateChange',
        (s) => s.status === 'connected' && this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'error',
        'Player',
        `Voice connection for guild ${this.guildId} is not ready, cannot start playback.`
      )
      this._onError(new Error('Voice connection is not ready.'))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      startTime
    )
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
    this._lyricsBasePosition = startTime
    this._lyricsBasePackets =
      this.connection?.statistics?.packetsExpected ?? 0
    this._fading('trackStartArm', { resource })
    this._fading('trackEndSchedule', { startPosition: startTime || 0 })

    this.setFilters(this.filters)

    logger('debug', 'Player', `Playing resource for guild ${this.guildId}`)
    this._stuckTime = 0
    this.connection.play(resource)
    await this.waitEvent('playerStateChange', (s) => s.status === 'playing')
    return true
  }

  async play({
    encoded,
    info,
    userData,
    audioTrackId,
    noReplace = false,
    startTime,
    endTime = 0
  }) {
    return new Promise((resolve) => {
      this.isUpdatingTrack = true

      try {
        if (this.destroying) {
          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} because player is destroying`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }
        logger('debug', 'Player', `play() called for guild ${this.guildId}`, {
          encoded,
          noReplace,
          startTime,
          endTime,
          track: info
        })

        if (noReplace && this.track && this.connection?.audioStream) {
          logger(
            'debug',
            'Player',
            `play() aborted for guild ${this.guildId} due to noReplace=true and player is active`
          )
          this.isUpdatingTrack = false
          return resolve(false)
        }

        if (this.track) {
          this._emitTrackEnd(EndReasons.REPLACED)
        }

        this.track = { encoded, info, endTime, userData, audioTrackId }
        this._fading('reset')

        if (!this.voice.endpoint || !this.voice.token) {
          logger(
            'debug',
            'Player',
            `No voice state for guild ${this.guildId}, track is enqueued and will play when voice state is provided.`
          )
          this.isUpdatingTrack = false
          return resolve(true)
        }

        console.log(startTime)

        this._startPlayback(
          startTime !== undefined
            ? startTime === 0 && this.position < 1000
              ? 0
              : startTime
            : 0
        )
          .catch((err) => this._onError(err))
          .finally(() => {
            this.isUpdatingTrack = false
          })

        return resolve(true)
      } catch (e) {
        this.isUpdatingTrack = false
        this._onError(e)
        return resolve(false)
      }
    })
  }

  async seek(position, endTime) {
    if (this.destroying || !this.track) return false
    if (!this.track.info.isSeekable && !this.track.info.isStream) return false

    const seekPosition = position ?? this._realPosition()

    if (
      seekPosition === 0 &&
      !this._isRecovering &&
      this._realPosition() < 2000
    ) {
      logger('debug', 'Player', 'Ignoring seek to 0 as track has just started.')

      return false
    }

    if (
      seekPosition < 0 ||
      (this.track.info.length > 0 && seekPosition > this.track.info.length)
    )
      return false
    console.log(seekPosition)
    this._isSeeking = true
    try {
      const sourceName = this.track.info.sourceName
      const unsupportedSources = ['local']

      let seekPromise
      if (!this.streamInfo?.url) {
        logger(
          'debug',
          'Player',
          'No stream info URL available for seek. awaiting getTrackUrl.'
        )
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        await sleep(1600)
        if (!this.streamInfo?.url) {
          logger(
            'debug',
            'Player',
            'Still no stream info URL available for seek.'
          )
          if (this.track) {
            const trackInfo = {
              ...this.track.info,
              audioTrackId: this.track.audioTrackId
            }
            const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
            if (!this.track) return false
            this.streamInfo = { ...urlData, trackInfo: this.track.info }
            logger(
              'debug',
              'Player',
              'Fetched stream info URL for seek after wait.'
            )
          }
        } else {
          logger(
            'debug',
            'Player',
            'Stream info URL became available during wait.'
          )
        }
      }

      const source = this.nodelink.sources.getSource(sourceName)
      const canNativeSeek = sourceName === 'deezer' || (source && typeof source.loadStream === 'function')

      if (this.streamInfo?.protocol === 'sabr') {
        seekPromise = this._seekUsingSource(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else if (!unsupportedSources.includes(sourceName) && this.streamInfo?.url && sourceName !== 'deezer' && this.streamInfo.protocol !== 'hls') {
        seekPromise = this._seekeableSeek(
          seekPosition,
          endTime !== undefined ? endTime : this.track.endTime
        )
      } else if (canNativeSeek) {
        seekPromise = this._seekUsingSource(
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
        this._lyricsBasePosition = this.position
        this._lyricsBasePackets =
          this.connection?.statistics?.packetsExpected ?? 0
        if (this._lyricsMarkerTimer) {
          clearTimeout(this._lyricsMarkerTimer)
          this._lyricsMarkerTimer = null
        }
        if (this.isLyricsSubscribed) this._recalculateLyricsIndex(undefined, undefined, true)
        this._fading('seek')
        this._fading('trackEndSchedule', { startPosition: this.position })
      }
      return result
    } finally {
      this._isSeeking = false
    }
  }

  async _seekUsingSource(position, endTime) {
    if (!this.track) return false

    logger(
      'debug',
      'Player',
      `Seeking using source (native) to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
    this.streamInfo = { ...urlData, trackInfo: this.track.info }


    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      await this.waitEvent(
        'stateChange',
        (s) => s.status === 'connected' && this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
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
    this._fading('seekPrepare', { resource })

    this.setFilters(this.filters)

    logger(
      'debug',
      'Player',
      `Playing resource for guild ${this.guildId} after source seek`
    )
    this._lyricsBasePosition = position
    this._lyricsBasePackets =
      this.connection?.statistics?.packetsExpected ?? 0
    this.connection.play(resource)
    await this.waitEvent('playerStateChange', (s) => s.status === 'playing')

    return true
  }

  async _seekeableSeek(position, endTime) {
    await getStreamProcessor()

    logger(
      'debug',
      'Player',
      `Seeking with Seekeable to ${position}ms for guild ${this.guildId}`
    )
    this.position = position

    try {
      const url = this.streamInfo.url

      const resourceResult = await createSeekeableAudioResource(
        url,
        position,
        endTime,
        this.nodelink,
        this.filters,
        this,
        this.volumePercent / 100,
        this.audioMixer
      )

      if (resourceResult.exception) {
        logger(
          'error',
          'Player',
          `Seekeable resource creation failed for guild ${this.guildId}: ${resourceResult.exception.message}. Falling back to old method.`
        )
        this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
          track: this.track,
          exception: resourceResult.exception
        })
        this._emitTrackEnd(EndReasons.LOAD_FAILED)
        return this._legacySeek(position, endTime)
      }

      const resource = resourceResult

      if (this.volumePercent !== 100) {
        resource.setVolume(this.volumePercent / 100)
      }
      this._fading('seekPrepare', { resource })
      resource.setFilters(this.filters)

      this._lyricsBasePosition = position
      this._lyricsBasePackets =
        this.connection?.statistics?.packetsExpected ?? 0

      const oldStream = this.connection.play(resource)
      await this.waitEvent('playerStateChange', (s) => s.status === 'playing')
      if (oldStream) {
        oldStream.destroy()
      }

      return true
    } catch (e) {
      logger(
        'error',
        'Player',
        `An unexpected error occurred during seekeable seek for guild ${this.guildId}: ${e.message}. Falling back to old method.`
      )
      this.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
        track: this.track,
        exception: {
          message: e.message,
          severity: 'fault',
          cause: 'UNKNOWN_ERROR'
        }
      })
      this._emitTrackEnd(EndReasons.LOAD_FAILED)
      return this._legacySeek(position, endTime)
    }
  }

  async _legacySeek(position, endTime) {
    if (!this.track) return false
    if (
      position < 0 ||
      (this.track.info.length > 0 && position > this.track.info.length)
    )
      return false

    logger(
      'debug',
      'Player',
      `Seeking with legacy method to ${position}ms for guild ${this.guildId}`
    )

    this.position = position
    this.track.endTime = endTime

    const trackInfo = {
      ...this.track.info,
      audioTrackId: this.track.audioTrackId
    }

    const urlData = await this.nodelink.sources.getTrackUrl(trackInfo, null, this._isRecovering)
    if (!this.track) return false
    this.streamInfo = { ...urlData, trackInfo: this.track.info }

    if (urlData.exception) {
      const err = new Error(urlData.exception.message)
      this._onError(err)
      return false
    }

    if (!this.connection) {
      this._initConnection()
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      logger(
        'debug',
        'Player',
        `Waiting for voice connection to be ready for guild ${this.guildId}`
      )
      await this.waitEvent(
        'stateChange',
        (s) => s.status === 'connected' && this.connection?.udpInfo?.secretKey
      )
    }

    if (
      !this.connection ||
      !this.connection.udpInfo ||
      !this.connection.udpInfo.secretKey
    ) {
      const errorMessage = `Voice connection for guild ${this.guildId} is not ready (missing UDP info). Aborting playback.`
      logger('error', 'Player', errorMessage)
      this._onError(new Error(errorMessage))
      return false
    }

    const fetched = await this._fetchResource(
      this.track.info,
      urlData,
      position
    )
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
    this._fading('seekPrepare', { resource })

    this.setFilters(this.filters)

    logger(
      'debug',
      'Player',
      `Playing resource for guild ${this.guildId} after legacy seek`
    )
    this._lyricsBasePosition = position
    this._lyricsBasePackets =
      this.connection?.statistics?.packetsExpected ?? 0
    this.connection.play(resource)
    await this.waitEvent('playerStateChange', (s) => s.status === 'playing')

    return true
  }

  stop() {
    this.isUpdatingTrack = true
    try {
      if (this.destroying || !this.track) return false

      if (this.nextResource) {
        this.nextResource.destroy()
        this.nextResource = null
        this.nextTrack = null
      }

      if (this.connection && this.connStatus !== 'destroyed') {
        if (this.connection.audioStream) {
          if (this._fading('trackStop')) return true
          this.connection.stop(EndReasons.STOPPED)
        } else {
          this._emitTrackEnd(EndReasons.STOPPED)
          this._resetTrack()
        }
      } else {
        this._emitTrackEnd(EndReasons.STOPPED)
        this._resetTrack()
      }
      return true
    } finally {
      this.isUpdatingTrack = false
    }
  }

  async preload(payload) {
    if (this.destroying) return false

    if (this.nextResource) {
      this.nextResource.destroy()
      this.nextResource = null
      this.nextTrack = null
    }

    try {
      const trackInfo = {
        ...payload.info,
        audioTrackId: payload.audioTrackId
      }

      const urlData = await this.nodelink.sources.getTrackUrl(trackInfo)
      if (urlData.exception) return false

      const fetched = await this._fetchResource(payload.info, urlData, 0)
      if (fetched.exception) return false

      this.nextTrack = payload
      this.nextResource = fetched.stream

      if (this.volumePercent !== 100) {
        this.nextResource.setVolume(this.volumePercent / 100)
      }
      this.nextResource.setFilters(this.filters)

      return true
    } catch (err) {
      logger(
        'error',
        'Player',
        `Preload failed for guild ${this.guildId}: ${err.message}`
      )
      return false
    }
  }

  pause(shouldPause) {
    if (this.destroying || this.isPaused === shouldPause) return false
    logger(
      'debug',
      'Player',
      `Setting pause to ${shouldPause} for guild ${this.guildId}`
    )

    const wasResuming = this.isPaused && !shouldPause
    this.isPaused = shouldPause
    this._isResuming = wasResuming

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
    if (this.destroying) return false
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

  setFading(config) {
    this.fading = config
    return true
  }

  setFilters(filters) {
    if (this.destroying || !this.track) return false
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
          if (key === 'equalizer' && Array.isArray(filters.filters[key])) {
            newFilterSettings[key] = filters.filters[key]
          } else {
            newFilterSettings[key] = {
              ...(newFilterSettings[key] || {}),
              ...filters.filters[key]
            }
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

  updateVoice(voicePayload = {}, force = false) {
    if (this.destroying) return

    const { sessionId, token, endpoint, channelId } = voicePayload

    let changed = false
    if (sessionId !== undefined && this.voice.sessionId !== sessionId) {
      this.voice.sessionId = sessionId
      changed = true
    }
    if (token !== undefined && this.voice.token !== token) {
      this.voice.token = token
      changed = true
    }
    if (endpoint !== undefined && this.voice.endpoint !== endpoint) {
      this.voice.endpoint = endpoint
      changed = true
    }
    if (channelId !== undefined && this.voice.channelId !== channelId) {
      this.voice.channelId = channelId
      changed = true
    }

    if (this.voice.sessionId && this.voice.token && this.voice.endpoint) {
      if (!changed && !force) {
        logger(
          'debug',
          'Player',
          `Voice state for guild ${this.guildId} is unchanged. Skipping update.`
        )
        return
      }

      logger(
        'debug',
        'Player',
        `Updating voice state for guild ${this.guildId}`
      )
      if (!this.connection) this._initConnection()
      if (this.voice.channelId) {
        this.connection.channelId = this.voice.channelId
      }
      this.connection.voiceStateUpdate({ session_id: this.voice.sessionId })
      this.connection.voiceServerUpdate({
        token: this.voice.token,
        endpoint: this.voice.endpoint
      })
      this.connection.connect(async () => {
        if (this.destroying) return
        if (this.connection.audioStream && !this.isPaused) {
          this.connection.unpause('reconnected')
        }

        if (
          this.track &&
          !this.connection.audioStream &&
          !this.isUpdatingTrack
        ) {
          logger(
            'debug',
            'Player',
            `Voice state updated for guild ${this.guildId}, starting pending track.`
          )
          await this._startPlayback()
        }
      })
    } else {
      logger(
        'warn',
        'Player',
        `Incomplete voice update for guild ${this.guildId}. Missing sessionId, token, or endpoint.`
      )
    }
  }

  destroy(emitClose = true) {
    if (this.destroying) return
    this.destroying = true

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
    this.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
      guildId: this.guildId
    })
    this._resetTrack()
    this.connStatus = 'destroyed'
    this.volumePercent = this.nodelink.options?.defaultVolume ?? 100
  }

  async addMix(trackPayload, volume = null) {
    if (!this.track || this.isPaused) {
      throw new Error('Cannot add mix without an active stream')
    }

    if (!this.audioMixer) {
      throw new Error('AudioMixer not initialized')
    }

    const mixConfig = this.nodelink?.options?.mix ?? {
      enabled: true,
      defaultVolume: 0.8,
      maxLayersMix: 5
    }

    if (this.audioMixer.mixLayers.size >= mixConfig.maxLayersMix) {
      throw new Error(
        `Maximum number of mix layers (${mixConfig.maxLayersMix}) reached`
      )
    }

    const mixVolume = volume ?? mixConfig.defaultVolume

    const { createAudioResource: createResource } = await import(
      './processing/streamProcessor.js'
    )

    const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info)
    if (!urlData || !urlData.url) {
      throw new Error('Failed to get stream URL for mix track')
    }

    const fetched = await this.nodelink.sources.getTrackStream(
      urlData.newTrack?.info || trackPayload.info,
      urlData.url,
      urlData.protocol,
      urlData.additionalData
    )

    if (fetched.exception) {
      throw new Error(fetched.exception.message)
    }

    const pcmResource = createResource(
      fetched.stream,
      fetched.type || urlData.format,
      this.nodelink,
      {},
      mixVolume,
      null,
      true
    )

    const mixId = this.audioMixer.addLayer(
      pcmResource.stream,
      trackPayload,
      mixVolume
    )

    return {
      id: mixId,
      track: trackPayload,
      volume: mixVolume
    }
  }

  removeMix(mixId) {
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.removeLayer(mixId)
  }

  updateMix(mixId, volume) {
    if (!this.audioMixer) {
      return false
    }
    return this.audioMixer.updateLayerVolume(mixId, volume)
  }

  getMixes() {
    if (!this.audioMixer) {
      return []
    }
    return this.audioMixer.getLayers()
  }

  async subscribeLyrics(skipTrackSource) {
    if (this.isLyricsSubscribed) return
    this.isLyricsSubscribed = true
    this.skipTrackSource = skipTrackSource === 'true' || skipTrackSource === true

    if (this.track && !this.isPaused) {
      this._loadLyrics()
    }
  }

  unsubscribeLyrics() {
    this.isLyricsSubscribed = false
    this.skipTrackSource = false
    this.currentLyrics = null
    this.lyricsLineIndex = -1
    if (this._lyricsMarkerTimer) {
      clearTimeout(this._lyricsMarkerTimer)
      this._lyricsMarkerTimer = null
    }
  }

  async _loadLyrics() {
    if (!this.track) return

    const lyricsData = await this.nodelink.lyrics.loadLyrics(
      { info: this.track.info },
      undefined,
      this.skipTrackSource
    )

    if (lyricsData && lyricsData.loadType === 'lyrics') {
      const lines = lyricsData.data.lines.map((line) => ({
        timestamp: line.time,
        duration: line.duration || 0,
        line: line.text,
        words: line.words || [],
        plugin: {}
      }))

      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].duration === 0) {
          lines[i].duration = lines[i + 1].timestamp - lines[i].timestamp
        }
      }

      const payload = {
        sourceName: this.track.info.sourceName,
        provider: lyricsData.data.provider,
        text: lyricsData.data.lines.map((l) => l.text).join('\n'),
        lines,
        plugin: {}
      }

      this.currentLyrics = payload
      this.lyricsLineIndex = -1
      this.emitEvent('LyricsFoundEvent', { lyrics: this.currentLyrics })
      if (this._lyricsMarkerTimer) {
        clearTimeout(this._lyricsMarkerTimer)
        this._lyricsMarkerTimer = null
      }
      this._recalculateLyricsIndex(undefined, undefined, true)
      this._syncLyrics(true)
    } else {
      this.currentLyrics = null
      this.emitEvent('LyricsNotFoundEvent')
    }
  }

  _syncLyrics(force = false) {
    if (!this.isLyricsSubscribed || !this.currentLyrics || !this.currentLyrics.lines) return
    if (this._lyricsMarkerTimer && !force) return

    const timescale = this.filters.filters?.timescale || {
      speed: 1.0,
      rate: 1.0
    }
    const playbackSpeed = (timescale.speed || 1.0) * (timescale.rate || 1.0)
    const position = this._getLyricsPosition(playbackSpeed)
    const lines = this.currentLyrics.lines
    this._recalculateLyricsIndex(position, lines)

    const nextIndex = this.lyricsLineIndex + 1
    if (nextIndex >= lines.length) return

    const nextTimestamp = lines[nextIndex].timestamp
    const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed)

    this._lyricsMarkerTimer = setTimeout(() => {
      this._lyricsMarkerTimer = null
      if (!this.isLyricsSubscribed || !this.currentLyrics || !this.currentLyrics.lines) return
      const nowPosition = this._getLyricsPosition(playbackSpeed)
      const drift = nowPosition - nextTimestamp

      if (drift < -15) {
        this._syncLyrics(true)
        return
      }

      if (Math.abs(drift) > 100) {
        this._lyricsBasePosition -= drift * 0.25
      }

      this.lyricsLineIndex = nextIndex
      this.emitEvent('LyricsLineEvent', {
        lineIndex: nextIndex,
        line: lines[nextIndex],
        skipped: drift > 60
      })
      this._syncLyrics(true)
    }, delayMs)
  }

  _getLyricsPosition(playbackSpeed) {
    const stats = this.connection?.statistics
    const packets = stats?.packetsExpected ?? this._lyricsBasePackets
    const deltaPackets = Math.max(0, packets - this._lyricsBasePackets)

    return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed
  }
  _recalculateLyricsIndex(positionOverride, linesOverride, allowBackward = false) {
    if (!this.currentLyrics || !this.currentLyrics.lines) return

    const lines = linesOverride || this.currentLyrics.lines
    let position = positionOverride

    if (position === undefined) {
      const timescale = this.filters.filters?.timescale || {
        speed: 1.0,
        rate: 1.0
      }
      const playbackSpeed = (timescale.speed || 1.0) * (timescale.rate || 1.0)
      position = this._getLyricsPosition(playbackSpeed)
    }

    let foundIndex = -1
    // Efficiently find the current line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].timestamp <= position) {
        foundIndex = i
      } else {
        break
      }
    }

    if (!allowBackward && foundIndex < this.lyricsLineIndex) {
      return
    }

    if (foundIndex !== this.lyricsLineIndex) {
      const skipped = foundIndex > this.lyricsLineIndex + 1
      this.lyricsLineIndex = foundIndex

      if (foundIndex !== -1) {
        const line = lines[foundIndex]
        this.emitEvent('LyricsLineEvent', {
          lineIndex: foundIndex,
          line: line,
          skipped
        })
      }
    }
  }

  toJSON() {
    return {
      guildId: this.guildId,
      track: this.track,
      volume: this.volumePercent,
      fading: this.fading,
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

  _fading(action, payload = {}) {
    const timers = this._fadeTimers
    if (!timers) return false

    if (action === 'reset') {
      if (timers.trackEnd) clearTimeout(timers.trackEnd)
      if (timers.pause) clearTimeout(timers.pause)
      if (timers.stop) clearTimeout(timers.stop)
      timers.trackEnd = null
      timers.pause = null
      timers.stop = null
      this._pendingTrackStartFade = false
      return false
    }

    if (action === 'trackEndSchedule' && timers.trackEnd) {
      clearTimeout(timers.trackEnd)
      timers.trackEnd = null
    }

    if (!this.fading || this.fading.enabled !== true) return false

    let section = null
    if (action === 'trackStart' || action === 'trackStartArm')
      section = this.fading.trackStart
    else if (action === 'trackEndSchedule') section = this.fading.trackEnd
    else if (action === 'trackStop') section = this.fading.trackStop
    else if (action === 'seek') section = this.fading.seek
    else if (action === 'seekPrepare') section = this.fading.seek
    else return false

    if (
      !section ||
      !Number.isFinite(section.duration) ||
      section.duration <= 0
    )
      return false

    if (action === 'trackStartArm') {
      const resource = payload.resource
      if (!resource?.setFadeVolume) return false
      resource.setFadeVolume(0)
      this._pendingTrackStartFade = true
      return true
    }

    if (action === 'trackStart') {
      if (!this._pendingTrackStartFade) return false
      const stream = payload.resource || this.connection?.audioStream
      if (!stream?.fadeTo) return false
      this._pendingTrackStartFade = false
      stream.fadeTo(1, section.duration, section.curve)
      return true
    }

    if (action === 'seekPrepare') {
      const resource = payload.resource
      if (!resource?.setFadeVolume) return false
      resource.setFadeVolume(0)
      return true
    }

    if (action === 'seek') {
      const stream = this.connection?.audioStream
      if (!stream?.setFadeVolume) return false
      stream.setFadeVolume(0)
      stream.fadeTo(1, section.duration, section.curve)
      return true
    }

    if (action === 'trackStop') {
      const stream = this.connection?.audioStream
      if (!stream?.fadeTo) return false
      if (timers.stop) clearTimeout(timers.stop)
      stream.fadeTo(0, section.duration, section.curve)
      timers.stop = setTimeout(() => {
        this.connection?.stop(EndReasons.STOPPED)
        if (timers.stop) {
          clearTimeout(timers.stop)
          timers.stop = null
        }
      }, section.duration)
      return true
    }

    if (action === 'trackEndSchedule') {
      if (!this.track?.info) return false
      const total =
        this.track.endTime && this.track.endTime > 0
          ? this.track.endTime
          : this.track.info.length || 0
      if (!Number.isFinite(total) || total <= 0) return false

      const startPosition = payload.startPosition || 0
      const remaining = Math.max(0, total - startPosition)
      const fadeDuration = Math.min(section.duration, remaining)
      const delay = Math.max(0, remaining - fadeDuration)

      timers.trackEnd = setTimeout(() => {
        const stream = this.connection?.audioStream
        if (stream?.fadeTo) {
          stream.fadeTo(0, fadeDuration, section.curve)
        }
        if (timers.trackEnd) {
          clearTimeout(timers.trackEnd)
          timers.trackEnd = null
        }
      }, delay)
      return true
    }

    return false
  }
}
