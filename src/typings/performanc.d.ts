/**
 * Type declarations for @performanc/pwsl-server
 * @module @performanc/pwsl-server
 */

declare module '@performanc/pwsl-server' {
  import type { EventEmitter } from 'node:events'
  import type { IncomingMessage } from 'node:http'
  import type { Socket } from 'node:net'

  /**
   * WebSocket connection instance
   * @public
   */
  interface WebsocketConnection extends EventEmitter {
    /**
     * HTTP request object
     */
    req: IncomingMessage | null

    /**
     * Network socket
     */
    socket: Socket | null

    /**
     * Send data through WebSocket
     * @param data - Data to send (string, Buffer, ArrayBuffer, or typed array)
     * @returns True if sent successfully, false otherwise
     */
    send(data: string | Buffer | ArrayBuffer | ArrayBufferView): boolean

    /**
     * Close the WebSocket connection
     * @param code - Close code (default: 1000)
     * @param reason - Close reason (max 123 bytes)
     * @returns True if close frame sent successfully
     */
    close(code?: number, reason?: string): boolean

    /**
     * Destroy the connection immediately
     */
    destroy(): void

    /**
     * Emitted when a message is received
     * @event
     */
    on(event: 'message', listener: (data: string | Buffer) => void): this

    /**
     * Emitted when connection is closed
     * @event
     */
    on(
      event: 'close',
      listener: (code: number, reason: string | null) => void
    ): this

    /**
     * Emitted when pong is received
     * @event
     */
    on(event: 'pong', listener: () => void): this

    /**
     * Generic event listener
     * @event
     */
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  /**
   * WebSocket server implementation
   * @public
   */
  export default class WebSocketServer extends EventEmitter {
    /**
     * Creates a new WebSocket server instance
     */
    constructor()

    /**
     * Handles WebSocket upgrade request
     * @param req - HTTP request object
     * @param socket - Network socket
     * @param head - First packet of upgraded stream
     * @param headers - Additional headers to send in handshake response
     * @param callback - Callback with WebSocket connection instance
     */
    handleUpgrade(
      req: IncomingMessage,
      socket: Socket,
      head: Buffer,
      headers: Record<string, string> | null,
      callback: (ws: WebsocketConnection) => void
    ): void
  }
}

declare module '@performanc/voice' {
  import type { EventEmitter } from 'node:events'
  import type { Readable } from 'node:stream'

  export interface VoiceConnectionState {
    status:
      | 'connecting'
      | 'connected'
      | 'disconnected'
      | 'destroyed'
      | 'reconnecting'
    code?: number
    closeReason?: string
  }

  export interface VoicePlayerState {
    status: 'idle' | 'playing' | 'paused'
    reason?: string
  }

  export interface VoiceStatistics {
    packetsExpected: number
    [key: string]: number | undefined
  }

  export interface VoiceUdpInfo {
    secretKey?: Uint8Array | Buffer
  }

  export interface VoiceAudioStream extends EventEmitter {
    pipes?: Readable[]
    statistics?: VoiceStatistics
    setVolume(volume: number): void
    setFilters(filters: unknown): void
    setFadeVolume?(volume: number): void
    fadeTo?(volume: number, durationMs: number, curve?: string): void
    setLoudnessNormalizer?(enabled: boolean): void
    destroy(): void
    pause?(reason?: string): void
    unpause?(reason?: string): void
    stop?(reason?: string): void
    read?(): unknown
  }

  export interface VoiceConnection extends EventEmitter {
    channelId?: string | null
    udpInfo?: VoiceUdpInfo
    statistics?: VoiceStatistics
    ping?: number
    audioStream?: VoiceAudioStream | null

    on(
      event: 'stateChange',
      listener: (
        oldState: VoiceConnectionState | null,
        newState: VoiceConnectionState
      ) => void
    ): this
    on(
      event: 'playerStateChange',
      listener: (
        oldState: VoicePlayerState | null,
        newState: VoicePlayerState
      ) => void
    ): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'audioStream', listener: (stream: VoiceAudioStream) => void): this
    on(
      event: 'speakStart',
      listener: (userId: string, ssrc: number) => void
    ): this
    on(
      event: 'speakEnd',
      listener: (userId: string, ssrc: number) => void
    ): this
    on(event: string, listener: (...args: unknown[]) => void): this

    play(resource: unknown): VoiceAudioStream | null | undefined
    stop(reason?: string): void
    pause?(reason?: string): void
    unpause?(reason?: string): void
    destroy(): void
    voiceStateUpdate(state: { session_id: string }): void
    voiceServerUpdate(update: { token: string; endpoint: string }): void
    connect(callback?: () => void): void
  }

  export interface JoinVoiceChannelOptions {
    guildId: string
    userId: string
    channelId: string
    encryption?: string | null
  }

  export function joinVoiceChannel(
    options: JoinVoiceChannelOptions
  ): VoiceConnection
  export function getSpeakStream(ssrc: number, guildId: string): Readable | null

  const api: {
    joinVoiceChannel: typeof joinVoiceChannel
    getSpeakStream: typeof getSpeakStream
  }

  export default api
}
