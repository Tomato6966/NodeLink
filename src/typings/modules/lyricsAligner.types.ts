/**
 * Word-level token used during lyrics alignment.
 * @public
 */
export interface AlignableWord {
  /**
   * Additional payload fields.
   */
  [key: string]: unknown

  /**
   * Raw word text.
   */
  text?: string

  /**
   * Preferred timestamp in milliseconds.
   */
  timestamp?: number | string

  /**
   * Alternative timestamp field in milliseconds.
   */
  time?: number | string

  /**
   * Optional word duration in milliseconds.
   */
  duration?: number
}

/**
 * Line payload accepted by lyrics aligner.
 * @public
 */
export interface AlignableLyricsLine extends LyricsLine {
  /**
   * Line text.
   */
  text: string

  /**
   * Line start time in milliseconds.
   */
  time: number

  /**
   * Optional word-level tokens.
   */
  words?: AlignableWord[]
}

/**
 * Minimal YouTube captions payload used by the aligner.
 * @public
 */
export interface YouTubeLyricsAlignmentData {
  /**
   * Caption lines used as timing reference.
   */
  lines?: AlignableLyricsLine[] | null
}

/**
 * Flattened word used internally during sequence matching.
 * @public
 */
export interface FlattenedYouTubeWord {
  /**
   * Normalized word text.
   */
  text: string

  /**
   * Word start timestamp in milliseconds.
   */
  time: number
}

/**
 * Best sequence match candidate.
 * @public
 */
export interface SequenceMatch {
  /**
   * Matched index in flattened YouTube word list.
   */
  index: number

  /**
   * Matched timestamp in milliseconds.
   */
  time: number

  /**
   * Similarity score for the sequence.
   */
  score: number
}

/**
 * Pending offset jump candidate waiting for confirmation.
 * @public
 */
export interface PendingDeviation {
  /**
   * Candidate offset in milliseconds.
   */
  offset: number

  /**
   * Lyrics line index where deviation was observed.
   */
  index: number
}

import type { LyricsLine } from '../lyrics/musixmatch.types.ts'
