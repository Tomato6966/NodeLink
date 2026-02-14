import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
/**
 * Applies a simple high-pass filter to the audio.
 * @public
 */
export default class Highpass extends BaseFilter {
    priority = 10;
    smoothing = 0;
    smoothingFactor = 0;
    prevLeftOutput = 0;
    prevRightOutput = 0;
    /**
     * Updates the high-pass filter settings.
     * @param settings - Filter settings containing `highpass`.
     */
    update(settings) {
        const { smoothing = 0 } = settings.highpass || {};
        if (smoothing > 1.0) {
            this.smoothing = smoothing;
            this.smoothingFactor = 1.0 / smoothing;
        }
        else {
            this.smoothing = 0;
            this.smoothingFactor = 0;
        }
        this.prevLeftOutput = 0;
        this.prevRightOutput = 0;
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        if (this.smoothing <= 1.0) {
            return chunk;
        }
        for (let i = 0; i < chunk.length; i += 4) {
            const currentLeftSample = chunk.readInt16LE(i);
            const newLeftLow = this.prevLeftOutput +
                this.smoothingFactor * (currentLeftSample - this.prevLeftOutput);
            this.prevLeftOutput = newLeftLow;
            chunk.writeInt16LE(clamp16Bit(currentLeftSample - newLeftLow), i);
            const currentRightSample = chunk.readInt16LE(i + 2);
            const newRightLow = this.prevRightOutput +
                this.smoothingFactor * (currentRightSample - this.prevRightOutput);
            this.prevRightOutput = newRightLow;
            chunk.writeInt16LE(clamp16Bit(currentRightSample - newRightLow), i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        this.prevLeftOutput = 0;
        this.prevRightOutput = 0;
        return Buffer.alloc(0);
    }
}
