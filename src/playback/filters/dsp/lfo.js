import { SAMPLE_RATE } from '../../../constants.js'
import { Waveforms } from './waves.js'

export default class LFO {
  constructor(waveform = 'SINE', frequency = 0, depth = 0) {
    this.phase = 0
    this.waveform = Waveforms[waveform] || Waveforms.SINE
    this.frequency = frequency
    this.depth = depth
  }

  setWaveform(waveform) {
    this.waveform = Waveforms[waveform] || Waveforms.SINE
  }

  update(frequency, depth) {
    this.frequency = frequency
    this.depth = depth
  }

  getValue() {
    if (this.frequency === 0) {
      return 0
    }
    const value = this.waveform(this.phase)
    this.phase += (2 * Math.PI * this.frequency) / SAMPLE_RATE
    if (this.phase > 2 * Math.PI) {
      this.phase -= 2 * Math.PI
    }
    return value
  }

  process() {
    if (this.depth === 0 || this.frequency === 0) {
      return 1.0
    }
    const lfoValue = this.getValue()
    const normalizedLfo = (lfoValue + 1) / 2

    return 1.0 - this.depth * normalizedLfo
  }
}
