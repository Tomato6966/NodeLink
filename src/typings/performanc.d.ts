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
