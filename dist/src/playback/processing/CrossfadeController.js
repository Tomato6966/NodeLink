import { Transform } from 'node:stream';
import { logger } from "../../utils.js";
import { RingBuffer } from "../structs/RingBuffer.js";
const HALF_PI = Math.PI / 2;
const DEFAULT_CURVE = 'sinusoidal';
const SUPPORTED_CURVES = new Set(['linear', 'sine', 'sinusoidal']);
/**
 * Crossfade controller that mixes a buffered next track into the main PCM stream.
 *
 * @remarks
 * - The next track is buffered ahead of time and mixed only during the fade window.
 * - Mixing uses constant-power curves by default to avoid volume dips.
 *
 * @example
 * ```ts
 * const controller = new CrossfadeController(48000, 2)
 * controller.prepareNextStream(nextPcmStream, { durationMs: 5000 })
 * controller.startCrossfade(5000, 'sinusoidal')
 * ```
 */
export class CrossfadeController extends Transform {
    sampleRate;
    channels;
    bytesPerMs;
    bufferSize;
    targetBufferBytes;
    minBufferBytes;
    ringBuffer = null;
    nextStream = null;
    nextPendingByte = null;
    mainPendingByte = null;
    crossfade = null;
    bufferReady = false;
    warnedCurve = null;
    onNextData = (chunk) => {
        if (!this.ringBuffer)
            return;
        let data = chunk;
        if (this.nextPendingByte !== null) {
            if (chunk.length === 0)
                return;
            const merged = Buffer.allocUnsafe(chunk.length + 1);
            merged[0] = this.nextPendingByte;
            chunk.copy(merged, 1);
            data = merged;
            this.nextPendingByte = null;
        }
        const remainder = data.length % 2;
        if (remainder > 0) {
            this.nextPendingByte = data[data.length - 1] ?? 0;
            data = data.subarray(0, data.length - remainder);
        }
        if (!data.length || !this.ringBuffer)
            return;
        const remaining = this.bufferSize - this.ringBuffer.length;
        if (remaining <= 0) {
            this._pauseNextStream();
            return;
        }
        if (data.length > remaining) {
            this.ringBuffer.write(data.subarray(0, remaining));
            this.bufferReady = true;
            this._pauseNextStream();
            return;
        }
        this.ringBuffer.write(data);
        if (this.ringBuffer.length >= this.targetBufferBytes) {
            this.bufferReady = true;
            this._pauseNextStream();
        }
    };
    onNextEnd = () => {
        this._pauseNextStream();
    };
    /**
     * Creates a new CrossfadeController.
     *
     * @param sampleRate - PCM sample rate (Hz).
     * @param channels - Number of audio channels.
     * @example
     * ```ts
     * const controller = new CrossfadeController(48000, 2)
     * ```
     */
    constructor(sampleRate = 48000, channels = 2) {
        super();
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.bytesPerMs = (this.sampleRate * this.channels * 2) / 1000;
        this.bufferSize = Math.round(this.bytesPerMs * 1000);
        this.targetBufferBytes = 0;
        this.minBufferBytes = 0;
    }
    /**
     * Prepares a buffered next track stream for crossfading.
     *
     * @param stream - PCM stream for the next track.
     * @param options - Buffering options.
     * @example
     * ```ts
     * controller.prepareNextStream(pcmStream, { durationMs: 4000 })
     * ```
     */
    prepareNextStream(stream, options) {
        this.clear();
        this.nextStream = stream;
        const durationMs = Math.max(0, options.durationMs);
        const minBufferMs = options.minBufferMs !== undefined
            ? Math.max(0, options.minBufferMs)
            : durationMs;
        const bufferMs = options.bufferMs !== undefined
            ? Math.max(minBufferMs, options.bufferMs)
            : durationMs;
        this.targetBufferBytes = Math.round(durationMs * this.bytesPerMs);
        this.minBufferBytes = Math.round(minBufferMs * this.bytesPerMs);
        this.bufferSize = Math.max(1, Math.round(bufferMs * this.bytesPerMs));
        this.ringBuffer = new RingBuffer(this.bufferSize);
        stream.on('data', this.onNextData);
        stream.once('end', this.onNextEnd);
        stream.once('close', this.onNextEnd);
        stream.once('error', this.onNextEnd);
    }
    /**
     * Returns the buffered duration (ms) available for crossfade.
     */
    getBufferedMs() {
        if (!this.ringBuffer)
            return 0;
        return this.ringBuffer.length / this.bytesPerMs;
    }
    /**
     * Returns the current crossfade status.
     */
    getState() {
        return {
            active: this.crossfade !== null,
            bufferedMs: this.getBufferedMs(),
            targetMs: this.targetBufferBytes / this.bytesPerMs
        };
    }
    /**
     * Indicates whether enough audio is buffered to start crossfade.
     */
    isReady() {
        if (!this.ringBuffer)
            return false;
        if (this.bufferReady)
            return true;
        return this.ringBuffer.length >= this.minBufferBytes;
    }
    /**
     * Starts the crossfade mix.
     *
     * @param durationMs - Crossfade duration in milliseconds.
     * @param curve - Fade curve to apply.
     * @returns True when crossfade has started.
     * @example
     * ```ts
     * if (controller.isReady()) {
     *   controller.startCrossfade(3000, 'linear')
     * }
     * ```
     */
    startCrossfade(durationMs, curve) {
        if (!this.ringBuffer || !this.isReady())
            return false;
        if (!Number.isFinite(durationMs) || durationMs <= 0)
            return false;
        this.crossfade = {
            durationMs,
            elapsedMs: 0,
            curve: this._resolveCurve(curve)
        };
        return true;
    }
    /**
     * Clears the buffered next track and resets crossfade state.
     */
    clear() {
        if (this.nextStream) {
            this.nextStream.removeListener('data', this.onNextData);
            this.nextStream.removeListener('end', this.onNextEnd);
            this.nextStream.removeListener('close', this.onNextEnd);
            this.nextStream.removeListener('error', this.onNextEnd);
        }
        this._pauseNextStream();
        this.nextStream = null;
        this.nextPendingByte = null;
        this.mainPendingByte = null;
        this.crossfade = null;
        this.bufferReady = false;
        this.targetBufferBytes = 0;
        this.minBufferBytes = 0;
        this.ringBuffer?.dispose();
        this.ringBuffer = null;
    }
    _pauseNextStream() {
        const stream = this.nextStream;
        if (!stream)
            return;
        if (typeof stream.pause === 'function')
            stream.pause();
    }
    _resolveCurve(curve) {
        if (!curve)
            return DEFAULT_CURVE;
        if (SUPPORTED_CURVES.has(curve))
            return curve;
        if (this.warnedCurve !== curve) {
            this.warnedCurve = curve;
            logger('warn', 'Crossfade', `Unsupported curve "${curve}", falling back to ${DEFAULT_CURVE}.`);
        }
        return DEFAULT_CURVE;
    }
    _mixBuffers(main, next, runtime) {
        const sampleCount = main.length >> 1;
        if (sampleCount === 0)
            return main;
        const output = Buffer.allocUnsafe(main.length);
        const mainAligned = main.byteOffset % 2 === 0;
        const nextAligned = next.byteOffset % 2 === 0;
        const outAligned = output.byteOffset % 2 === 0;
        const mainView = mainAligned
            ? new Int16Array(main.buffer, main.byteOffset, sampleCount)
            : null;
        const nextView = nextAligned
            ? new Int16Array(next.buffer, next.byteOffset, sampleCount)
            : null;
        const outView = outAligned
            ? new Int16Array(output.buffer, output.byteOffset, sampleCount)
            : null;
        const frames = sampleCount / this.channels;
        const chunkDurationMs = (frames / this.sampleRate) * 1000;
        const durationMs = runtime.durationMs;
        const startProgress = Math.min(1, runtime.elapsedMs / durationMs);
        const endProgress = Math.min(1, (runtime.elapsedMs + chunkDurationMs) / durationMs);
        const [startOut, startIn] = this._fadeGains(startProgress, runtime.curve);
        const [endOut, endIn] = this._fadeGains(endProgress, runtime.curve);
        const stepOut = sampleCount > 1 ? (endOut - startOut) / (sampleCount - 1) : 0;
        const stepIn = sampleCount > 1 ? (endIn - startIn) / (sampleCount - 1) : 0;
        let gainOut = startOut;
        let gainIn = startIn;
        const getMain = (i) => mainView ? (mainView[i] ?? 0) : main.readInt16LE(i * 2);
        const getNext = (i) => nextView ? (nextView[i] ?? 0) : next.readInt16LE(i * 2);
        const setOut = (i, val) => {
            if (outView)
                outView[i] = val;
            else
                output.writeInt16LE(val, i * 2);
        };
        for (let i = 0; i < sampleCount; i++) {
            const mixed = getMain(i) * gainOut + getNext(i) * gainIn;
            const clamped = mixed < -32768 ? -32768 : mixed > 32767 ? 32767 : Math.round(mixed);
            setOut(i, clamped);
            gainOut += stepOut;
            gainIn += stepIn;
        }
        runtime.elapsedMs += chunkDurationMs;
        if (runtime.elapsedMs >= runtime.durationMs) {
            this.crossfade = null;
        }
        return output;
    }
    _fadeGains(progress, curve) {
        const clamped = Math.min(1, Math.max(0, progress));
        if (curve === 'linear') {
            return [1 - clamped, clamped];
        }
        const fadeOut = Math.cos(clamped * HALF_PI);
        const fadeIn = Math.sin(clamped * HALF_PI);
        return [fadeOut, fadeIn];
    }
    _transform(chunk, _encoding, callback) {
        let data = chunk;
        if (this.mainPendingByte !== null) {
            if (chunk.length === 0) {
                callback();
                return;
            }
            const merged = Buffer.allocUnsafe(chunk.length + 1);
            merged[0] = this.mainPendingByte;
            chunk.copy(merged, 1);
            data = merged;
            this.mainPendingByte = null;
        }
        const remainder = data.length % 2;
        if (remainder > 0) {
            this.mainPendingByte = data[data.length - 1] ?? 0;
            data = data.subarray(0, data.length - remainder);
        }
        if (!data.length || !this.crossfade || !this.ringBuffer) {
            if (data.length)
                this.push(data);
            callback();
            return;
        }
        const nextChunk = this.ringBuffer.read(data.length);
        if (!nextChunk) {
            this.push(data);
            callback();
            return;
        }
        let paddedNext = nextChunk;
        if (nextChunk.length !== data.length) {
            paddedNext = Buffer.allocUnsafe(data.length);
            paddedNext.fill(0);
            nextChunk.copy(paddedNext, 0, 0, nextChunk.length);
        }
        this.push(this._mixBuffers(data, paddedNext, this.crossfade));
        callback();
    }
    _final(callback) {
        this.clear();
        callback();
    }
}
