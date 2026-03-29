/**
 * Metadata for a segment of audio analysis.
 * @public
 */
export interface EternalboxSegment {
  start: number
  duration: number
  confidence: number
  loudness_start: number
  loudness_max_time: number
  loudness_max: number
  loudness_end: number
  pitches: number[]
  timbre: number[]
  which?: number
}

/**
 * Metadata for a beat or tatum in audio analysis.
 * @public
 */
export interface EternalboxQuantum {
  start: number
  duration: number
  confidence: number
}

/**
 * Full audio analysis response from Eternalbox.
 * @public
 */
export interface EternalboxAnalysis {
  audio_summary: {
    duration: number
    analysis_sample_rate: number
    audio_md5: string
    [key: string]: unknown
  }
  beats: EternalboxQuantum[]
  tatums: EternalboxQuantum[]
  bars: EternalboxQuantum[]
  sections: Array<{
    start: number
    duration: number
    confidence: number
    loudness: number
    tempo: number
    tempo_confidence: number
    key: number
    key_confidence: number
    mode: number
    mode_confidence: number
    time_signature: number
    time_signature_confidence: number
  }>
  segments: EternalboxSegment[]
}

/**
 * Combined payload for Eternalbox track resolution.
 * @public
 */
export interface EternalboxPayload {
  info: {
    id: string
    service: string
    title?: string
    name?: string
    artist?: string
    author?: string
    duration?: number | string
    length?: number | string
    url?: string
    artwork?: string
    image?: string
    isrc?: string
  }
  analysis?: EternalboxAnalysis
}

/**
 * Internal cache entry for Eternalbox playback.
 * @internal
 */
export interface EternalboxCacheEntry {
  analysis: EternalboxAnalysis
  frames: Buffer[]
  frameStarts: number[]
  frameEnds: number[]
  beatFrames: Array<{ startFrame: number; endFrame: number }>
  beatNeighbors: number[][]
  lastBranchPoint: number
  streamReady: boolean
  sizeBytes: number
}
