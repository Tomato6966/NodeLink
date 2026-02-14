import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
/**
 * Mixes audio channels based on configurable weights.
 * @public
 */
export default class ChannelMix extends BaseFilter {
    priority = 10;
    leftToLeft = 1.0;
    leftToRight = 0.0;
    rightToLeft = 0.0;
    rightToRight = 1.0;
    /**
     * Updates the channel weights.
     * @param settings - Filter settings containing `channelMix`.
     */
    update(settings) {
        const { leftToLeft = 1.0, leftToRight = 0.0, rightToLeft = 0.0, rightToRight = 1.0 } = settings.channelMix || {};
        this.leftToLeft = Math.max(0.0, Math.min(1.0, leftToLeft));
        this.leftToRight = Math.max(0.0, Math.min(1.0, leftToRight));
        this.rightToLeft = Math.max(0.0, Math.min(1.0, rightToLeft));
        this.rightToRight = Math.max(0.0, Math.min(1.0, rightToRight));
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        if (this.leftToLeft === 1.0 &&
            this.leftToRight === 0.0 &&
            this.rightToLeft === 0.0 &&
            this.rightToRight === 1.0) {
            return chunk;
        }
        for (let i = 0; i < chunk.length; i += 4) {
            const left = chunk.readInt16LE(i);
            const right = chunk.readInt16LE(i + 2);
            const newLeft = left * this.leftToLeft + right * this.rightToLeft;
            const newRight = left * this.leftToRight + right * this.rightToRight;
            chunk.writeInt16LE(clamp16Bit(newLeft), i);
            chunk.writeInt16LE(clamp16Bit(newRight), i + 2);
        }
        return chunk;
    }
    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    flush() {
        return Buffer.alloc(0);
    }
}
