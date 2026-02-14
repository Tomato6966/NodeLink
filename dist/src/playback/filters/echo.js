import { SAMPLE_RATE } from "../../constants.js";
import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
import DelayLine from "./dsp/delay.js";
const MAX_DELAY_MS = 2000;
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000);
/**
 * Applies a simple echo effect using a delay line.
 * @public
 */
export default class Echo extends BaseFilter {
    priority = 10;
    delayLineL;
    delayLineR;
    delay = 0;
    feedback = 0;
    mix = 0;
    constructor() {
        super();
        this.delayLineL = new DelayLine(bufferSize);
        this.delayLineR = new DelayLine(bufferSize);
    }
    /**
     * Updates the echo settings.
     * @param settings - Filter settings containing `echo`.
     */
    update(settings) {
        const echo = settings.echo || {};
        this.delay = Math.max(0, Math.min(echo.delay || 0, MAX_DELAY_MS));
        this.feedback = Math.max(0, Math.min(echo.feedback || 0, 1.0));
        this.mix = Math.max(0, Math.min(echo.mix || 0, 1.0));
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        if (this.delay === 0 || this.mix === 0) {
            return chunk;
        }
        const delaySamples = (this.delay * SAMPLE_RATE) / 1000;
        for (let i = 0; i < chunk.length; i += 4) {
            const leftSample = chunk.readInt16LE(i);
            const rightSample = chunk.readInt16LE(i + 2);
            const delayedLeft = this.delayLineL.read(delaySamples);
            const delayedRight = this.delayLineR.read(delaySamples);
            this.delayLineL.write(clamp16Bit(leftSample + delayedLeft * this.feedback));
            this.delayLineR.write(clamp16Bit(rightSample + delayedRight * this.feedback));
            const finalLeft = leftSample * (1 - this.mix) + delayedLeft * this.mix;
            const finalRight = rightSample * (1 - this.mix) + delayedRight * this.mix;
            chunk.writeInt16LE(clamp16Bit(finalLeft), i);
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.delayLineL.clear();
        this.delayLineR.clear();
        return Buffer.alloc(0);
    }
}
