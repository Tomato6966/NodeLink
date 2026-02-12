import { SAMPLE_RATE } from '../../constants.ts'
import type { FilterSettings } from '../../typings/playback/filters.types.ts'
import { BaseFilter } from './BaseFilter.ts'
import { clamp16Bit } from './dsp/clamp16Bit.ts'
import DelayLine from './dsp/delay.ts'

const COMB_DELAYS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_DELAYS = [556, 441, 341, 225]
const STEREO_SPREAD = 23
const SCALE_WET = 3.0
const SCALE_DRY = 2.0
const SCALE_DAMP = 0.4
const SCALE_ROOM = 0.28
const OFFSET_ROOM = 0.7

/**
 * Comb filter component for reverb.
 */
class CombFilter {
    private buffer: DelayLine
    private filterStore = 0
    private damp1 = 0
    private damp2 = 0
    private feedback = 0

    constructor(size: number) {
        this.buffer = new DelayLine(size)
    }

    /**
     * Sets the damping factor.
     * @param val - Damping value.
     */
    public setDamp(val: number): void {
        this.damp1 = val
        this.damp2 = 1 - val
    }

    /**
     * Sets the feedback factor.
     * @param val - Feedback value.
     */
    public setFeedback(val: number): void {
        this.feedback = val
    }

    /**
     * Processes a single audio sample.
     * @param input - The input sample.
     * @returns The processed output sample.
     */
    public process(input: number): number {
        const output = this.buffer.read(0)
        this.filterStore = output * this.damp2 + this.filterStore * this.damp1
        this.buffer.write(clamp16Bit(input + this.filterStore * this.feedback))
        return output
    }

    /**
     * Clears the filter inner buffer.
     */
    public clear(): void {
        this.buffer.clear()
        this.filterStore = 0
    }
}

/**
 * Applies a Freeverb-based reverb effect.
 * @public
 */
export default class Reverb extends BaseFilter {
    public priority = 10
    private combFiltersL: CombFilter[]
    private combFiltersR: CombFilter[]
    private allpassFiltersL: DelayLine[]
    private allpassFiltersR: DelayLine[]
    private allpassCoeff = 0.5
    private allpassStateL: Array<{ x1: number; y1: number }>
    private allpassStateR: Array<{ x1: number; y1: number }>

    private wet = 0
    private dry = 1.0
    private roomSize = 0.5
    private damping = 0.5
    private width = 1.0

    constructor() {
        super()
        this.combFiltersL = COMB_DELAYS.map(
            (delay) => new CombFilter(Math.floor((delay * SAMPLE_RATE) / 44100))
        )
        this.combFiltersR = COMB_DELAYS.map(
            (delay) =>
                new CombFilter(
                    Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100)
                )
        )

        this.allpassFiltersL = ALLPASS_DELAYS.map(
            (delay) => new DelayLine(Math.floor((delay * SAMPLE_RATE) / 44100))
        )
        this.allpassFiltersR = ALLPASS_DELAYS.map(
            (delay) =>
                new DelayLine(
                    Math.floor(((delay + STEREO_SPREAD) * SAMPLE_RATE) / 44100)
                )
        )

        this.allpassStateL = ALLPASS_DELAYS.map(() => ({ x1: 0, y1: 0 }))
        this.allpassStateR = ALLPASS_DELAYS.map(() => ({ x1: 0, y1: 0 }))
    }

    /**
     * Updates the reverb settings.
     * @param settings - Filter settings containing `reverb`.
     */
    public override update(settings: FilterSettings): void {
        const reverbSettings = settings.reverb || {}

        const mix = Math.max(0, Math.min(reverbSettings.mix || 0, 1.0))
        this.wet = mix * SCALE_WET
        this.dry = (1.0 - mix) * SCALE_DRY

        this.roomSize = Math.max(0, Math.min(reverbSettings.roomSize || 0.5, 1.0))
        const roomScaled = this.roomSize * SCALE_ROOM + OFFSET_ROOM

        this.damping = Math.max(0, Math.min(reverbSettings.damping || 0.5, 1.0))
        const dampScaled = this.damping * SCALE_DAMP

        this.width = Math.max(0, Math.min(reverbSettings.width || 1.0, 1.0))

        for (const comb of [...this.combFiltersL, ...this.combFiltersR]) {
            comb.setFeedback(roomScaled)
            comb.setDamp(dampScaled)
        }
    }

    /**
     * Processes a single all-pass stage.
     * @param input - The input sample.
     * @param delayLine - The delay line for this stage.
     * @param state - The state for this stage.
     * @returns The processed output sample.
     */
    private processAllpass(
        input: number,
        delayLine: DelayLine,
        state: { x1: number; y1: number }
    ): number {
        const delayed = delayLine.read(0)
        const output = -input + delayed + this.allpassCoeff * (input - state.y1)

        delayLine.write(clamp16Bit(input))
        state.y1 = output

        return output
    }

    /**
     * Processes a PCM audio buffer.
     * @param chunk - PCM audio chunk.
     * @returns The processed PCM audio chunk.
     */
    public override process(chunk: Buffer): Buffer {
        if (this.wet === 0) {
            return chunk
        }

        for (let i = 0; i < chunk.length; i += 4) {
            const leftInput = chunk.readInt16LE(i)
            const rightInput = chunk.readInt16LE(i + 2)

            const monoInput = (leftInput + rightInput) * 0.5

            let leftOut = 0
            let rightOut = 0

            for (let j = 0; j < this.combFiltersL.length; j++) {
                const combL = this.combFiltersL[j]
                const combR = this.combFiltersR[j]
                if (combL && combR) {
                    leftOut += combL.process(monoInput)
                    rightOut += combR.process(monoInput)
                }
            }

            for (let j = 0; j < this.allpassFiltersL.length; j++) {
                const passL = this.allpassFiltersL[j]
                const stateL = this.allpassStateL[j]
                const passR = this.allpassFiltersR[j]
                const stateR = this.allpassStateR[j]

                if (passL && stateL && passR && stateR) {
                    leftOut = this.processAllpass(leftOut, passL, stateL)
                    rightOut = this.processAllpass(rightOut, passR, stateR)
                }
            }

            const wet1 = this.wet * (this.width * 0.5 + 0.5)
            const wet2 = this.wet * ((1.0 - this.width) * 0.5)

            const finalLeft = leftInput * this.dry + leftOut * wet1 + rightOut * wet2
            const finalRight =
                rightInput * this.dry + rightOut * wet1 + leftOut * wet2

            chunk.writeInt16LE(clamp16Bit(finalLeft), i)
            chunk.writeInt16LE(clamp16Bit(finalRight), i + 2)
        }

        return chunk
    }

    /**
     * Clears the reverb state.
     */
    public override flush(): Buffer {
        for (const comb of [...this.combFiltersL, ...this.combFiltersR]) {
            comb.clear()
        }

        for (const allpass of [...this.allpassFiltersL, ...this.allpassFiltersR]) {
            allpass.clear()
        }

        for (const state of [...this.allpassStateL, ...this.allpassStateR]) {
            state.x1 = 0
            state.y1 = 0
        }

        return Buffer.alloc(0)
    }
}
