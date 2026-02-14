import { SAMPLE_RATE } from "../../constants.js";
import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
import DelayLine from "./dsp/delay.js";
import LFO from "./dsp/lfo.js";
const MAX_DELAY_MS = 20;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a vibrato effect (pitch modulation) using an LFO.
 * @public
 */
export default class Vibrato extends BaseFilter {
    priority = 10;
    lfo;
    leftDelay;
    rightDelay;
    constructor() {
        super();
        this.lfo = new LFO('SINE');
        this.leftDelay = new DelayLine(bufferSize);
        this.rightDelay = new DelayLine(bufferSize);
    }
    /**
     * Updates the vibrato settings.
     * @param settings - Filter settings containing `vibrato`.
     */
    update(settings) {
        const vibratoSettings = settings.vibrato || {};
        const frequency = vibratoSettings.frequency || 0;
        let depth = vibratoSettings.depth ?? 0;
        depth = Math.max(0, Math.min(depth, 2.0));
        this.lfo.update(frequency, depth);
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
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
            chunk.writeInt16LE(clamp16Bit(delayedLeft), i);
            const rightSample = chunk.readInt16LE(i + 2);
            this.rightDelay.write(rightSample);
            const delayedRight = this.rightDelay.read(delay);
            chunk.writeInt16LE(clamp16Bit(delayedRight), i + 2);
        }
        return chunk;
    }
    /**
     * Clears the vibrato state.
     */
    flush() {
        this.leftDelay.clear();
        this.rightDelay.clear();
        this.lfo.phase = 0;
        return Buffer.alloc(0);
    }
}
