export function clamp16Bit(sample) {
  return Math.max(-32768, Math.min(32767, Math.round(sample)))
}
