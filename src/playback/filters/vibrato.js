import LFO from './dsp/lfo.js';
import DelayLine from './dsp/delay.js';
import { SAMPLE_RATE } from '../../constants.js';

const MAX_DELAY_MS = 20;
const bufferSize = Math.ceil(SAMPLE_RATE * MAX_DELAY_MS / 1000);

export default {
  lfo: new LFO('SINE'),
  leftDelay: new DelayLine(bufferSize),
  rightDelay: new DelayLine(bufferSize),

  update(filters) {
    const { frequency = 0, depth = 0 } = filters.vibrato || {};
    this.lfo.update(frequency, depth);
  },

  process(chunk) {
    if (this.lfo.depth === 0 || this.lfo.frequency === 0) {
      this.leftDelay.clear();
      this.rightDelay.clear();
      return chunk;
    }

    const maxDelayWidth = this.lfo.depth * (SAMPLE_RATE * 0.005);
    const centerDelay = maxDelayWidth;

    for (let i = 0; i < chunk.length; i += 4) {
      const lfoValue = this.lfo.getValue();

      const delay = centerDelay + lfoValue * maxDelayWidth;

      const leftSample = chunk.readInt16LE(i);
      this.leftDelay.write(leftSample);

      const delayedLeft = this.leftDelay.read(delay);
      chunk.writeInt16LE(delayedLeft, i);

      const rightSample = chunk.readInt16LE(i + 2);
      this.rightDelay.write(rightSample);
      const delayedRight = this.rightDelay.read(delay);
      chunk.writeInt16LE(delayedRight, i + 2);
    }

    return chunk;
  }
}
