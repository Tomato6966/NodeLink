import { Transform, type TransformCallback } from 'node:stream'
import type { AudioMixer, FiltersState } from '../../typings/playback/player.types.ts'
import type { IVolumeTransformer, IFadeTransformer, IFiltersManager } from '../../typings/playback/processing.types.ts'

const FRAME_SIZE = 3840

/**
 * Controller that coordinates filters, volume, fading, and mixing in a single stream.
 * @public
 */
export class FlowController extends Transform {
    private readonly filters: IFiltersManager
    private readonly volume: IVolumeTransformer
    private readonly fade: IFadeTransformer
    private readonly audioMixer: AudioMixer | null
    private pending: Buffer

    /**
     * Creates a new FlowController.
     * @param filters - The FiltersManager instance.
     * @param volume - The VolumeTransformer instance.
     * @param fade - The FadeTransformer instance.
     * @param audioMixer - Optional AudioMixer instance.
     */
    constructor(
        filters: IFiltersManager,
        volume: IVolumeTransformer,
        fade: IFadeTransformer,
        audioMixer: AudioMixer | null = null
    ) {
        super({ highWaterMark: FRAME_SIZE * 4 })

        this.filters = filters
        this.volume = volume
        this.fade = fade
        this.audioMixer = audioMixer
        this.pending = Buffer.alloc(0)
    }

    /**
     * Sets the volume gain.
     * @param volume - New volume level.
     */
    public setVolume(volume: number): void {
        this.volume.setVolume(volume)
    }

    /**
     * Updates the audio filters.
     * @param filters - New filters state.
     */
    public setFilters(filters: FiltersState): void {
        this.filters.update(filters)
    }

    /**
     * Sets the fade gain immediately.
     * @param volume - New fade volume.
     */
    public setFadeVolume(volume: number): void {
        this.fade.setGain(volume)
    }

    /**
     * Schedules a fade effect.
     * @param volume - Target volume.
     * @param durationMs - Duration of the fade in milliseconds.
     * @param curve - Fading curve type.
     */
    public fadeTo(volume: number, durationMs: number, curve?: string): void {
        this.fade.fadeTo(volume, durationMs, curve)
    }

    public override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback
    ): void {
        this.pending = Buffer.concat([this.pending, chunk])

        while (this.pending.length >= FRAME_SIZE) {
            const processed = Buffer.allocUnsafe(FRAME_SIZE)
            this.pending.copy(processed, 0, 0, FRAME_SIZE)
            this.pending = Buffer.from(this.pending.subarray(FRAME_SIZE))

            let output: Buffer = processed

            output = this.filters.process(output)
            output = this.volume.process(output)
            output = this.fade.process(output)

            if (
                this.audioMixer &&
                this.audioMixer.enabled !== false &&
                this.audioMixer.hasActiveLayers()
            ) {
                try {
                    const layerChunks = this.audioMixer.readLayerChunks(output.length)
                    output = this.audioMixer.mixBuffers(output, layerChunks)
                } catch (_error) {
                    // Ignore mixing errors in flow
                }
            }

            this.push(output)
        }

        callback()
    }

    public override _flush(callback: TransformCallback): void {
        let remaining = this.pending
        this.pending = Buffer.alloc(0)

        remaining = Buffer.concat([remaining, this.filters.flush()])

        if (remaining.length > 0) {
            remaining = this.volume.process(remaining)
            remaining = this.fade.process(remaining)

            if (
                this.audioMixer &&
                this.audioMixer.enabled !== false &&
                this.audioMixer.hasActiveLayers()
            ) {
                try {
                    const layerChunks = this.audioMixer.readLayerChunks(remaining.length)
                    remaining = this.audioMixer.mixBuffers(remaining, layerChunks)
                } catch (_error) {
                    // Ignore mixing errors in flow
                }
            }

            const finalRemainder = remaining.length % 4
            if (finalRemainder > 0) {
                remaining = remaining.subarray(0, remaining.length - finalRemainder)
            }

            if (remaining.length > 0) this.push(remaining)
        }

        callback()
    }
}
