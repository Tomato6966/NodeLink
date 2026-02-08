import type { Transform } from 'node:stream'

/**
 * Track metadata parsed from a WebM container.
 * @example
 * ```ts
 * const track: WebmTrackInfo = { number: 1, type: 2 }
 * ```
 * @public
 */
export interface WebmTrackInfo {
  /**
   * EBML track number.
   */
  number?: number

  /**
   * Track type (2 indicates audio).
   */
  type?: number
}

/**
 * Result returned when reading a WebM tag.
 * @remarks Used internally to drive buffer skipping behavior.
 * @internal
 */
export interface WebmTagReadResult {
  /**
   * Offset (in bytes) to advance within the current buffer.
   */
  offset?: number

  /**
   * Absolute stream offset to skip until.
   */
  _skipUntil?: bigint
}

/**
 * Surface for WebM demuxer streams that emit Opus packets.
 * @public
 */
export interface WebmOpusDemuxerLike extends Transform {
  /**
   * Emitted when the Opus head packet is parsed.
   */
  on(event: 'head', listener: (header: Buffer) => void): this

  /**
   * Emitted for each decoded Opus packet.
   */
  on(event: 'data', listener: (packet: Buffer) => void): this

  /**
   * Emitted when an error is raised during parsing.
   */
  on(event: 'error', listener: (err: Error) => void): this
}
