import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'

// biome-ignore lint/style/useExponentiationOperator: <Math.pow is more readable here>
const dbToGain = (db: number): number => Math.pow(10, db / 20)
const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(1e-10, gain))

/**
 * Applies dynamic range compression to audio.
 * @public
 */
export default class Compressor extends BaseFilter {
    public priority = 11
    private threshold = -24
    private ratio = 4
    private attack = 0.01
    private release = 0.1
    private makeupGain = 0

    private envelope = 0

    /**
     * Updates the compressor settings.
     * @param settings - Filter settings containing `compressor`.
     */
    public override update(settings: FilterSettings): void {
        const comp = settings.compressor || {}

        this.threshold = comp.threshold ?? -24
        this.ratio = Math.max(1, comp.ratio ?? 4)
        this.attack = Math.max(0.001, comp.attack ?? 0.01)
        this.release = Math.max(0.01, comp.release ?? 0.1)
        this.makeupGain = comp.makeupGain ?? 0
    }

    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    public override process(chunk: Buffer): Buffer {
        const attackCoef = Math.exp(-1 / (this.attack * 44100))
        const releaseCoef = Math.exp(-1 / (this.release * 44100))
        const makeupGain = dbToGain(this.makeupGain)

        for (let i = 0; i < chunk.length; i += 4) {
            const left = chunk.readInt16LE(i) / 32768
            const right = chunk.readInt16LE(i + 2) / 32768

            const absSample = Math.max(Math.abs(left), Math.abs(right))

            if (absSample > this.envelope) {
                this.envelope = attackCoef * (this.envelope - absSample) + absSample
            } else {
                this.envelope = releaseCoef * (this.envelope - absSample) + absSample
            }

            const envelopeDb = gainToDb(this.envelope)
            let reductionDb = 0

            if (envelopeDb > this.threshold) {
                reductionDb = (this.threshold - envelopeDb) * (1 - 1 / this.ratio)
            }

            const gain = dbToGain(reductionDb) * makeupGain

            chunk.writeInt16LE(clamp16Bit(left * gain * 32768), i)
            chunk.writeInt16LE(clamp16Bit(right * gain * 32768), i + 2)
        }

        return chunk
    }

    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    public override flush(): Buffer {
        this.envelope = 0
        return Buffer.alloc(0)
    }
}
