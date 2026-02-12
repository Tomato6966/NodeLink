import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import DelayLine from './dsp/delay.ts'
import LFO from './dsp/lfo.ts'

const MAX_DELAY_MS = 10
const bufferSize = Math.ceil((SAMPLE_RATE * MAX_DELAY_MS) / 1000)

/**
 * Applies a flanger effect through LFO-modulated delay.
 * @public
 */
export default class Flanger extends BaseFilter {
    public priority = 10
    private lfo: LFO
    private delayLine: DelayLine
    private rate = 0
    private depth = 0
    private feedback = 0

    constructor() {
        super()
        this.lfo = new LFO('SINE')
        this.delayLine = new DelayLine(bufferSize)
    }

    /**
     * Updates the flanger settings.
     * @param settings - Filter settings containing `flanger`.
     */
    public override update(settings: FilterSettings): void {
        const flanger = settings.flanger || {}

        this.rate = flanger.rate || 0
        this.depth = Math.max(0, Math.min(flanger.depth || 0, 1.0))
        this.feedback = Math.max(0, Math.min(flanger.feedback || 0, 0.95))

        this.lfo.update(this.rate, this.depth)
    }

    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    public override process(chunk: Buffer): Buffer {
        if (this.rate === 0 || this.depth === 0) {
            return chunk
        }

        const maxDelayWidth = this.depth * (SAMPLE_RATE * 0.005)
        const centerDelay = maxDelayWidth

        for (let i = 0; i < chunk.length; i += 2) {
            const sample = chunk.readInt16LE(i)

            const lfoValue = this.lfo.getValue()
            const delay = centerDelay + lfoValue * maxDelayWidth

            const delayed = this.delayLine.read(delay)
            const input = sample + delayed * this.feedback
            this.delayLine.write(clamp16Bit(input))

            const output = sample + delayed
            chunk.writeInt16LE(clamp16Bit(output), i)
        }

        return chunk
    }

    /**
     * Flushes any pending data.
     * @returns An empty Buffer.
     */
    public override flush(): Buffer {
        this.delayLine.clear()
        this.lfo.phase = 0
        return Buffer.alloc(0)
    }
}
