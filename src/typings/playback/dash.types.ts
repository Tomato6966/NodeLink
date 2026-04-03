/**
 * Parsed representation from a DASH MPD manifest.
 */
export interface DASHRepresentation {
  id: string
  codecs: string
  bandwidth: number
  audioSamplingRate: number
  initUrl: string
  mediaTemplate: string
  startNumber: number
  segments: Array<{ duration: number; repeat: number }>
}

/**
 * Options for the DASH stream handler.
 */
export interface DASHHandlerOptions {
  /** Local interface address to bind to. */
  localAddress?: string
  /** Start time offset in milliseconds. */
  startTime?: number
  /** Expected total duration in milliseconds. */
  expectedDuration?: number
  /** HTTP headers for segment requests. */
  headers?: Record<string, string>
  /** Proxy configuration. */
  proxy?: { host: string; port: number; auth?: { username: string; password: string } }
}

/**
 * Result of fetching a DASH segment.
 */
export interface DASHSegmentResult {
  data: Buffer
  error?: string
  statusCode?: number
}
