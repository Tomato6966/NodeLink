/**
 * Ambient declarations for Ecliptia packages used by NodeLink.
 * These modules do not ship TypeScript types.
 */
declare module '@ecliptia/seekable-stream' {
  import type { Readable } from 'node:stream'

  export class SeekError extends Error {
    /** Error code returned by the seekable-stream implementation */
    code?: string
  }

  export interface SeekMeta {
    codec?: {
      container?: string
    }
  }

  export interface SeekResult {
    stream: Readable
    meta: SeekMeta
  }

  /**
   * Creates a seekable stream for the given URL.
   *
   * @param url - Source URL to stream from.
   * @param startTime - Start position in milliseconds.
   * @param endTime - Optional end position in milliseconds.
   * @param options - Additional options forwarded to the implementation.
   */
  export function seekableStream(
    url: string,
    startTime: number,
    endTime?: number,
    options?: Record<string, unknown>
  ): Promise<SeekResult>
}

declare module '@ecliptia/faad2-wasm/faad2_node_decoder.js' {
  /**
   * AAC decoder class provided by the FAAD2 WebAssembly build.
   */
  export default class FAAD2NodeDecoder {
    constructor()
  }
}
