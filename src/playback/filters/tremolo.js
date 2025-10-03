import LFO from './dsp/lfo.js';

export default {
  lfo: new LFO('SINE'),

  update(filters) {
    const { frequency = 0, depth = 0 } = filters.tremolo || {};
    this.lfo.update(frequency, depth);
  },

  process(chunk) {
    if (this.lfo.depth === 0 || this.lfo.frequency === 0) {
      return chunk;
    }

    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      const multiplier = this.lfo.process();
      
      const newSample = Math.max(-32768, Math.min(32767, Math.floor(sample * multiplier)));
      
      chunk.writeInt16LE(newSample, i);
    }

    return chunk;
  }
}