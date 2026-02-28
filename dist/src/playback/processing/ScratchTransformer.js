import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
/**
 * Resampling audio transformer that simulates physical vinyl scratching.
 *
 * Uses a circular Float32Array buffer to maintain audio history, allowing
 * for bidirectional playback (forward and reverse) without re-allocating memory.
 * This keeps RSS (Resident Set Size) stable and prevents GC pressure.
 *
 * @public
 */
export class ScratchTransformer extends Transform {
    sampleRate;
    channels;
    currentRate = 1.0;
    state = null;
    _lastEffectCompleted = false;
    /**
     * Internal circular buffer for storing PCM samples.
     * Storing as floats (0.0 to 1.0) simplifies resampling math.
     */
    inputBuffer;
    inputReadPos = 0;
    inputWritePos = 0;
    maxBufferSize;
    /**
     * Creates a new ScratchTransformer instance.
     * @param options - Configuration options containing sample rate and channels.
     */
    constructor(options = {}) {
        super();
        this.sampleRate = options.sampleRate ?? 48000;
        this.channels = options.channels ?? 2;
        // 5 seconds of buffer to allow for long backspins or slow movements.
        this.maxBufferSize = this.sampleRate * this.channels * 5;
        this.inputBuffer = new Float32Array(this.maxBufferSize);
    }
    /**
     * Triggers a scratch movement.
     * @param durationMs - Total time for the movement to complete.
     * @param style - The character of the scratch (e.g., 'backspin', 'wash').
     */
    scratchTo(durationMs, style) {
        const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 500;
        this._lastEffectCompleted = false;
        // Allow true instant reset/arm behavior when duration is explicitly zero.
        if (duration === 0) {
            this.currentRate = style === 'start' ? 1.0 : 0.0;
            this.state = null;
            this._lastEffectCompleted = true;
            return;
        }
        // If 'random' is selected, we provide a seed to the rate calculator
        // to diversify the movement.
        this.state = {
            style,
            durationMs: duration,
            elapsedMs: 0,
            startRate: this.currentRate,
            targetRate: style === 'start' ? 1.0 : 0.0,
            seed: Math.random()
        };
    }
    /**
     * Returns true if a scratch effect is currently being applied.
     */
    isActive() {
        return this.state !== null || Math.abs(this.currentRate - 1.0) > 0.001;
    }
    /**
     * Checks if the last triggered ramp has finished.
     * Resets the internal flag upon calling.
     */
    checkEffectCompleted() {
        if (this._lastEffectCompleted) {
            this._lastEffectCompleted = false;
            return true;
        }
        return false;
    }
    /**
     * Core math for rate modulation. Simulates the physics of a DJ's hand.
     * @param t - Progress of the effect (0.0 to 1.0).
     * @param state - Current scratch configuration.
     * @returns The playback rate (can be negative for reverse).
     */
    _calculateRate(t, state) {
        const s = state.seed;
        let style = state.style;
        if (style === 'random') {
            // Map random to a transitional style based on target
            style = state.targetRate > 0 ? 'start' : s > 0.5 ? 'backspin' : 'wash';
        }
        switch (style) {
            case 'wash':
                // Fast deceleration with a "friction bounce" at the end.
                if (t < 0.6)
                    return state.startRate * (1 - t / 0.6) ** 2.5;
                // Mechanical bounce: stronger oscillation to be audible.
                return Math.sin((t - 0.6) * 25) * (0.4 + s * 0.2) * (1 - t);
            case 'backspin':
                // Rapidly spins the record backwards.
                if (t < 0.15)
                    return state.startRate * (1 - t * 6.6); // Cross zero fast
                if (t < 0.8)
                    return -3.0 - s * 5.0 * (1 - t); // Higher speed reverse
                return -0.8 * (1 - t); // Slow down to stop
            case 'baby':
                // Rhythmic forward/backward oscillation (the classic 'wicka-wicka').
                return Math.cos(t * Math.PI * (5 + s * 3)) * (1 - t);
            case 'start':
                // Initial push: More dramatic acceleration.
                if (t < 0.5)
                    return (t / 0.5) ** 2 * 1.5; // Quadratic ramp to 1.5x speed
                return 1.5 - ((t - 0.5) / 0.5) * 0.5; // Settle back to 1.0
            case 'stop':
                // Standard vinyl brake simulation.
                return state.startRate * (1 - t ** 2.2);
            default:
                return 1 - t;
        }
    }
    /**
     * Inherited transform method for stream processing.
     */
    _transform(chunk, _encoding, callback) {
        if (chunk.length === 0) {
            callback();
            return;
        }
        this.push(this.process(chunk));
        callback();
    }
    /**
     * Processes a PCM buffer and applies the current resampling rate.
     * @param chunk - Input buffer containing 16-bit LE PCM data.
     * @returns Resampled audio buffer.
     */
    process(chunk) {
        if (chunk.length === 0)
            return chunk;
        const incomingSamples = chunk.length / 2;
        const incomingFrames = incomingSamples / this.channels;
        // Ensure the ring buffer has space, compacting history if necessary.
        if (this.inputWritePos + incomingSamples > this.maxBufferSize) {
            this._compact();
        }
        // Convert Int16 to Float32 for internal processing.
        for (let i = 0; i < incomingSamples; i++) {
            this.inputBuffer[this.inputWritePos++] = chunk.readInt16LE(i * 2) / 32767;
        }
        const outI16 = new Int16Array(incomingSamples);
        const frameDurationMs = 1000 / this.sampleRate;
        // Initial Buffering: If we are at the very start of the track,
        // let the buffer fill a bit before we start reading at 1.0.
        // This provides "future" samples for movements > 1.0.
        const latencyFrames = 1024; // ~21ms at 48kHz
        if (!this.state &&
            this.currentRate === 1.0 &&
            this.inputWritePos < latencyFrames * this.channels * 2) {
            // Just pass through and keep read head at 0 until we have some slack
            this.inputReadPos = 0;
            return chunk;
        }
        for (let f = 0; f < incomingFrames; f++) {
            if (this.state) {
                this.state.elapsedMs += frameDurationMs;
                const t = Math.min(1.0, this.state.elapsedMs / this.state.durationMs);
                this.currentRate = this._calculateRate(t, this.state);
                if (t >= 1.0) {
                    this.currentRate = this.state.targetRate;
                    this.state = null;
                    this._lastEffectCompleted = true;
                }
            }
            // If rate is negligible and no effect is active, fill with silence.
            if (Math.abs(this.currentRate) < 0.01 && !this.state) {
                for (let c = 0; c < this.channels; c++)
                    outI16[f * this.channels + c] = 0;
                continue;
            }
            // High-quality Cubic Hermite Spline Interpolation for resampling.
            const iPos = Math.floor(this.inputReadPos / this.channels) * this.channels;
            // Ensure we have enough neighbors for the cubic algorithm.
            // We clamp to inputWritePos - channels * 3 to avoid reading junk data.
            const safeIPos = Math.max(this.channels, Math.min(this.inputWritePos - this.channels * 3, iPos));
            const frac = (this.inputReadPos - iPos) / this.channels;
            for (let c = 0; c < this.channels; c++) {
                const p0 = this.inputBuffer[safeIPos - this.channels + c] || 0;
                const p1 = this.inputBuffer[safeIPos + c] || 0;
                const p2 = this.inputBuffer[safeIPos + this.channels + c] || 0;
                const p3 = this.inputBuffer[safeIPos + this.channels * 2 + c] || 0;
                const val = 0.5 *
                    (2 * p1 +
                        (-p0 + p2) * frac +
                        (2 * p0 - 5 * p1 + 4 * p2 - p3) * frac * frac +
                        (-p0 + 3 * p1 - 3 * p2 + p3) * frac * frac * frac);
                outI16[f * this.channels + c] = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
            }
            // Update the read position (supports negative movement).
            this.inputReadPos += this.currentRate * this.channels;
            // Clamp read position to stored history.
            if (this.inputReadPos < this.channels)
                this.inputReadPos = this.channels;
            if (this.inputReadPos >= this.inputWritePos)
                this.inputReadPos = this.inputWritePos - 1;
        }
        return Buffer.from(outI16.buffer, outI16.byteOffset, outI16.byteLength);
    }
    /**
     * Shifts the circular buffer to free up space while preserving 1s of history.
     * This allows the "disk" to be pulled backwards immediately even at the start of a chunk.
     */
    _compact() {
        const historyFrames = this.sampleRate * 1;
        const keepSamples = historyFrames * this.channels;
        const integralReadPos = Math.floor(this.inputReadPos / this.channels) * this.channels;
        const copyStart = Math.max(0, integralReadPos - keepSamples);
        if (copyStart <= 0)
            return;
        const remaining = this.inputWritePos - copyStart;
        this.inputBuffer.copyWithin(0, copyStart, this.inputWritePos);
        this.inputReadPos -= copyStart;
        this.inputWritePos = remaining;
    }
}
