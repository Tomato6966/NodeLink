export const Waveforms = {
  SINE: (phase) => Math.sin(phase),
  SQUARE: (phase) => (phase % (2 * Math.PI) < Math.PI ? 1 : -1),
  SAWTOOTH: (phase) => (phase % (2 * Math.PI)) / Math.PI - 1,
  TRIANGLE: (phase) => {
    const x = (phase % (2 * Math.PI)) / (2 * Math.PI)
    return 2 * (x < 0.5 ? 2 * x : 2 - 2 * x) - 1
  }
}
