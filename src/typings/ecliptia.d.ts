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

  export interface SeekCustomResponse extends Readable {
    statusCode?: number
    headers?: Record<string, string | string[] | number | undefined>
    resume?: () => void
  }

  export type SeekCustomRequestFn = (
    url: string | URL,
    options: {
      method?: string
      headers?: Record<string, string>
    }
  ) => Promise<SeekCustomResponse>

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
    httpHeaders?: Record<string, unknown>,
    customRequestFn?: SeekCustomRequestFn
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
