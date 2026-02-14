import { BaseFilter } from "./BaseFilter.js";
import { clamp16Bit } from "./dsp/clamp16Bit.js";
/**
 * Applies various distortion effects (sin, cos, tan, etc.).
 * @public
 */
export default class Distortion extends BaseFilter {
    priority = 10;
    sinOffset = 0;
    sinScale = 1;
    cosOffset = 0;
    cosScale = 1;
    tanOffset = 0;
    tanScale = 1;
    offset = 0;
    scale = 1;
    /**
     * Updates the distortion settings.
     * @param settings - Filter settings containing `distortion`.
     */
    update(settings) {
        const dist = settings.distortion || {};
        this.sinOffset = dist.sinOffset ?? 0;
        this.sinScale = dist.sinScale ?? 1;
        this.cosOffset = dist.cosOffset ?? 0;
        this.cosScale = dist.cosScale ?? 1;
        this.tanOffset = dist.tanOffset ?? 0;
        this.tanScale = dist.tanScale ?? 1;
        this.offset = dist.offset ?? 0;
        this.scale = dist.scale ?? 1;
    }
    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    process(chunk) {
        if (this.sinOffset === 0 &&
            this.sinScale === 1 &&
            this.cosOffset === 0 &&
            this.cosScale === 1 &&
            this.tanOffset === 0 &&
            this.tanScale === 1 &&
            this.offset === 0 &&
            this.scale === 1) {
            return chunk;
        }
        for (let i = 0; i < chunk.length; i += 2) {
            const sample = chunk.readInt16LE(i) / 32768;
            let processed = Math.sin(sample * this.sinScale + this.sinOffset) +
                Math.cos(sample * this.cosScale + this.cosOffset) +
                Math.tan(sample * this.tanScale + this.tanOffset) +
                (sample * this.scale + this.offset);
            processed = Math.max(-1, Math.min(1, processed));
            chunk.writeInt16LE(clamp16Bit(processed * 32768), i);
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
