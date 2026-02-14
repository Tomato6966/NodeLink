import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
import LFO from "./dsp/lfo.js";
/**
 * Applies a tremolo effect (amplitude modulation) using an LFO.
 * @public
 */
export default class Tremolo extends BaseFilter {
    priority = 10;
    lfo;
    constructor() {
        super();
        this.lfo = new LFO('SINE');
    }
    /**
     * Updates the tremolo settings.
     * @param settings - Filter settings containing `tremolo`.
     */
    update(settings) {
        const tremoloSettings = settings.tremolo || {};
        const frequency = tremoloSettings.frequency || 0;
        const depth = Math.max(0, Math.min(tremoloSettings.depth || 0, 1.0));
        this.lfo.update(frequency, depth);
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        if (this.lfo.depth === 0 || this.lfo.frequency === 0) {
            return chunk;
        }
        // Process each sample. 2 bytes per sample.
        for (let i = 0; i < chunk.length; i += 2) {
            const sample = chunk.readInt16LE(i);
            const multiplier = this.lfo.process();
            const newSample = sample * multiplier;
            chunk.writeInt16LE(clamp16Bit(newSample), i);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.lfo.phase = 0;
        return Buffer.alloc(0);
    }
}
