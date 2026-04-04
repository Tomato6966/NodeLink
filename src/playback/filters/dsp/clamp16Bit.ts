/**
 * Clamps a numerical sample to the range of a 16-bit signed integer.
 * @param sample - The input audio sample.
 * @returns The clamped 16-bit sample.
 * @public
 */
export function clamp16Bit(sample: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(sample)))
}
