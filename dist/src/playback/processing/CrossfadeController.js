import fs from 'node:fs';
import { Transform } from 'node:stream';
import { logger } from "../../utils.js";
import { RingBuffer } from "../structs/RingBuffer.js";
import { estimateBpmFromOnsets, estimateBpmFromPcm } from "./bpmDetector.js";
import { estimateKeyFromPcm } from "./keyDetector.js";
import { RealtimeBpmTracker } from "./realtimeBpmTracker.js";
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const DEFAULT_CURVE = 'sinusoidal';
const SUPPORTED_CURVES = new Set(['linear', 'sine', 'sinusoidal']);
const SOFT_CLIP_THRESHOLD = 28000;
const SOFT_CLIP_HEADROOM = 32767 - SOFT_CLIP_THRESHOLD;
const MIX_BUS_TARGET_PEAK = 27500;
const MIX_BUS_TARGET_PEAK_FUSION = 26200;
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
    nextPending = null;
    nextSpillChunks = [];
    nextSpillBytes = 0;
    mainPending = null;
    crossfade = null;
    bufferReady = false;
    warnedCurve = null;
    _bridgePumpRunning = false;
    _flushed = false;
    _pumpPaused = false;
    _pumpPausedAt = 0;
    _pumpTotalPausedMs = 0;
    _bcfStream = null;
    _bcfRing = null;
    _bcfPending = null;
    _bcfSpillChunks = [];
    _bcfSpillBytes = 0;
    _bcfReady = false;
    _bcfTargetBytes = 0;
    _bcfMinBytes = 0;
    _bcfBufferSize = 0;
    _bcfRuntime = null;
    _bcfHpPrevL = 0;
    _bcfHpPrevR = 0;
    _bcfLpPrevL = 0;
    _bcfLpPrevR = 0;
    _bridgeCrossfadeActive = false;
    _bcfConsumedSamples = 0;
    /** Freezes _bcfConsumedSamples after blend completes to prevent drift. */
    _bcfCountFrozen = false;
    _hpEnabled = false;
    _hpDurationFrames = 0;
    _hpPeakAlpha = 0.06;
    _hpPrevL = 0;
    _hpPrevR = 0;
    _lpEnabled = false;
    _lpPeakAlpha = 0.08;
    _lpPrevL = 0;
    _lpPrevR = 0;
    /** Fraction of crossfade over which the LP filter opens (default 0.50). */
    _lpCompletionRatio = 0.5;
    _mainRmsEma = 0;
    _mainRmsPeak = 0;
    _onsetBuffer = [];
    _prevRmsForOnset = 0;
    _detectedMainBpm = null;
    _mainBpmDetected = false;
    /** Approx. onset samples per second (derived from chunk cadence). */
    _onsetChunkMs = 20;
    _mainKeyPcm = [];
    _mainKeyPcmBytes = 0;
    _mainKeyDetected = false;
    _detectedMainKey = null;
    /** Max bytes to capture for key detection (~10 s stereo 48 kHz 16-bit). */
    get _mainKeyMaxBytes() {
        return this.sampleRate * this.channels * 2 * 10;
    }
    _nextRmsEma = 0;
    _nextRmsPeak = 0;
    _nextOpeningEnergyAcc = 0;
    _nextOpeningEnergyMs = 0;
    _nextOpeningEnergy = 0;
    _nextOpeningWindowMs = 4000;
    _nextOnsetBuffer = [];
    _nextPrevRmsForOnset = 0;
    _detectedNextBpm = null;
    _nextBpmDetected = false;
    _nextOnsetChunkMs = 20;
    _nextBeatTracker = new RealtimeBpmTracker();
    _nextBeatState = this._nextBeatTracker.getState();
    _lastRealtimeNextBpmLogSec = 0;
    _nextKeyPcm = [];
    _nextKeyPcmBytes = 0;
    _nextKeyDetected = false;
    _detectedNextKey = null;
    get _nextKeyMaxBytes() {
        return this.sampleRate * this.channels * 2 * 10;
    }
    _totalNextConsumedSamples = 0;
    _incomingGain = 1;
    _showcaseHistoryPcm = [];
    _showcaseHistoryBytes = 0;
    _showcaseHistoryMaxBytes = 0;
    _showcaseWriter = null;
    _showcaseRemainingBytes = 0;
    _showcaseTargetFile = '';
    /**
     * Called once after the bridge pump fully drains Track B's ring buffer.
     * Set by the player to flush deferred filter state into the live pipeline.
     */
    onBridgeDrained = null;
    /**
     * Called when the bridge pump is about to exhaust (ring empty, stream dead)
     * and no B→C blend is active.  The player uses this to fire the pending
     * crossfade timer immediately instead of letting the bridge die.
     * After calling this, the bridge pump pushes silence frames for up to
     * MAX_BRIDGE_SILENCE_MS while waiting for a bridge crossfade to appear.
     */
    onBridgeStarving = null;
    /**
     * Optional synchronous filter processor for bridge-pump audio.
     *
     * During bridge mode, audio bypasses the upstream FiltersManager because
     * `this.push()` writes directly to the readable side.  When set, the
     * bridge pump pipes each PCM chunk through this callback so that user-
     * applied filters (karaoke, lowpass, highpass, etc.) take effect.
     */
    filterProcessor = null;
    /**
     * Sets the upstream FiltersManager bypass flag.  When true, the upstream
     * _transform passes chunks through raw — all filter processing moves to
     * filterProcessor inside this controller, avoiding double-processing.
     */
    filterBypassSetter = null;
    /**
     * Resets the upstream FiltersManager's internal filter state (clears echo
     * delay lines, reverb buffers, etc.) so Track B audio never touches
     * stale Track A filter data.
     */
    filterStateResetter = null;
    /** Guards against triggering bypass/reset more than once per crossfade. */
    _bypassTriggered = false;
    _panEnabled = false;
    _panCompletionRatio = 0.3;
    _panOutEnabled = false;
    _panOutCompletionRatio = 0.5;
    _echoEnabled = false;
    _echoDelayFrames = 0;
    _echoPeakMix = 0.2;
    _echoFeedback = 0.3;
    /** Fraction of crossfade over which the echo dries out (default 0.65). */
    _echoCompletionRatio = 0.65;
    _echoDelayL = null;
    _echoDelayR = null;
    _echoWritePos = 0;
    _bcfEchoDelayL = null;
    _bcfEchoDelayR = null;
    _bcfEchoWritePos = 0;
    _energySkipMs = 0;
    _incomingEntryGainComp = 1;
    _entryPhraseConfidence = 0;
    _entryStability = 0;
    _entryFxCenterShield = 0;
    _entryFxLowDuckBoost = 0;
    _entryFxAirSoftenBoost = 0;
    _entryFxSidechainBoost = 0;
    // Clean-room dynamic transition state (tempo/energy/transient responsive)
    _dynamicMixEnabled = true;
    _dynamicNextRmsEma = 0;
    _dynamicNextTransientEma = 0;
    _dynamicMainBrightnessEma = 0;
    _dynamicNextBrightnessEma = 0;
    _dynamicToneMismatchEma = 1;
    _dynamicPrevMainL = 0;
    _dynamicPrevMainR = 0;
    _dynamicPrevNextL = 0;
    _dynamicPrevNextR = 0;
    _dynamicPulseHz = 0;
    _dynamicFrameCursor = 0;
    _dynamicPulsePhaseOffset = 0;
    _rtBeatTracker = new RealtimeBpmTracker();
    _rtBeatState = this._rtBeatTracker.getState();
    _lastRealtimeBpmLogSec = 0;
    _mainSpecLowLp = 0;
    _mainSpecMidLp = 0;
    _mainSpecHighLp = 0;
    _mainSpecPrevComposite = 0;
    _mainSpecBrightnessEma = 0.42;
    _mainSpecMotionEma = 0.22;
    _mainSpecCentroidEma = 0.38;
    _mainSpecLowAlpha = 0;
    _mainSpecMidAlpha = 0;
    _mainSpecHighAlpha = 0;
    // Live multiband unmasking for "medley-like" overlap instead of plain fade.
    _adaptiveBandBlendEnabled = true;
    _mixBandLowAlpha = 0;
    _mixBandHighAlpha = 0;
    _mixMainLowLpL = 0;
    _mixMainLowLpR = 0;
    _mixNextLowLpL = 0;
    _mixNextLowLpR = 0;
    _mixMainHighLpL = 0;
    _mixMainHighLpR = 0;
    _mixNextHighLpL = 0;
    _mixNextHighLpR = 0;
    // Incoming fusion sculpting: environment first, vocal core later.
    _transitionName = null;
    _strictNoVocalEntry = false;
    _fusionBlendEnabled = true;
    _fusionTailHoldEnabled = false;
    _fusionOutFloorPeak = 0.5;
    _fusionOutFloorTail = 0.05;
    _fusionBeatMorphEnabled = false;
    _fusionBeatMorphFromHz = 0;
    _fusionBeatMorphToHz = 0;
    _fusionBeatMorphStrength = 0;
    _fusionMainLpL = 0;
    _fusionMainLpR = 0;
    _fusionMainLpAlpha = 0;
    _fusionAmbientLpL = 0;
    _fusionAmbientLpR = 0;
    _fusionBandLowLp = 0;
    _fusionBandHighLp = 0;
    _fusionPrevBand = 0;
    _fusionVocalPresenceEma = 0;
    _fusionBandLowAlpha = 0;
    _fusionBandHighAlpha = 0;
    _fusionAmbientAlpha = 0;
    /**
     * Whether the PCM source should be paused when the ring buffer is full.
     * After the crossfade blend finishes, we allow a much larger buffer
     * (ring + spill) so the bridge pump never starves.
     */
    _shouldPausePcm() {
        const total = (this.ringBuffer?.length ?? 0) + this.nextSpillBytes;
        if (this.crossfade?.isFinished) {
            return total > this.bufferSize + Math.round(5000 * this.bytesPerMs);
        }
        return total >= this.bufferSize;
    }
    onNextData = (chunk) => {
        if (!this.ringBuffer)
            return;
        let data = chunk;
        if (this.nextPending && this.nextPending.length > 0) {
            data = Buffer.concat([this.nextPending, chunk]);
            this.nextPending = null;
        }
        const remainder = data.length % 4;
        if (remainder > 0) {
            this.nextPending = Buffer.from(data.subarray(data.length - remainder));
            data = data.subarray(0, data.length - remainder);
        }
        if (!data.length || !this.ringBuffer)
            return;
        this._updateNextTrackAnalysis(data);
        this._drainSpillToRing();
        const remaining = this.bufferSize - this.ringBuffer.length;
        if (remaining <= 0) {
            this._appendSpill(data);
            if (this._shouldPausePcm())
                this._pauseNextStream();
            return;
        }
        if (data.length > remaining) {
            this.ringBuffer.write(data.subarray(0, remaining));
            this._appendSpill(data.subarray(remaining));
            this.bufferReady = true;
            if (this._shouldPausePcm())
                this._pauseNextStream();
            return;
        }
        this.ringBuffer.write(data);
        if (this.ringBuffer.length >= this.targetBufferBytes) {
            this.bufferReady = true;
            if (this._shouldPausePcm())
                this._pauseNextStream();
        }
    };
    onNextEnd = () => {
        this._pauseNextStream();
    };
    _appendSpill(data) {
        if (!data.length)
            return;
        this.nextSpillChunks.push(Buffer.from(data));
        this.nextSpillBytes += data.length;
    }
    _drainSpillToRing() {
        if (!this.ringBuffer || this.nextSpillChunks.length === 0)
            return;
        let remaining = this.bufferSize - this.ringBuffer.length;
        if (remaining <= 0)
            return;
        remaining = remaining - (remaining % 4);
        if (remaining <= 0)
            return;
        while (remaining > 0 && this.nextSpillChunks.length > 0) {
            const chunk = this.nextSpillChunks[0];
            if (chunk.length <= remaining) {
                this.ringBuffer.write(chunk);
                remaining -= chunk.length;
                this.nextSpillBytes -= chunk.length;
                this.nextSpillChunks.shift();
            }
            else {
                const aligned = remaining - (remaining % 4);
                if (aligned <= 0)
                    break;
                this.ringBuffer.write(chunk.subarray(0, aligned));
                this.nextSpillChunks[0] = chunk.subarray(aligned);
                this.nextSpillBytes -= aligned;
                remaining -= aligned;
            }
        }
        if (this.ringBuffer.length >= this.targetBufferBytes) {
            this.bufferReady = true;
            this._pauseNextStream();
        }
    }
    _resumeNextStream() {
        const stream = this.nextStream;
        if (!stream)
            return;
        if (typeof stream.resume === 'function')
            stream.resume();
    }
    _onBcfData = (chunk) => {
        if (!this._bcfRing)
            return;
        let data = chunk;
        if (this._bcfPending && this._bcfPending.length > 0) {
            data = Buffer.concat([this._bcfPending, chunk]);
            this._bcfPending = null;
        }
        const remainder = data.length % 4;
        if (remainder > 0) {
            this._bcfPending = Buffer.from(data.subarray(data.length - remainder));
            data = data.subarray(0, data.length - remainder);
        }
        if (!data.length)
            return;
        this._bcfDrainSpill();
        const capacity = this._bcfBufferSize - this._bcfRing.length;
        if (capacity >= data.length) {
            this._bcfRing.write(data);
        }
        else if (capacity > 0) {
            this._bcfRing.write(data.subarray(0, capacity));
            this._bcfSpillChunks.push(Buffer.from(data.subarray(capacity)));
            this._bcfSpillBytes += data.length - capacity;
        }
        else {
            this._bcfSpillChunks.push(Buffer.from(data));
            this._bcfSpillBytes += data.length;
        }
        if (!this._bcfReady && this._bcfRing.length >= this._bcfMinBytes) {
            this._bcfReady = true;
        }
        const total = this._bcfRing.length + this._bcfSpillBytes;
        if (total >= this._bcfBufferSize && this._bcfStream) {
            if (typeof this._bcfStream.pause === 'function') {
                ;
                this._bcfStream.pause();
            }
        }
    };
    _onBcfEnd = () => {
        if (this._bcfRing && this._bcfRing.length > 0) {
            this._bcfReady = true;
        }
    };
    _bcfDrainSpill() {
        if (!this._bcfRing || this._bcfSpillChunks.length === 0)
            return;
        let remaining = this._bcfBufferSize - this._bcfRing.length;
        if (remaining <= 0)
            return;
        remaining = remaining - (remaining % 4);
        if (remaining <= 0)
            return;
        while (remaining > 0 && this._bcfSpillChunks.length > 0) {
            const chunk = this._bcfSpillChunks[0];
            if (chunk.length <= remaining) {
                this._bcfRing.write(chunk);
                remaining -= chunk.length;
                this._bcfSpillBytes -= chunk.length;
                this._bcfSpillChunks.shift();
            }
            else {
                const aligned = remaining - (remaining % 4);
                if (aligned <= 0)
                    break;
                this._bcfRing.write(chunk.subarray(0, aligned));
                this._bcfSpillChunks[0] = chunk.subarray(aligned);
                this._bcfSpillBytes -= aligned;
                remaining -= aligned;
            }
        }
    }
    _bcfResumeStream() {
        if (!this._bcfStream)
            return;
        const total = (this._bcfRing?.length ?? 0) + this._bcfSpillBytes;
        const limit = this._bcfBufferSize + Math.round(5000 * this.bytesPerMs);
        if (total < limit &&
            typeof this._bcfStream.resume === 'function') {
            ;
            this._bcfStream.resume();
        }
    }
    /**
     * Prepares a bridge crossfade by buffering Track C's PCM while the
     * bridge pump is actively draining Track B.
     */
    _prepareBridgeCrossfade(stream, options) {
        this._clearBridgeCrossfade();
        const durationMs = Math.max(0, options.durationMs);
        const minBufferMs = options.minBufferMs ?? durationMs;
        const bufferMs = options.bufferMs !== undefined && options.bufferMs > 0
            ? Math.max(minBufferMs, options.bufferMs)
            : durationMs;
        this._bcfTargetBytes = Math.round(durationMs * this.bytesPerMs);
        this._bcfMinBytes = Math.round(minBufferMs * this.bytesPerMs);
        this._bcfBufferSize = Math.round(bufferMs * this.bytesPerMs);
        this._bcfRing = new RingBuffer(this._bcfBufferSize + Math.round(10000 * this.bytesPerMs));
        this._bcfStream = stream;
        this._bcfReady = false;
        stream.on('data', this._onBcfData);
        stream.on('end', this._onBcfEnd);
        stream.on('close', this._onBcfEnd);
        stream.on('error', this._onBcfEnd);
        if (typeof stream.resume === 'function') {
            ;
            stream.resume();
        }
        logger('debug', 'Crossfade', 'Bridge crossfade: buffering Track C', {
            durationMs,
            minBufferMs,
            bufferMs
        });
    }
    /**
     * Activates the bridge crossfade blend inside the bridge pump.
     * @returns True when blend has been activated.
     */
    _startBridgeCrossfade(durationMs, curve) {
        if (!this._bcfRing || !this._bcfReady)
            return false;
        const durationFrames = Math.max(1, Math.round((durationMs / 1000) * this.sampleRate));
        this._bcfRuntime = {
            durationFrames,
            elapsedFrames: 0,
            curve: this._resolveCurve(curve),
            isFinished: false
        };
        this._transitionName = null;
        this._resetDynamicMixState();
        this._bootstrapDynamicPulse();
        this._configureFusionMixProfile(durationFrames);
        this._bcfHpPrevL = 0;
        this._bcfHpPrevR = 0;
        this._bridgeCrossfadeActive = true;
        this._bcfConsumedSamples = 0;
        this._bcfCountFrozen = false;
        this._energySkipMs = 0;
        this._incomingEntryGainComp = 1;
        this._entryPhraseConfidence = 0;
        this._entryStability = 0;
        this._entryFxCenterShield = 0;
        this._entryFxLowDuckBoost = 0;
        this._entryFxAirSoftenBoost = 0;
        this._entryFxSidechainBoost = 0;
        this.filterBypassSetter?.(false);
        logger('info', 'Crossfade', 'Bridge crossfade: blend starting', {
            durationMs,
            curve: this._bcfRuntime.curve
        });
        return true;
    }
    /**
     * Checks whether Track C has enough buffered audio for bridge crossfade.
     */
    isBridgeCrossfadeReady() {
        return this._bcfReady;
    }
    /**
     * Sets the upstream FiltersManager bypass flag without touching the
     * internal _bypassTriggered one-shot guard.  This lets the player
     * control bypass independently of the _transform lifecycle — e.g.
     * disabling bypass after crossfade completion so the next automix
     * pre-lead can build filter state (echo delay lines, reverb buffers).
     */
    /**
     * Pauses or resumes the bridge pump's time-based pacing.
     *
     * When paused, the pump stops consuming from the ring buffer so a
     * long pause doesn't exhaust Track B/C audio and kill the pipeline.
     * On resume, accumulated pause time is subtracted from wall-clock
     * elapsed so the pacing budget picks up exactly where it left off.
     */
    setPumpPaused(paused) {
        if (paused === this._pumpPaused)
            return;
        if (paused) {
            this._pumpPaused = true;
            this._pumpPausedAt = Date.now();
        }
        else {
            this._pumpPaused = false;
            if (this._pumpPausedAt > 0) {
                this._pumpTotalPausedMs += Date.now() - this._pumpPausedAt;
                this._pumpPausedAt = 0;
            }
        }
    }
    setFilterBypass(bypass) {
        this.filterBypassSetter?.(bypass);
    }
    /**
     * Swaps Track C's buffers into the main slot after bridge crossfade blend
     * completes.  The bridge pump then continues draining Track C seamlessly.
     */
    _swapBridgeCrossfade() {
        if (this.nextStream) {
            this.nextStream.removeListener('data', this.onNextData);
            this.nextStream.removeListener('end', this.onNextEnd);
            this.nextStream.removeListener('close', this.onNextEnd);
            this.nextStream.removeListener('error', this.onNextEnd);
            if (typeof this.nextStream.destroy === 'function') {
                ;
                this.nextStream.destroy();
            }
        }
        this.ringBuffer?.dispose();
        this.nextSpillChunks = [];
        this.nextSpillBytes = 0;
        this.nextPending = null;
        if (this._bcfStream) {
            this._bcfStream.removeListener('data', this._onBcfData);
            this._bcfStream.removeListener('end', this._onBcfEnd);
            this._bcfStream.removeListener('close', this._onBcfEnd);
            this._bcfStream.removeListener('error', this._onBcfEnd);
        }
        this.nextStream = this._bcfStream;
        this.ringBuffer = this._bcfRing;
        this.nextSpillChunks = this._bcfSpillChunks;
        this.nextSpillBytes = this._bcfSpillBytes;
        this.nextPending = this._bcfPending;
        if (this.nextStream) {
            this.nextStream.on('data', this.onNextData);
            this.nextStream.on('end', this.onNextEnd);
            this.nextStream.on('close', this.onNextEnd);
            this.nextStream.on('error', this.onNextEnd);
        }
        if (this._bcfBufferSize > 0) {
            this.bufferSize = this._bcfBufferSize;
        }
        this._bcfStream = null;
        this._bcfRing = null;
        this._bcfPending = null;
        this._bcfSpillChunks = [];
        this._bcfSpillBytes = 0;
        this._bcfRuntime = null;
        this._bcfReady = false;
        this._bcfTargetBytes = 0;
        this._bcfMinBytes = 0;
        this._bcfBufferSize = 0;
        this._bcfHpPrevL = 0;
        this._bcfHpPrevR = 0;
        this._bcfLpPrevL = 0;
        this._bcfLpPrevR = 0;
        this.filterBypassSetter?.(true);
        this.filterStateResetter?.();
        this._bcfCountFrozen = true;
        logger('info', 'Crossfade', 'Bridge crossfade: swap complete — Track C is now main');
    }
    _clearBridgeCrossfade() {
        if (this._bcfStream) {
            this._bcfStream.removeListener('data', this._onBcfData);
            this._bcfStream.removeListener('end', this._onBcfEnd);
            this._bcfStream.removeListener('close', this._onBcfEnd);
            this._bcfStream.removeListener('error', this._onBcfEnd);
            if (typeof this._bcfStream.pause === 'function') {
                ;
                this._bcfStream.pause();
            }
        }
        this._bcfStream = null;
        this._bcfPending = null;
        this._bcfSpillChunks = [];
        this._bcfSpillBytes = 0;
        this._bcfRing?.dispose();
        this._bcfRing = null;
        this._bcfRuntime = null;
        this._bcfReady = false;
        this._bcfTargetBytes = 0;
        this._bcfMinBytes = 0;
        this._bcfBufferSize = 0;
        this._bcfHpPrevL = 0;
        this._bcfHpPrevR = 0;
        this._bcfLpPrevL = 0;
        this._bcfLpPrevR = 0;
    }
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
        this._showcaseHistoryMaxBytes = Math.round(15 * this.sampleRate * this.channels * 2);
        this._fusionBandLowAlpha = this._computeOnePoleAlpha(220);
        this._fusionBandHighAlpha = this._computeOnePoleAlpha(2800);
        this._fusionAmbientAlpha = this._computeOnePoleAlpha(1800);
        this._fusionMainLpAlpha = this._computeOnePoleAlpha(1700);
        this._mainSpecLowAlpha = this._computeOnePoleAlpha(180);
        this._mainSpecMidAlpha = this._computeOnePoleAlpha(900);
        this._mainSpecHighAlpha = this._computeOnePoleAlpha(3200);
        this._mixBandLowAlpha = this._computeOnePoleAlpha(180);
        this._mixBandHighAlpha = this._computeOnePoleAlpha(2600);
        this.setMaxListeners(20);
    }
    push(chunk, encoding) {
        if (Buffer.isBuffer(chunk)) {
            if (this._showcaseHistoryMaxBytes > 0) {
                this._showcaseHistoryPcm.push(chunk);
                this._showcaseHistoryBytes += chunk.length;
                while (this._showcaseHistoryBytes > this._showcaseHistoryMaxBytes &&
                    this._showcaseHistoryPcm.length > 1) {
                    const removed = this._showcaseHistoryPcm.shift();
                    this._showcaseHistoryBytes -= removed.length;
                }
            }
            if (this._showcaseWriter) {
                this._showcaseWriter.write(chunk);
                this._showcaseRemainingBytes -= chunk.length;
                if (this._showcaseRemainingBytes <= 0) {
                    this._showcaseWriter.end();
                    this._showcaseWriter = null;
                    logger('info', 'AutoMix', `Finished showcase recording PCM: ${this._showcaseTargetFile}`);
                }
            }
        }
        return super.push(chunk, encoding);
    }
    startShowcaseRecording(preMs, activeMs, postMs, name) {
        if (this._showcaseWriter)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this._showcaseTargetFile = `automix_logs/showcase_${name}_${timestamp}.pcm`;
        if (!fs.existsSync('automix_logs'))
            fs.mkdirSync('automix_logs');
        this._showcaseWriter = fs.createWriteStream(this._showcaseTargetFile);
        const targetHistoryBytes = Math.round((preMs / 1000) * this.sampleRate * this.channels * 2);
        let dumpedBytes = 0;
        for (let i = this._showcaseHistoryPcm.length - 1; i >= 0; i--) {
            dumpedBytes += this._showcaseHistoryPcm[i].length;
            if (dumpedBytes >= targetHistoryBytes) {
                for (let j = i; j < this._showcaseHistoryPcm.length; j++) {
                    this._showcaseWriter.write(this._showcaseHistoryPcm[j]);
                }
                break;
            }
        }
        if (dumpedBytes < targetHistoryBytes) {
            for (const buf of this._showcaseHistoryPcm) {
                this._showcaseWriter.write(buf);
            }
        }
        this._showcaseRemainingBytes = Math.round(((activeMs + postMs) / 1000) * this.sampleRate * this.channels * 2);
        logger('info', 'AutoMix', `Started showcase recording PCM (Duration: ${(preMs + activeMs + postMs) / 1000}s) to ${this._showcaseTargetFile}`);
    }
    /**
     * Whether the Transform's _flush has been entered, meaning _transform
     * will never be called again and no crossfade blend can execute.
     *
     * Returns false while the bridge pump is still actively draining Track B
     * audio — the pipeline is still alive (pushing audio downstream) even
     * though _transform will never be called again.
     */
    isFlushed() {
        return this._flushed && !this._bridgePumpRunning;
    }
    /**
     * Whether the bridge pump is actively draining Track B's ring buffer
     * inside _flush().  During this phase the pipeline is still pushing
     * audio downstream, but no new crossfade can be set up on this controller.
     */
    isBridgeDraining() {
        return this._bridgePumpRunning;
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
        if (this._flushed) {
            if (this._bridgePumpRunning) {
                this._prepareBridgeCrossfade(stream, options);
                return;
            }
            logger('debug', 'Crossfade', 'prepareNextStream rejected: controller is flushed (pipeline dead)');
            return;
        }
        if (this.crossfade?.isFinished) {
            logger('debug', 'Crossfade', 'prepareNextStream: post-blend state (isFinished, !flushed) → routing to bridge crossfade path');
            this._prepareBridgeCrossfade(stream, options);
            return;
        }
        this.clear();
        this.nextStream = stream;
        const durationMs = Math.max(0, options.durationMs);
        const minBufferMs = options.minBufferMs !== undefined
            ? Math.max(0, options.minBufferMs)
            : durationMs;
        const bufferMs = options.bufferMs !== undefined && options.bufferMs > 0
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
        // Ensure the stream actually flows after re-bind (important after seek,
        // where previous controller instances may have paused this stream).
        this._resumeNextStream();
    }
    /**
     * Returns the buffered duration (ms) available for crossfade.
     */
    getBufferedMs() {
        if (this._bridgePumpRunning && this._bcfRing) {
            return this._bcfRing.length / this.bytesPerMs;
        }
        if (!this.ringBuffer)
            return 0;
        return this.ringBuffer.length / this.bytesPerMs;
    }
    /**
     * Indicates whether the controller is currently acting as a seamless bridge
     * for the next track (Track B) after the main track (Track A) has ended.
     */
    isBridgeMode() {
        if (this._bcfRuntime && !this._bcfRuntime.isFinished)
            return false;
        return (this.crossfade?.isFinished === true &&
            (!this.mainPending || this.mainPending.length === 0));
    }
    /**
     * Returns the current crossfade status.
     */
    getState() {
        if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
            return {
                active: true,
                bufferedMs: (this._bcfRing?.length ?? 0) / this.bytesPerMs,
                targetMs: this._bcfTargetBytes / this.bytesPerMs,
                isFinished: false
            };
        }
        return {
            active: this.crossfade !== null,
            bufferedMs: this.getBufferedMs(),
            targetMs: this.targetBufferBytes / this.bytesPerMs,
            isFinished: this.crossfade?.isFinished ?? false
        };
    }
    /**
     * Indicates whether enough audio is buffered to start crossfade.
     */
    isReady() {
        if (this._bridgePumpRunning && this._bcfRing && this._bcfReady)
            return true;
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
        if (this._flushed) {
            if (this._bridgePumpRunning && this._bcfRing && this._bcfReady) {
                return this._startBridgeCrossfade(durationMs, curve);
            }
            if (this.ringBuffer && this.ringBuffer.length > 0) {
            }
            else {
                return false;
            }
        }
        if (!this.ringBuffer || !this.isReady())
            return false;
        this._drainSpillToRing();
        this._resumeNextStream();
        if (!Number.isFinite(durationMs) || durationMs <= 0)
            return false;
        const durationFrames = Math.max(1, Math.round((durationMs / 1000) * this.sampleRate));
        this.crossfade = {
            durationFrames,
            elapsedFrames: 0,
            curve: this._resolveCurve(curve),
            isFinished: false
        };
        this._resetDynamicMixState();
        this._bootstrapDynamicPulse();
        this._configureFusionMixProfile(durationFrames);
        this._hpPrevL = 0;
        this._hpPrevR = 0;
        if (this._hpEnabled) {
            this._hpDurationFrames = durationFrames;
        }
        this._totalNextConsumedSamples = 0;
        return true;
    }
    /**
     * Scans Track B's buffer and skips forward until it finds a window that
     * matches the target RMS energy and (optionally) the target beat phase.
     */
    seekToEnergyMatch(targetRms, crossfadeDurationMs, transitionName, targetBeatState) {
        if (!this.ringBuffer || this.ringBuffer.length < 4)
            return;
        const rawTransition = typeof transitionName === 'string' ? transitionName : '';
        const transitionParts = rawTransition.split('|').filter((p) => p.length > 0);
        const transition = transitionParts[0] ?? '';
        const transitionFlags = new Set(transitionParts.slice(1));
        const forceNoVocalEntry = transitionFlags.has('no-vocal-entry');
        const strictNoVocalEntry = transitionFlags.has('strict-no-vocal');
        const fallbackHint = transitionFlags.has('fallback');
        this._strictNoVocalEntry = strictNoVocalEntry;
        this._transitionName = transition || null;
        const isFusion = this._isFusionTransition(transition);
        const isFusionPremium = transition === 'fusion_morph' || transition === 'harmonic_weave';
        const reserveMs = strictNoVocalEntry
            ? Math.max(2200, Math.min(crossfadeDurationMs * 0.40, 7000))
            : Math.max(3200, Math.min(crossfadeDurationMs * 0.55, 9000));
        const requiredBytes = Math.round(crossfadeDurationMs * this.bytesPerMs);
        const reserveBytes = Math.round(reserveMs * this.bytesPerMs);
        let maxScannableBytes = this.ringBuffer.length - reserveBytes;
        if (maxScannableBytes <= 0)
            return;
        const fusionIntroGuardWindows = fallbackHint
            ? (isFusionPremium ? 12 : 14)
            : (isFusionPremium ? 8 : 10); // 0.5s windows
        // Standardize scan window to 60s for better phrase detection.
        // Fusion should stay close to the beginning so the entry feels like a medley,
        // not a jump cut into a later vocal phrase.
        const scanLimitMs = isFusion
            ? (forceNoVocalEntry || fallbackHint)
                ? (isFusionPremium ? 8000 : 9500)
                : (isFusionPremium ? 3600 : 4600)
            : (forceNoVocalEntry ? 12000 : 60000);
        const scanLimitBytes = Math.round(scanLimitMs * this.bytesPerMs);
        maxScannableBytes = Math.min(maxScannableBytes, scanLimitBytes);
        const peekData = this.ringBuffer.peek(maxScannableBytes);
        if (!peekData)
            return;
        const samples = peekData.length >> 1;
        const windowSamples = Math.floor(this.sampleRate * 0.5) * this.channels; // 500ms windows
        if (samples < windowSamples * 2)
            return;
        let target = Math.max(targetRms > 0 ? targetRms : 0.05, 0.03);
        const preferPunchyEntry = transition === 'cinema_lift' ||
            transition === 'pulse_tunnel' ||
            transition === 'filter_sweep' ||
            transition === 'highpass_dissolve';
        // Fusion mode: prioritize beat phase alignment for transparent handoffs.
        const targetPhase = (targetBeatState?.locked && targetBeatState.bpm > 0)
            ? targetBeatState.phase
            : null;
        const targetBpm = targetBeatState?.bpm ?? null;
        const energies = [];
        const transients = [];
        const phases = [];
        const vocalDensities = [];
        const windowPeaks = [];
        const windowCrests = [];
        const spectralBrightness = [];
        const spectralMotion = [];
        const spectralCentroids = [];
        const vocalLowAlpha = this._computeOnePoleAlpha(220);
        const vocalHighAlpha = this._computeOnePoleAlpha(2800);
        const specLowAlpha = this._computeOnePoleAlpha(170);
        const specMidAlpha = this._computeOnePoleAlpha(900);
        const specHighAlpha = this._computeOnePoleAlpha(3200);
        const phaseConfidenceGate = isFusion ? 0.62 : 0.50;
        const hardVocalCeiling = strictNoVocalEntry
            ? isFusionPremium
                ? 0.26
                : 0.30
            : forceNoVocalEntry
                ? isFusion
                    ? 0.34
                    : 0.40
                : isFusion
                    ? 0.42
                    : 0.62;
        const hardPeakCeiling = strictNoVocalEntry
            ? 0.92
            : forceNoVocalEntry
                ? 0.95
                : 0.98;
        const hardCrestCeiling = strictNoVocalEntry
            ? 3.1
            : forceNoVocalEntry
                ? 3.5
                : 4.0;
        const mainBrightnessRef = Math.max(0.10, Math.min(0.95, this._mainSpecBrightnessEma));
        const mainMotionRef = Math.max(0.04, Math.min(0.90, this._mainSpecMotionEma));
        const mainCentroidRef = Math.max(0.08, Math.min(0.95, this._mainSpecCentroidEma));
        // Pre-track B analysis for phase alignment if needed
        const bBeatTracker = new RealtimeBpmTracker();
        if (targetPhase !== null && targetBpm) {
            // Warm up tracker with peek data to find B's beat phase
            const stepMs = 20;
            const stepSamples = Math.floor((stepMs / 1000) * this.sampleRate) * this.channels;
            for (let i = 0; i < samples - stepSamples; i += stepSamples) {
                let sumSq = 0;
                let count = 0;
                for (let j = 0; j < stepSamples; j += this.channels * 2) {
                    const sampleIndex = i + j;
                    if (sampleIndex + this.channels > samples)
                        break;
                    const l = peekData.readInt16LE(sampleIndex * 2);
                    const r = this.channels > 1 ? peekData.readInt16LE((sampleIndex + 1) * 2) : l;
                    const mid = (l + r) * 0.5;
                    sumSq += mid * mid;
                    count++;
                }
                if (count > 0) {
                    const rms = Math.sqrt(sumSq / count) / 32768;
                    bBeatTracker.push(rms, stepMs / 1000);
                }
            }
        }
        for (let i = 0; i <= samples - windowSamples; i += windowSamples) {
            let sumSq = 0;
            let count = 0;
            let sumRise = 0;
            let riseCount = 0;
            let sumAbsMid = 0;
            let sumAbsSide = 0;
            let sumAbsBand = 0;
            let peakAbs = 0;
            let bandLowLp = 0;
            let bandHighLp = 0;
            let specLowLp = 0;
            let specMidLp = 0;
            let specHighLp = 0;
            let specBass = 0;
            let specMid = 0;
            let specTreble = 0;
            let specFlux = 0;
            let prevSpecComposite = 0;
            let prevMid = peekData.readInt16LE(i * 2);
            for (let j = 0; j < windowSamples; j += this.channels * 2) {
                const sampleIndex = i + j;
                if (sampleIndex + this.channels > samples)
                    break;
                const l = peekData.readInt16LE(sampleIndex * 2);
                const r = this.channels > 1 ? peekData.readInt16LE((sampleIndex + 1) * 2) : l;
                const mid = (l + r) * 0.5;
                const side = (l - r) * 0.5;
                const absMidSample = Math.abs(mid);
                sumSq += mid * mid;
                const d = mid - prevMid;
                if (d > 0) {
                    sumRise += d;
                    riseCount++;
                }
                prevMid = mid;
                bandLowLp += vocalLowAlpha * (mid - bandLowLp);
                bandHighLp += vocalHighAlpha * (mid - bandHighLp);
                const band = bandHighLp - bandLowLp;
                specLowLp += specLowAlpha * (mid - specLowLp);
                specMidLp += specMidAlpha * (mid - specMidLp);
                specHighLp += specHighAlpha * (mid - specHighLp);
                const bassBand = Math.abs(specLowLp);
                const midBand = Math.abs(specMidLp - specLowLp);
                const trebleBand = Math.abs(mid - specHighLp);
                specBass += bassBand;
                specMid += midBand;
                specTreble += trebleBand;
                const specComposite = midBand + trebleBand * 1.15;
                specFlux += Math.abs(specComposite - prevSpecComposite);
                prevSpecComposite = specComposite;
                sumAbsMid += absMidSample;
                sumAbsSide += Math.abs(side);
                sumAbsBand += Math.abs(band);
                if (absMidSample > peakAbs)
                    peakAbs = absMidSample;
                count++;
            }
            if (count === 0)
                continue;
            const energy = Math.sqrt(sumSq / count) / 32768;
            energies.push(energy);
            transients.push(riseCount > 0 ? sumRise / riseCount / 32768 : 0);
            const peakNorm = peakAbs / 32768;
            windowPeaks.push(peakNorm);
            windowCrests.push(peakNorm / Math.max(energy, 0.012));
            const centerFocus = sumAbsMid / (sumAbsMid + sumAbsSide + 1);
            const bandRatio = sumAbsBand / (sumAbsMid + 1);
            const vocalDensity = Math.max(0, Math.min(1, (bandRatio - 0.10) / 0.55)) *
                Math.max(0, Math.min(1, (centerFocus - 0.52) / 0.45));
            vocalDensities.push(vocalDensity);
            const specTotal = specBass + specMid + specTreble + 1;
            const bright = Math.max(0, Math.min(1, (specTreble * 1.12 + specMid * 0.42) / specTotal));
            const motion = Math.max(0, Math.min(1, (specFlux / (specMid + specTreble + 1)) / 0.70));
            const centroidNorm = Math.max(0, Math.min(1, (specBass * 140 + specMid * 900 + specTreble * 3200) / specTotal / 3800));
            spectralBrightness.push(bright);
            spectralMotion.push(motion);
            spectralCentroids.push(centroidNorm);
            if (targetPhase !== null) {
                const timeAtWindow = i / (this.sampleRate * this.channels);
                const bState = bBeatTracker.getState();
                const bpmRatio = targetBpm && targetBpm > 0 && bState.bpm > 0
                    ? Math.max(targetBpm, bState.bpm) /
                        Math.max(1e-6, Math.min(targetBpm, bState.bpm))
                    : 1;
                const bpmCoherent = bpmRatio <= 1.35 || (bpmRatio >= 1.80 && bpmRatio <= 2.25);
                // Estimate phase at this window start
                if (bState.locked &&
                    bState.bpm > 0 &&
                    bState.confidence >= phaseConfidenceGate &&
                    bpmCoherent) {
                    const period = 60 / bState.bpm;
                    const cycles = timeAtWindow / period;
                    const phase = (bState.phase + cycles) % 1;
                    phases.push(phase);
                }
                else {
                    phases.push(-1);
                }
            }
            else {
                phases.push(-1);
            }
        }
        if (energies.length < 2)
            return;
        const openingEnergy = energies[0];
        const openingTransient = transients[0];
        const openingVocalDensity = vocalDensities[0] ?? 0;
        const fusionVocalHardCeiling = isFusionPremium ? 0.28 : 0.32;
        const fusionIntroLowVocalThreshold = isFusionPremium
            ? Math.min(0.24, Math.max(0.11, openingVocalDensity - 0.06))
            : Math.min(0.27, Math.max(0.12, openingVocalDensity - 0.05));
        const strictFusionVocalTarget = isFusionPremium ? 0.20 : 0.24;
        const sortedEnergies = [...energies].sort((a, b) => a - b);
        const percentile = (p) => {
            const idx = Math.max(0, Math.min(sortedEnergies.length - 1, Math.floor((sortedEnergies.length - 1) * p)));
            return sortedEnergies[idx] ?? openingEnergy;
        };
        const p80 = percentile(0.8);
        const p90 = percentile(0.9);
        const profileCeiling = Math.max(p80, openingEnergy * 1.35, 0.05);
        const originalTarget = target;
        if (target > profileCeiling * 1.22) {
            target = profileCeiling * 1.08;
        }
        const fusionEnergyFloor = isFusion
            ? Math.max(0.018, Math.min(openingEnergy * 0.72, target * 0.74))
            : 0;
        if (preferPunchyEntry) {
            target = Math.max(target, Math.min(0.1, p90 * 0.92));
        }
        const preferControlledEntry = (openingEnergy > target * 1.45 &&
            target < 0.17 &&
            openingEnergy > 0.10) ||
            (openingEnergy > 0.24 &&
                target < 0.20 &&
                openingEnergy > target * 1.25);
        const punchyScoring = preferPunchyEntry && !preferControlledEntry;
        const forwardSpan = isFusion ? 3 : 2;
        const forwardVocalMax = new Array(energies.length).fill(0);
        const forwardPeakMax = new Array(energies.length).fill(0);
        const forwardEnergyMean = new Array(energies.length).fill(0);
        const forwardMotionMean = new Array(energies.length).fill(0);
        for (let i = 0; i < energies.length; i++) {
            let vocalMax = 0;
            let peakMax = 0;
            let energySum = 0;
            let motionSum = 0;
            let count = 0;
            for (let k = 0; k <= forwardSpan; k++) {
                const idx = i + k;
                if (idx >= energies.length)
                    break;
                vocalMax = Math.max(vocalMax, vocalDensities[idx] ?? 0);
                peakMax = Math.max(peakMax, windowPeaks[idx] ?? 0);
                energySum += energies[idx] ?? 0;
                motionSum += spectralMotion[idx] ?? mainMotionRef;
                count++;
            }
            const norm = Math.max(1, count);
            forwardVocalMax[i] = vocalMax;
            forwardPeakMax[i] = peakMax;
            forwardEnergyMean[i] = energySum / norm;
            forwardMotionMean[i] = motionSum / norm;
        }
        // Choose best window by weighted "energy fit" + phase alignment.
        let bestWindowIdx = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        let bestFusionIntroIdx = 0;
        let bestFusionIntroScore = Number.POSITIVE_INFINITY;
        let bestFusionLowVocalIntroIdx = 0;
        let bestFusionLowVocalIntroScore = Number.POSITIVE_INFINITY;
        const windowScores = [];
        const phraseConfidenceScores = [];
        const stabilityScores = [];
        const eps = 1e-6;
        for (let i = 0; i < energies.length; i++) {
            const e = energies[i];
            const t = transients[i];
            const p = phases[i];
            const ratio = (e + eps) / (target + eps);
            const logDistance = Math.abs(Math.log(ratio));
            const prev = i > 0 ? energies[i - 1] : e;
            const slope = e - prev;
            const transientRef = Math.max(openingTransient, 0.003);
            const transientRatio = (t + eps) / (transientRef + eps);
            const vocalDensity = vocalDensities[i] ?? openingVocalDensity;
            const brightNow = spectralBrightness[i] ?? mainBrightnessRef;
            const motionNow = spectralMotion[i] ?? mainMotionRef;
            const centroidNow = spectralCentroids[i] ?? mainCentroidRef;
            const spectralDistance = Math.abs(brightNow - mainBrightnessRef) * 0.55 +
                Math.abs(motionNow - mainMotionRef) * 0.30 +
                Math.abs(centroidNow - mainCentroidRef) * 0.15;
            const peakNorm = windowPeaks[i] ?? 0;
            const crest = windowCrests[i] ?? 1;
            const nextEnergy = i + 1 < energies.length ? energies[i + 1] : e;
            const nextVocalDensity = i + 1 < vocalDensities.length
                ? (vocalDensities[i + 1] ?? vocalDensity)
                : vocalDensity;
            const aheadVocalMax = forwardVocalMax[i] ?? vocalDensity;
            const aheadPeakMax = forwardPeakMax[i] ?? peakNorm;
            const aheadEnergyMean = forwardEnergyMean[i] ?? e;
            const aheadMotionMean = forwardMotionMean[i] ?? motionNow;
            const entryAttackJump = Math.max(0, nextEnergy - e);
            const grooveDrive = Math.max(0, Math.min(1, motionNow * 0.55 +
                Math.max(0, Math.min(1, transientRatio - 0.75)) * 0.35 +
                Math.max(0, 0.35 - vocalDensity) * 0.25));
            const vocalSurge = Math.max(0, aheadVocalMax - vocalDensity);
            const peakSurge = Math.max(0, aheadPeakMax - peakNorm);
            const energyDropAhead = Math.max(0, e - aheadEnergyMean);
            const flowInstability = vocalSurge * 1.55 +
                peakSurge * 1.20 +
                energyDropAhead * 2.2 +
                Math.max(0, motionNow - aheadMotionMean) * 0.22;
            const priorEnergy = i > 0 ? energies[i - 1] : e;
            const prior2Energy = i > 1 ? energies[i - 2] : priorEnergy;
            const preValley = Math.max(0, ((priorEnergy + prior2Energy) * 0.5) - e);
            const liftAhead = Math.max(0, aheadEnergyMean - e);
            const attackPenalty = Math.max(0, entryAttackJump - 0.018);
            const phraseRaw = preValley * 4.6 +
                liftAhead * 3.2 +
                grooveDrive * 0.75 -
                vocalDensity * 0.95 -
                attackPenalty * 5.2;
            const phraseConfidence = Math.max(0, Math.min(1, (phraseRaw + 0.24) / 0.90));
            const instabilityRaw = flowInstability * 0.70 +
                Math.abs(aheadEnergyMean - e) * 2.0 +
                Math.max(0, aheadPeakMax - peakNorm) * 1.1 +
                Math.max(0, aheadVocalMax - vocalDensity) * 1.2;
            const stabilityScore = Math.max(0, Math.min(1, 1 - instabilityRaw * 0.45));
            // Base: closeness to target.
            let score = logDistance;
            // Phase alignment bonus (up to 0.40 score reduction)
            if (targetPhase !== null && p >= 0) {
                const phaseDist = Math.min(Math.abs(p - targetPhase), 1 - Math.abs(p - targetPhase));
                const phaseMatch = Math.max(0, 1 - phaseDist / 0.15); // Tightened window
                const phaseWeight = isFusion ? 0.70 : 1.5;
                score -= phaseMatch * phaseWeight;
                // FUSION PROTECT: If we have a beat match in the early windows, 
                // aggressively lock onto it to prevent skipping the intro.
                if (isFusion && i <= fusionIntroGuardWindows && phaseMatch > 0.8) {
                    score -= 1.2;
                }
            }
            // Encourage forward progress (avoid index 0 unless truly best).
            if (i === 0)
                score += 0.25;
            else if (i < 3)
                score += 0.10;
            // Prefer windows with some upward movement for smoother "arrival".
            if (slope > 0)
                score -= Math.min(0.12, slope * 2.5);
            // Penalize windows that are much quieter than the target.
            if (e < target * 0.55)
                score += 0.25;
            if (isFusion || forceNoVocalEntry) {
                score -= grooveDrive * (isFusion ? 0.24 : 0.12);
                score += flowInstability * (isFusion ? 0.55 : 0.32);
                score -= phraseConfidence * (isFusion ? 0.32 : 0.18);
                score -= stabilityScore * (isFusion ? 0.18 : 0.10);
                if (entryAttackJump > 0.022 &&
                    (vocalDensity > 0.26 || nextVocalDensity > 0.26)) {
                    score += Math.min(2.1, entryAttackJump * 14 +
                        Math.max(vocalDensity, nextVocalDensity) -
                        0.26);
                }
            }
            if (isFusion) {
                score += spectralDistance * 0.62;
                if (i <= fusionIntroGuardWindows && spectralDistance < 0.12) {
                    score -= 0.10;
                }
                if (e < fusionEnergyFloor) {
                    const lowEnergyDelta = fusionEnergyFloor - e;
                    score += Math.min(isFusionPremium ? 1.4 : 1.0, lowEnergyDelta * (isFusionPremium ? 42 : 30));
                }
                if (peakNorm > 0.82) {
                    score += Math.min(1.3, (peakNorm - 0.82) * 3.2);
                }
                else if (peakNorm < 0.72 && e >= Math.max(0.02, target * 0.62)) {
                    score -= 0.08;
                }
                if (crest > 2.7) {
                    score += Math.min(0.8, (crest - 2.7) * 0.16);
                }
            }
            else {
                score += spectralDistance * 0.28;
            }
            if (preferControlledEntry) {
                const hotPenalty = Math.max(0, Math.min(0.30, (e - target * 1.30) * 2.4));
                score += hotPenalty;
                if (transientRatio > 1.12) {
                    score += Math.min(0.18, (transientRatio - 1.12) * 0.22);
                }
                if (i === 0)
                    score += 0.22;
                if (peakNorm > 0.86) {
                    score += Math.min(0.60, (peakNorm - 0.86) * 2.6);
                }
            }
            if (punchyScoring) {
                if (transientRatio > 1) {
                    score -= Math.min(0.30, (transientRatio - 1) * 0.14);
                }
                else {
                    score += Math.min(0.14, (1 - transientRatio) * 0.12);
                }
                if (e < 0.05)
                    score += 0.15;
            }
            if (strictNoVocalEntry && phraseConfidence < 0.22 && i > 1) {
                score += 0.24;
            }
            if (isFusion) {
                const vocalTarget = isFusionPremium ? 0.24 : 0.27;
                if (vocalDensity > vocalTarget) {
                    score += Math.min(1.4, (vocalDensity - vocalTarget) * (isFusionPremium ? 2.6 : 2.0));
                }
                else {
                    score -= Math.min(0.24, (vocalTarget - vocalDensity) * 0.70);
                }
                if (vocalDensity > fusionVocalHardCeiling) {
                    const excess = vocalDensity - fusionVocalHardCeiling;
                    score += Math.min(isFusionPremium ? 2.4 : 1.8, excess * (isFusionPremium ? 5.0 : 3.8));
                    if (i <= fusionIntroGuardWindows) {
                        score += Math.min(1.2, excess * 4.2);
                    }
                }
                if (i < 10 && openingVocalDensity > 0.32) {
                    const vocalDrop = openingVocalDensity - vocalDensity;
                    if (vocalDrop > 0) {
                        score -= Math.min(0.52, vocalDrop * 0.78);
                    }
                }
                if (forceNoVocalEntry || fallbackHint) {
                    const strictTarget = strictNoVocalEntry ? 0.17 : strictFusionVocalTarget;
                    if (vocalDensity > strictFusionVocalTarget) {
                        score += Math.min(2.4, (vocalDensity - strictTarget) * (strictNoVocalEntry ? 5.0 : 3.8));
                    }
                    else {
                        score -= Math.min(0.36, (strictTarget - vocalDensity) * (strictNoVocalEntry ? 1.25 : 0.95));
                    }
                    if (i <= fusionIntroGuardWindows &&
                        vocalDensity > strictTarget + 0.04) {
                        score += Math.min(strictNoVocalEntry ? 2.4 : 1.8, (vocalDensity - strictTarget) * (strictNoVocalEntry ? 4.8 : 3.4));
                    }
                    if (peakNorm > 0.84) {
                        score += Math.min(1.2, (peakNorm - 0.84) * 3.4);
                    }
                    if (strictNoVocalEntry && vocalDensity > 0.24) {
                        score += Math.min(2.6, (vocalDensity - 0.24) * 6.2);
                    }
                }
            }
            else if (transition === 'crossfade_eq' ||
                transition === 'filter_sweep' ||
                transition === 'highpass_dissolve') {
                if (vocalDensity > 0.34) {
                    score += Math.min(0.48, (vocalDensity - 0.34) * 0.62);
                }
            }
            if ((isFusion || forceNoVocalEntry) &&
                aheadVocalMax > hardVocalCeiling + (strictNoVocalEntry ? 0.00 : 0.03)) {
                score +=
                    3.8 +
                        Math.min(2.8, (aheadVocalMax - hardVocalCeiling) *
                            (strictNoVocalEntry ? 7.0 : 4.8));
            }
            if (aheadPeakMax > hardPeakCeiling) {
                score += 1.4 + Math.min(2.0, (aheadPeakMax - hardPeakCeiling) * 7.0);
            }
            if ((isFusion || forceNoVocalEntry) && vocalDensity > hardVocalCeiling) {
                score +=
                    5.0 + Math.min(3.4, (vocalDensity - hardVocalCeiling) * 8.0);
            }
            if (peakNorm > hardPeakCeiling) {
                score += 2.0 + Math.min(2.2, (peakNorm - hardPeakCeiling) * 8.0);
            }
            if (crest > hardCrestCeiling) {
                score += Math.min(2.4, (crest - hardCrestCeiling) * 0.9);
            }
            // FUSION BIAS: Heavily penalize late jumps in Fusion mode to stay in the intro.
            if (isFusion) {
                if (i > 4)
                    score += (i - 4) * 0.5; // Aggressive penalty for jumping deep into track
            }
            else if (punchyScoring) {
                if (i > 18)
                    score += Math.min(0.42, (i - 18) * 0.018);
            }
            else if (i > 12) {
                score += Math.min(0.46, (i - 12) * 0.024);
            }
            windowScores[i] = score;
            phraseConfidenceScores[i] = phraseConfidence;
            stabilityScores[i] = stabilityScore;
            if (isFusion && i <= fusionIntroGuardWindows) {
                if (score < bestFusionIntroScore) {
                    bestFusionIntroScore = score;
                    bestFusionIntroIdx = i;
                }
                if (vocalDensity <= fusionIntroLowVocalThreshold &&
                    score < bestFusionLowVocalIntroScore) {
                    bestFusionLowVocalIntroScore = score;
                    bestFusionLowVocalIntroIdx = i;
                }
            }
            if (score < bestScore) {
                bestScore = score;
                bestWindowIdx = i;
            }
        }
        const rankedWindows = windowScores
            .map((score, idx) => ({ idx, score }))
            .sort((a, b) => a.score - b.score);
        const shortlistCount = strictNoVocalEntry
            ? 12
            : forceNoVocalEntry
                ? 9
                : isFusion
                    ? 8
                    : 6;
        const shortlist = rankedWindows.slice(0, shortlistCount);
        if (shortlist.length > 0) {
            let rerankIdx = bestWindowIdx;
            let rerankBest = Number.POSITIVE_INFINITY;
            for (const candidate of shortlist) {
                const i = candidate.idx;
                const vocal = vocalDensities[i] ?? 1;
                const peak = windowPeaks[i] ?? 1;
                const crest = windowCrests[i] ?? 10;
                const aheadVocal = forwardVocalMax[i] ?? vocal;
                const aheadPeak = forwardPeakMax[i] ?? peak;
                const e = energies[i] ?? 0;
                const aheadE = forwardEnergyMean[i] ?? e;
                const phrase = phraseConfidenceScores[i] ?? 0;
                const stability = stabilityScores[i] ?? 0;
                const instabilityPenalty = Math.max(0, aheadVocal - vocal) * 2.2 +
                    Math.max(0, aheadPeak - peak) * 1.6 +
                    Math.max(0, e - aheadE) * 2.0 +
                    Math.max(0, 1 - stability) * 0.9;
                const vocalPenalty = Math.max(0, vocal - (strictNoVocalEntry ? 0.22 : 0.30)) * 4.2 +
                    Math.max(0, aheadVocal - (strictNoVocalEntry ? 0.24 : 0.34)) * 3.3;
                const clipPenalty = Math.max(0, peak - 0.90) * 3.0 + Math.max(0, crest - 3.2) * 0.9;
                const positionPenalty = isFusion
                    ? i * 0.08
                    : strictNoVocalEntry
                        ? i * 0.03
                        : i * 0.018;
                const rerankScore = candidate.score * 0.66 +
                    instabilityPenalty +
                    vocalPenalty +
                    clipPenalty +
                    positionPenalty -
                    phrase * 0.60 -
                    stability * 0.35;
                if (rerankScore < rerankBest) {
                    rerankBest = rerankScore;
                    rerankIdx = i;
                }
            }
            if (rerankIdx !== bestWindowIdx) {
                bestWindowIdx = rerankIdx;
                bestScore = windowScores[bestWindowIdx] ?? bestScore;
            }
        }
        if (!isFusion && (forceNoVocalEntry || strictNoVocalEntry) && bestWindowIdx > 2) {
            const earlyLimit = Math.min(windowScores.length - 1, strictNoVocalEntry ? 10 : 14);
            let earliestCleanIdx = -1;
            const cleanVocalCeiling = strictNoVocalEntry ? 0.26 : 0.32;
            const cleanPeakCeiling = strictNoVocalEntry ? 0.90 : 0.94;
            const cleanCrestCeiling = strictNoVocalEntry ? 3.2 : 3.6;
            for (let i = 0; i <= earlyLimit; i++) {
                const vocal = vocalDensities[i] ?? 1;
                const peak = windowPeaks[i] ?? 1;
                const crest = windowCrests[i] ?? 10;
                const energy = energies[i] ?? 0;
                if (energy < Math.max(0.01, target * 0.35))
                    continue;
                if (vocal <= cleanVocalCeiling && peak <= cleanPeakCeiling && crest <= cleanCrestCeiling) {
                    earliestCleanIdx = i;
                    break;
                }
            }
            if (earliestCleanIdx >= 0) {
                const earlyScore = windowScores[earliestCleanIdx] ?? Number.POSITIVE_INFINITY;
                const scoreSlack = strictNoVocalEntry ? 1.0 : 0.7;
                if (earlyScore - bestScore <= scoreSlack) {
                    bestWindowIdx = earliestCleanIdx;
                    bestScore = earlyScore;
                }
            }
        }
        if (isFusion) {
            const chosenLowVocalIntro = bestFusionLowVocalIntroScore < Number.POSITIVE_INFINITY
                ? bestFusionLowVocalIntroIdx
                : bestFusionIntroIdx;
            const selectedVocalDensity = vocalDensities[bestWindowIdx] ?? openingVocalDensity;
            const selectedLate = bestWindowIdx > fusionIntroGuardWindows;
            const selectedVocalHeavy = selectedVocalDensity > fusionVocalHardCeiling;
            const selectedScore = windowScores[bestWindowIdx] ?? bestScore;
            const introCandidateScore = windowScores[chosenLowVocalIntro] ?? bestFusionIntroScore;
            const shouldForceIntro = selectedLate ||
                selectedVocalHeavy ||
                introCandidateScore - selectedScore <= 0.45;
            if (shouldForceIntro && chosenLowVocalIntro !== bestWindowIdx) {
                bestWindowIdx = chosenLowVocalIntro;
                bestScore = introCandidateScore;
            }
            const openingScore = windowScores[0] ?? Number.POSITIVE_INFINITY;
            const openingSpectralDistance = Math.abs((spectralBrightness[0] ?? mainBrightnessRef) - mainBrightnessRef) * 0.55 +
                Math.abs((spectralMotion[0] ?? mainMotionRef) - mainMotionRef) * 0.30 +
                Math.abs((spectralCentroids[0] ?? mainCentroidRef) - mainCentroidRef) * 0.15;
            const openingGoodForFusion = openingVocalDensity <= Math.min(fusionVocalHardCeiling, fusionIntroLowVocalThreshold + 0.04) &&
                openingSpectralDistance <= 0.18 &&
                openingEnergy >= Math.max(0.018, target * 0.65);
            // If opening is already clean/instrumental and reasonably matched,
            // don't skip deep into Track B for tiny score gains.
            if (!forceNoVocalEntry &&
                openingGoodForFusion &&
                bestWindowIdx > 0 &&
                openingScore - bestScore <= 0.85) {
                bestWindowIdx = 0;
                bestScore = openingScore;
            }
            if (forceNoVocalEntry || fallbackHint || openingVocalDensity > fusionVocalHardCeiling) {
                const searchLimit = Math.min(vocalDensities.length - 1, strictNoVocalEntry ? 22 : (fallbackHint ? 16 : 12));
                let bestLowVocalIdx = 0;
                let bestLowVocalScore = Number.POSITIVE_INFINITY;
                for (let i = 0; i <= searchLimit; i++) {
                    const vocalDensity = vocalDensities[i] ?? 1;
                    const energy = energies[i] ?? 0;
                    const peak = windowPeaks[i] ?? 0;
                    if (energy < Math.max(0.010, target * (strictNoVocalEntry ? 0.22 : 0.30)))
                        continue;
                    const score = vocalDensity * (strictNoVocalEntry ? 1.25 : 1.0) +
                        Math.max(0, (strictNoVocalEntry ? 0.16 : strictFusionVocalTarget) - energy) * 0.12 +
                        Math.max(0, peak - 0.84) * 0.30 +
                        i * (strictNoVocalEntry ? 0.004 : 0.006);
                    if (score < bestLowVocalScore) {
                        bestLowVocalScore = score;
                        bestLowVocalIdx = i;
                    }
                }
                const chosenVocal = vocalDensities[bestWindowIdx] ?? 1;
                const bestLowVocal = vocalDensities[bestLowVocalIdx] ?? chosenVocal;
                const strictTarget = strictNoVocalEntry ? 0.18 : strictFusionVocalTarget;
                const shouldForceLowVocal = bestLowVocalIdx !== bestWindowIdx &&
                    (bestLowVocal <= chosenVocal - 0.01 ||
                        (strictNoVocalEntry && bestLowVocal <= strictTarget));
                if (shouldForceLowVocal) {
                    bestWindowIdx = bestLowVocalIdx;
                    bestScore = windowScores[bestWindowIdx] ?? bestScore;
                }
            }
        }
        if (strictNoVocalEntry) {
            const selectedVocal = vocalDensities[bestWindowIdx] ?? 1;
            const strictFallbackCeiling = isFusionPremium ? 0.26 : 0.30;
            if (selectedVocal > strictFallbackCeiling) {
                let minVocalIdx = bestWindowIdx;
                let minVocal = selectedVocal;
                for (let i = 0; i < vocalDensities.length; i++) {
                    const vocal = vocalDensities[i] ?? 1;
                    const energy = energies[i] ?? 0;
                    if (energy < Math.max(0.008, target * 0.20))
                        continue;
                    if (vocal < minVocal ||
                        (vocal <= minVocal + 0.01 && (windowPeaks[i] ?? 1) < (windowPeaks[minVocalIdx] ?? 1))) {
                        minVocal = vocal;
                        minVocalIdx = i;
                    }
                }
                if (minVocalIdx !== bestWindowIdx) {
                    bestWindowIdx = minVocalIdx;
                    bestScore = windowScores[minVocalIdx] ?? bestScore;
                }
            }
        }
        const selectedEnergy = energies[bestWindowIdx] ?? openingEnergy;
        const selectedPeak = windowPeaks[bestWindowIdx] ?? 0;
        const selectedCrest = windowCrests[bestWindowIdx] ?? 1;
        const selectedVocalDensity = vocalDensities[bestWindowIdx] ?? openingVocalDensity;
        const selectedPhraseConfidence = phraseConfidenceScores[bestWindowIdx] ?? 0;
        const selectedStability = stabilityScores[bestWindowIdx] ?? 0;
        const selBright = spectralBrightness[bestWindowIdx] ?? mainBrightnessRef;
        const selMotion = spectralMotion[bestWindowIdx] ?? mainMotionRef;
        const selCentroid = spectralCentroids[bestWindowIdx] ?? mainCentroidRef;
        const selectedSpectralDistance = Math.abs(selBright - mainBrightnessRef) * 0.55 +
            Math.abs(selMotion - mainMotionRef) * 0.30 +
            Math.abs(selCentroid - mainCentroidRef) * 0.15;
        const peakRisk = Math.max(0, Math.min(1, (selectedPeak - 0.80) / 0.18));
        const crestRisk = Math.max(0, Math.min(1, (selectedCrest - 2.6) / 1.8));
        const energyRisk = Math.max(0, Math.min(1, (selectedEnergy - 0.22) / 0.22));
        const vocalRisk = Math.max(0, Math.min(1, (selectedVocalDensity - 0.20) / 0.45));
        const spectralRisk = Math.max(0, Math.min(1, selectedSpectralDistance / 0.40));
        const entryRisk = Math.max(peakRisk, crestRisk * 0.85 + energyRisk * 0.35, vocalRisk * 0.88 + spectralRisk * 0.22);
        const minEntryGain = strictNoVocalEntry ? 0.46 : 0.52;
        this._incomingEntryGainComp = Math.max(minEntryGain, Math.min(1, 1 - entryRisk * 0.40));
        if (strictNoVocalEntry && selectedPeak > 0.92) {
            this._incomingEntryGainComp = Math.min(this._incomingEntryGainComp, 0.62);
        }
        if (strictNoVocalEntry && selectedVocalDensity > 0.30) {
            this._incomingEntryGainComp = Math.min(this._incomingEntryGainComp, 0.58);
        }
        this._entryPhraseConfidence = selectedPhraseConfidence;
        this._entryStability = selectedStability;
        this._entryFxCenterShield = Math.max(0, Math.min(0.48, Math.max(0, selectedVocalDensity - 0.14) * 0.90 +
            Math.max(0, 1 - selectedStability) * 0.26 +
            Math.max(0, 0.45 - selectedPhraseConfidence) * 0.20));
        this._entryFxLowDuckBoost = Math.max(0, Math.min(0.26, Math.max(0, selectedPeak - 0.78) * 0.70 +
            Math.max(0, selectedEnergy - 0.16) * 0.75));
        this._entryFxAirSoftenBoost = Math.max(0, Math.min(0.24, Math.max(0, selectedSpectralDistance - 0.12) * 0.90 +
            Math.max(0, selectedVocalDensity - 0.24) * 0.35));
        this._entryFxSidechainBoost = Math.max(0, Math.min(0.28, entryRisk * 0.30 +
            Math.max(0, selectedPhraseConfidence - 0.25) * 0.16 +
            Math.max(0, 1 - selectedStability) * 0.12));
        if (bestWindowIdx > 0) {
            const skipSamples = bestWindowIdx * windowSamples;
            const skipBytes = skipSamples * 2;
            const alignedSkip = skipBytes - (skipBytes % (this.channels * 2));
            // Hard cap skip to keep Fusion in the opening bars.
            const openingVocalHeavy = isFusion &&
                (forceNoVocalEntry ||
                    openingVocalDensity > (isFusionPremium ? 0.24 : 0.28));
            const baseMaxSkipMs = isFusion
                ? openingVocalHeavy
                    ? fallbackHint
                        ? (isFusionPremium ? 4600 : 5600)
                        : (isFusionPremium ? 3600 : 4600)
                    : (isFusionPremium ? 1100 : 1500)
                : strictNoVocalEntry
                    ? Math.min(4200, Math.round(crossfadeDurationMs * 0.65))
                    : forceNoVocalEntry
                        ? Math.min(5600, Math.round(crossfadeDurationMs * 0.90))
                        : Math.min(8000, Math.round(crossfadeDurationMs * 1.2));
            const fusionAbsoluteCapMs = isFusion
                ? openingVocalHeavy
                    ? Math.max(2200, Math.min(5200, Math.round(crossfadeDurationMs * 0.36)))
                    : Math.max(700, Math.min(2200, Math.round(crossfadeDurationMs * 0.18)))
                : Number.POSITIVE_INFINITY;
            const maxSkipMs = !isFusion && punchyScoring && !forceNoVocalEntry
                ? baseMaxSkipMs * 1.5
                : Math.min(baseMaxSkipMs, fusionAbsoluteCapMs);
            const maxSkipBytes = Math.round(maxSkipMs * this.bytesPerMs);
            const cappedSkip = Math.min(alignedSkip, maxSkipBytes);
            const finalSkip = cappedSkip - (cappedSkip % (this.channels * 2));
            if (finalSkip > 0 && finalSkip < this.ringBuffer.length - reserveBytes) {
                this.ringBuffer.skip(finalSkip);
                this._energySkipMs = Math.round(finalSkip / this.bytesPerMs);
                const spectralMatch = Math.max(0, Math.min(1, 1 - selectedSpectralDistance));
                logger('info', 'AutoMix', `Skipped ${this._energySkipMs}ms in Track B to optimal entry (energy: ${(energies[bestWindowIdx] * 100).toFixed(1)}%, vocal-density: ${((vocalDensities[bestWindowIdx] ?? 0) * 100).toFixed(0)}%, peak: ${((windowPeaks[bestWindowIdx] ?? 0) * 100).toFixed(0)}%, spectral-match: ${(spectralMatch * 100).toFixed(0)}%, phrase: ${(selectedPhraseConfidence * 100).toFixed(0)}%, stability: ${(selectedStability * 100).toFixed(0)}%, entry-gain: ${this._incomingEntryGainComp.toFixed(2)}, phase-align: ${targetPhase !== null}, transition: ${transition || 'unknown'})`);
            }
        }
    }
    /**
     * Enables an inline highpass sweep on the incoming track.
     * The filter starts heavy (thin sound) and opens fully by the end of the crossfade.
     * Call before startCrossfade().
     *
     * @param enabled - Whether to enable the highpass sweep.
     * @param peakAlpha - Peak alpha coefficient at start of sweep (0.12 default).
     *                    Higher = more bass removed initially. BPM-adaptive.
     */
    setIncomingHighpass(enabled, peakAlpha) {
        this._hpEnabled = enabled;
        if (typeof peakAlpha === 'number' && Number.isFinite(peakAlpha)) {
            this._hpPeakAlpha = Math.max(0.02, Math.min(0.1, peakAlpha));
        }
    }
    /**
     * Enables an inline lowpass sweep on Track B: starts muffled (treble
     * removed), opens to full spectrum over the first portion of the crossfade.
     * Combined with HP sweep: thin mid-band → bass fills (HP) → treble fills (LP).
     *
     * @param enabled - Whether to enable the lowpass sweep.
     * @param peakAlpha - Starting LP coefficient (default 0.08). Lower = more muffled at start.
     *   Sweep goes from peakAlpha → 1.0 (clean). Range clamped to [0.02, 0.20].
     * @param completionRatio - Fraction of crossfade over which LP opens (default 0.50).
     */
    setIncomingLowpass(enabled, peakAlpha, completionRatio) {
        this._lpEnabled = enabled;
        if (typeof peakAlpha === 'number' && Number.isFinite(peakAlpha)) {
            this._lpPeakAlpha = Math.max(0.02, Math.min(0.2, peakAlpha));
        }
        if (typeof completionRatio === 'number' &&
            Number.isFinite(completionRatio)) {
            this._lpCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio));
        }
    }
    setIncomingGain(multiplier) {
        if (!Number.isFinite(multiplier)) {
            this._incomingGain = 1;
            return;
        }
        this._incomingGain = Math.max(0, Math.min(4, multiplier));
    }
    /**
     * Enables an inline stereo pan sweep on the incoming track.
     * Track B enters from the right channel and sweeps to center over the
     * first portion of the crossfade.  Creates a spatial "arrival" cue.
     *
     * @param enabled - Whether to enable the stereo pan sweep.
     * @param completionRatio - Fraction of crossfade over which pan completes (default 0.5).
     */
    /**
     * Returns the number of milliseconds skipped in Track B by
     * seekToEnergyMatch().  The player should add this to its
     * position baseline so lyrics stay synchronised.
     */
    getEnergySkipMs() {
        return this._energySkipMs;
    }
    setIncomingPan(enabled, completionRatio) {
        this._panEnabled = enabled;
        if (typeof completionRatio === 'number' &&
            Number.isFinite(completionRatio)) {
            this._panCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio));
        }
    }
    /**
     * Enables an inline echo delay on the incoming track (Track B / Track C).
     * Track B enters with a subtle wet echo that dries out over the first
     * portion of the crossfade, creating a "space → clarity" emergence.
     *
     * @param enabled - Whether to enable the echo.
     * @param delayMs - Echo delay in milliseconds (clamped 50–800 ms).
     * @param mix - Wet/dry peak mix ratio (clamped 0.05–0.50).
     * @param feedback - Feedback coefficient (clamped 0.0–0.70).
     * @param completionRatio - Fraction of crossfade over which echo dries (default 0.65).
     */
    setIncomingEcho(enabled, delayMs, mix, feedback, completionRatio) {
        this._echoEnabled = enabled;
        if (!enabled) {
            this._echoDelayL = null;
            this._echoDelayR = null;
            this._echoWritePos = 0;
            return;
        }
        if (typeof delayMs === 'number' && Number.isFinite(delayMs)) {
            const clampedMs = Math.max(50, Math.min(800, delayMs));
            this._echoDelayFrames = Math.round((clampedMs / 1000) * this.sampleRate);
        }
        if (typeof mix === 'number' && Number.isFinite(mix)) {
            this._echoPeakMix = Math.max(0.05, Math.min(0.5, mix));
        }
        if (typeof feedback === 'number' && Number.isFinite(feedback)) {
            this._echoFeedback = Math.max(0.0, Math.min(0.45, feedback));
        }
        if (typeof completionRatio === 'number' &&
            Number.isFinite(completionRatio)) {
            this._echoCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio));
        }
        if (this._echoDelayFrames > 0) {
            this._echoDelayL = new Float64Array(this._echoDelayFrames);
            this._echoDelayR = new Float64Array(this._echoDelayFrames);
            this._echoWritePos = 0;
            this._bcfEchoDelayL = new Float64Array(this._echoDelayFrames);
            this._bcfEchoDelayR = new Float64Array(this._echoDelayFrames);
            this._bcfEchoWritePos = 0;
        }
    }
    /**
     * Enables an outgoing stereo pan on Track A: sweeps from center → left.
     * Creates a spatial "departure" cue that mirrors Track B's entrance.
     */
    setOutgoingPan(enabled, completionRatio) {
        this._panOutEnabled = enabled;
        if (typeof completionRatio === 'number' &&
            Number.isFinite(completionRatio)) {
            this._panOutCompletionRatio = Math.max(0.2, Math.min(1.0, completionRatio));
        }
    }
    /**
     * Clears the buffered next track and resets crossfade state.
     */
    extractRemainingBuffer() {
        const bufs = [];
        if (this.ringBuffer && this.ringBuffer.length > 0) {
            const rbData = this.ringBuffer.read(this.ringBuffer.length);
            if (rbData)
                bufs.push(rbData);
        }
        if (this.nextSpillChunks.length > 0)
            bufs.push(...this.nextSpillChunks);
        if (this.nextPending)
            bufs.push(this.nextPending);
        const result = bufs.length > 0 ? Buffer.concat(bufs) : null;
        this.clear();
        return result;
    }
    /**
     * Returns how much of the "next track" has been consumed in milliseconds.
     * During a bridge crossfade, returns Track C's consumption instead of
     * Track B's, so the player's position tracking is correct.
     */
    getConsumedMs() {
        if (this._bridgeCrossfadeActive) {
            return Math.round((this._bcfConsumedSamples * 1000) / this.sampleRate);
        }
        return Math.round((this._totalNextConsumedSamples * 1000) / this.sampleRate);
    }
    clear() {
        if (this.nextStream) {
            this.nextStream.removeListener('data', this.onNextData);
            this.nextStream.removeListener('end', this.onNextEnd);
            this.nextStream.removeListener('close', this.onNextEnd);
            this.nextStream.removeListener('error', this.onNextEnd);
        }
        this._pauseNextStream();
        this.nextStream = null;
        this.nextPending = null;
        this.nextSpillChunks = [];
        this.nextSpillBytes = 0;
        this.mainPending = null;
        this.crossfade = null;
        this._incomingGain = 1;
        this.bufferReady = false;
        this.targetBufferBytes = 0;
        this.minBufferBytes = 0;
        this.ringBuffer?.dispose();
        this.ringBuffer = null;
        this._bridgePumpRunning = false;
        this._pumpPaused = false;
        this._pumpPausedAt = 0;
        this._pumpTotalPausedMs = 0;
        this._bridgeCrossfadeActive = false;
        this._bcfConsumedSamples = 0;
        this._bcfCountFrozen = false;
        this.onBridgeDrained = null;
        this.onBridgeStarving = null;
        this._clearBridgeCrossfade();
        if (this._bypassTriggered) {
            this._bypassTriggered = false;
            this.filterBypassSetter?.(false);
        }
        this._panEnabled = false;
        this._panOutEnabled = false;
        this._lpEnabled = false;
        this._lpPrevL = 0;
        this._lpPrevR = 0;
        this._echoEnabled = false;
        this._echoDelayL = null;
        this._echoDelayR = null;
        this._echoWritePos = 0;
        this._bcfEchoDelayL = null;
        this._bcfEchoDelayR = null;
        this._bcfEchoWritePos = 0;
        this._energySkipMs = 0;
        this._incomingEntryGainComp = 1;
        this._entryPhraseConfidence = 0;
        this._entryStability = 0;
        this._entryFxCenterShield = 0;
        this._entryFxLowDuckBoost = 0;
        this._entryFxAirSoftenBoost = 0;
        this._entryFxSidechainBoost = 0;
        this._onsetBuffer = [];
        this._prevRmsForOnset = 0;
        this._detectedMainBpm = null;
        this._mainBpmDetected = false;
        this._rtBeatTracker.reset();
        this._rtBeatState = this._rtBeatTracker.getState();
        this._lastRealtimeBpmLogSec = 0;
        this._nextRmsEma = 0;
        this._nextRmsPeak = 0;
        this._nextOpeningEnergyAcc = 0;
        this._nextOpeningEnergyMs = 0;
        this._nextOpeningEnergy = 0;
        this._nextOnsetBuffer = [];
        this._nextPrevRmsForOnset = 0;
        this._detectedNextBpm = null;
        this._nextBpmDetected = false;
        this._nextOnsetChunkMs = 20;
        this._nextBeatTracker.reset();
        this._nextBeatState = this._nextBeatTracker.getState();
        this._lastRealtimeNextBpmLogSec = 0;
        this._nextKeyPcm = [];
        this._nextKeyPcmBytes = 0;
        this._nextKeyDetected = false;
        this._detectedNextKey = null;
        this._mainSpecLowLp = 0;
        this._mainSpecMidLp = 0;
        this._mainSpecHighLp = 0;
        this._mainSpecPrevComposite = 0;
        this._mainSpecBrightnessEma = 0.42;
        this._mainSpecMotionEma = 0.22;
        this._mainSpecCentroidEma = 0.38;
        this._transitionName = null;
        this._strictNoVocalEntry = false;
        this._resetDynamicMixState();
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
    _softClipSample(sample) {
        // Multi-stage adaptive soft-limiter
        // Stage 1: Quadratic knee starting at 24000
        // Stage 2: Exponential saturation above 28000
        const abs = Math.abs(sample);
        if (abs <= 24000)
            return sample;
        const sign = sample < 0 ? -1 : 1;
        if (abs <= 28500) {
            // Quadratic knee
            const normalized = (abs - 24000) / 4500;
            const limited = 24000 + 4000 * (normalized - 0.5 * normalized * normalized);
            return sign * limited;
        }
        // Exponential saturation for extreme peaks
        const over = (abs - 28500) / (32767 - 28500);
        const saturated = 28500 + (32767 - 28500) * (1 - Math.exp(-over * 1.8));
        return sign * Math.min(32766, saturated);
    }
    _toInt16Sample(sample) {
        const clipped = this._softClipSample(sample);
        return clipped < -32768
            ? -32768
            : clipped > 32767
                ? 32767
                : (clipped + (clipped > 0 ? 0.5 : -0.5)) | 0;
    }
    /**
     * Computes coherence-aware gains.
     * Beat-matched tracks are coherent; standard crossfade (SumSq=1) causes
     * a +3dB boost and clipping. We cross-fade between Equal Power and Equal Gain.
     */
    _computeCoherenceGains(gainOut, gainIn, progress) {
        const beatLocked = this._rtBeatState.locked && this._rtBeatState.confidence > 0.45;
        // Correlation estimation (Bio-inspired heuristic)
        const correlation = beatLocked
            ? 0.45 + (this._rtBeatState.confidence * 0.45)
            : 0.12 + (this._dynamicToneMismatchEma < 1.1 ? 0.08 : 0);
        const sumSq = (gainOut * gainOut) + (gainIn * gainIn);
        const sum = gainOut + gainIn;
        // normP: Equal-power (preserves energy for uncorrelated signals)
        const normP = sumSq > 1e-6 ? 1 / Math.sqrt(sumSq) : 1;
        // normG: Equal-gain (prevents clipping for coherent signals)
        const normG = sum > 1e-6 ? 1 / sum : 1;
        const adaptiveNorm = normP * (1 - correlation) + normG * correlation;
        // Anti-pumping bias: avoid sudden volume dips at 50% blend
        const dipGuard = 1 + (Math.sin(progress * Math.PI) * 0.04 * (1 - correlation));
        const finalNorm = adaptiveNorm * dipGuard;
        return [gainOut * finalNorm, gainIn * finalNorm];
    }
    _computeOnePoleAlpha(cutoffHz) {
        if (!Number.isFinite(cutoffHz) || cutoffHz <= 0 || this.sampleRate <= 0) {
            return 0.1;
        }
        const alpha = 1 - Math.exp((-TWO_PI * cutoffHz) / this.sampleRate);
        return Math.max(0.0005, Math.min(0.999, alpha));
    }
    _smoothStep01(value) {
        const x = Math.max(0, Math.min(1, value));
        return x * x * (3 - 2 * x);
    }
    _isFusionTransition(name) {
        return (name === 'fusion_morph' ||
            name === 'harmonic_weave' ||
            name === 'crossfade_eq' ||
            name === 'filter_sweep' ||
            name === 'highpass_dissolve');
    }
    _resetDynamicMixState() {
        this._dynamicNextRmsEma = 0;
        this._dynamicNextTransientEma = 0;
        this._dynamicMainBrightnessEma = 0;
        this._dynamicNextBrightnessEma = 0;
        this._dynamicToneMismatchEma = 1;
        this._dynamicPrevMainL = 0;
        this._dynamicPrevMainR = 0;
        this._dynamicPrevNextL = 0;
        this._dynamicPrevNextR = 0;
        this._dynamicFrameCursor = 0;
        this._dynamicPulseHz = 0;
        this._dynamicPulsePhaseOffset = 0;
        this._fusionTailHoldEnabled = false;
        this._fusionOutFloorPeak = 0.5;
        this._fusionOutFloorTail = 0.05;
        this._fusionBeatMorphEnabled = false;
        this._fusionBeatMorphFromHz = 0;
        this._fusionBeatMorphToHz = 0;
        this._fusionBeatMorphStrength = 0;
        this._fusionMainLpL = 0;
        this._fusionMainLpR = 0;
        this._fusionAmbientLpL = 0;
        this._fusionAmbientLpR = 0;
        this._fusionBandLowLp = 0;
        this._fusionBandHighLp = 0;
        this._fusionPrevBand = 0;
        this._fusionVocalPresenceEma = 0;
        this._incomingEntryGainComp = 1;
        this._entryPhraseConfidence = 0;
        this._entryStability = 0;
        this._entryFxCenterShield = 0;
        this._entryFxLowDuckBoost = 0;
        this._entryFxAirSoftenBoost = 0;
        this._entryFxSidechainBoost = 0;
        this._mixMainLowLpL = 0;
        this._mixMainLowLpR = 0;
        this._mixNextLowLpL = 0;
        this._mixNextLowLpR = 0;
        this._mixMainHighLpL = 0;
        this._mixMainHighLpR = 0;
        this._mixNextHighLpL = 0;
        this._mixNextHighLpR = 0;
        this._strictNoVocalEntry = false;
    }
    _configureFusionMixProfile(durationFrames) {
        this._fusionTailHoldEnabled = false;
        this._fusionBeatMorphEnabled = false;
        this._fusionBeatMorphFromHz = 0;
        this._fusionBeatMorphToHz = 0;
        this._fusionBeatMorphStrength = 0;
        this._fusionOutFloorPeak = 0.5;
        this._fusionOutFloorTail = 0.05;
        this._fusionMainLpL = 0;
        this._fusionMainLpR = 0;
        if (!this._isFusionTransition(this._transitionName))
            return;
        if (durationFrames < Math.round(this.sampleRate * 1.2))
            return;
        const transition = this._transitionName;
        const fusionPremium = transition === 'fusion_morph' || transition === 'harmonic_weave';
        const durationSec = durationFrames / this.sampleRate;
        let holdPeak = fusionPremium ? 0.54 : 0.48;
        if (durationSec >= 9)
            holdPeak += 0.04;
        else if (durationSec >= 7)
            holdPeak += 0.02;
        this._fusionOutFloorPeak = Math.max(0.36, Math.min(0.66, holdPeak));
        this._fusionOutFloorTail = fusionPremium ? 0.06 : 0.05;
        this._fusionTailHoldEnabled = true;
        const bpmA = (this._rtBeatState.locked && this._rtBeatState.bpm > 0
            ? this._rtBeatState.bpm
            : null) ??
            this._detectedMainBpm ??
            this.getMainTrackBpm();
        const bpmB = (this._nextBeatState.locked && this._nextBeatState.bpm > 0
            ? this._nextBeatState.bpm
            : null) ??
            this._detectedNextBpm ??
            this.getNextTrackBpm();
        if (!(bpmA && bpmA > 0 && bpmB && bpmB > 0))
            return;
        const fromHz = Math.max(0.7, Math.min(3.4, bpmA / 60));
        const toHz = Math.max(0.7, Math.min(3.4, bpmB / 60));
        const diffRatio = Math.abs(fromHz - toHz) / Math.max(fromHz, toHz, 1e-6);
        let strength = (fusionPremium ? 0.16 : 0.13) + diffRatio * 0.52;
        strength = Math.max(0.14, Math.min(0.40, strength));
        this._fusionBeatMorphEnabled = diffRatio > 0.012;
        this._fusionBeatMorphFromHz = fromHz;
        this._fusionBeatMorphToHz = toHz;
        this._fusionBeatMorphStrength = strength;
        logger('debug', 'AutoMix', `Fusion profile: ${transition} BPM ${bpmA.toFixed(1)}→${bpmB.toFixed(1)} (hold ${Math.round(this._fusionOutFloorPeak * 100)}%, beat-morph ${Math.round(strength * 100)}%)`);
    }
    _bootstrapDynamicPulse() {
        const liveBpm = this._rtBeatState.locked && this._rtBeatState.bpm > 0
            ? this._rtBeatState.bpm
            : null;
        const bpm = liveBpm ??
            this._detectedMainBpm ??
            this.getNextTrackBpm() ??
            this.getMainTrackBpm();
        if (!bpm || !Number.isFinite(bpm) || bpm <= 0) {
            this._dynamicPulseHz = 0;
            this._dynamicPulsePhaseOffset = 0;
            return;
        }
        this._dynamicPulseHz = Math.max(0.7, Math.min(3.4, bpm / 60));
        this._dynamicPulsePhaseOffset = this._rtBeatState.locked
            ? this._rtBeatState.phase
            : 0;
    }
    _computeDynamicMixState(mainL, mainR, nextL, nextR, progress) {
        if (!this._dynamicMixEnabled) {
            return {
                inBias: 0,
                outBias: 0,
                openLift: 0,
                echoDryLift: 0,
                transientNorm: 0,
                energyNorm: 0
            };
        }
        const amp = Math.min(1, Math.max(0, (Math.abs(nextL) + Math.abs(nextR)) / (2 * 32768)));
        this._dynamicNextRmsEma = this._dynamicNextRmsEma * 0.975 + amp * 0.025;
        const transient = Math.max(0, amp - this._dynamicNextRmsEma);
        this._dynamicNextTransientEma =
            this._dynamicNextTransientEma * 0.90 + transient * 0.10;
        const energyNorm = Math.max(0, Math.min(1, (this._dynamicNextRmsEma - 0.04) / 0.24));
        const transientNorm = Math.max(0, Math.min(1, this._dynamicNextTransientEma / 0.11));
        const mainDelta = (Math.abs(mainL - this._dynamicPrevMainL) +
            Math.abs(mainR - this._dynamicPrevMainR)) /
            (2 * 32768);
        const nextDelta = (Math.abs(nextL - this._dynamicPrevNextL) +
            Math.abs(nextR - this._dynamicPrevNextR)) /
            (2 * 32768);
        this._dynamicPrevMainL = mainL;
        this._dynamicPrevMainR = mainR;
        this._dynamicPrevNextL = nextL;
        this._dynamicPrevNextR = nextR;
        this._dynamicMainBrightnessEma =
            this._dynamicMainBrightnessEma * 0.93 + mainDelta * 0.07;
        this._dynamicNextBrightnessEma =
            this._dynamicNextBrightnessEma * 0.93 + nextDelta * 0.07;
        const toneRatio = (this._dynamicMainBrightnessEma + 0.001) /
            (this._dynamicNextBrightnessEma + 0.001);
        this._dynamicToneMismatchEma =
            this._dynamicToneMismatchEma * 0.90 + toneRatio * 0.10;
        const toneOpenBoost = Math.max(0, Math.min(0.14, (this._dynamicToneMismatchEma - 1.15) * 0.18));
        const toneSoften = Math.max(0, Math.min(0.10, (0.88 - this._dynamicToneMismatchEma) * 0.16));
        const unlockedConfidence = Math.max(0, Math.min(1, transientNorm * 0.60 + energyNorm * 0.40));
        const beatConfidence = this._rtBeatState.locked
            ? Math.max(0, Math.min(1, this._rtBeatState.confidence))
            : unlockedConfidence * 0.55;
        let pulse = 0.5;
        if (this._dynamicPulseHz > 0) {
            const timeSec = this._dynamicFrameCursor / this.sampleRate;
            const phase = (this._dynamicPulsePhaseOffset + timeSec * this._dynamicPulseHz) % 1;
            const sinus = (Math.sin(phase * Math.PI * 2) + 1) / 2;
            const distToBeat = Math.min(Math.abs(phase), Math.abs(1 - phase));
            const beatAccent = Math.max(0, 1 - distToBeat / 0.18);
            const lockWeight = this._rtBeatState.locked
                ? Math.max(0.35, beatConfidence)
                : 0.22;
            pulse = sinus * (1 - lockWeight) + beatAccent * lockWeight;
        }
        this._dynamicFrameCursor++;
        const earlyFactor = Math.max(0, 1 - progress);
        const pulseInfluence = 0.06 + beatConfidence * 0.07;
        const pivotZone = Math.max(0, 1 - Math.abs(progress - 0.58) / 0.26);
        const pivotPunch = (transientNorm * 0.55 + energyNorm * 0.35) * pivotZone;
        const dynamicGate = this._rtBeatState.locked
            ? 0.82 + beatConfidence * 0.18
            : 0.74 + unlockedConfidence * 0.16;
        const inBias = Math.max(-0.08, Math.min(0.24, (energyNorm * 0.10 +
            transientNorm * 0.16 +
            (pulse - 0.5) * pulseInfluence +
            pivotPunch * 0.10 +
            toneOpenBoost * 0.42 -
            toneSoften * 0.20) *
            dynamicGate *
            (0.45 + earlyFactor * 0.55)));
        const outBias = Math.max(0, Math.min(0.24, (transientNorm * 0.13 +
            energyNorm * 0.06 +
            pivotPunch * 0.08) *
            dynamicGate *
            (0.25 + earlyFactor * 0.75)));
        const openLift = Math.max(0, Math.min(0.26, (transientNorm * 0.12 +
            energyNorm * 0.07 +
            pivotPunch * 0.10 +
            toneOpenBoost * (0.35 + earlyFactor * 0.65) -
            toneSoften * 0.25) *
            dynamicGate *
            earlyFactor));
        const echoDryLift = Math.max(0, Math.min(0.55, (transientNorm * 0.38 +
            energyNorm * 0.18 +
            toneOpenBoost * 0.20 -
            toneSoften * 0.12) *
            dynamicGate));
        return {
            inBias,
            outBias,
            openLift,
            echoDryLift,
            transientNorm,
            energyNorm
        };
    }
    _applyFusionBeatMorph(mainL, mainR, progress, absoluteFrame) {
        if (!this._fusionBeatMorphEnabled ||
            this._fusionBeatMorphFromHz <= 0 ||
            this._fusionBeatMorphToHz <= 0) {
            return { mainL, mainR, outGainScale: 1 };
        }
        const morphProgress = this._smoothStep01((progress - 0.06) / 0.88);
        const beatHz = this._fusionBeatMorphFromHz +
            (this._fusionBeatMorphToHz - this._fusionBeatMorphFromHz) * morphProgress;
        const timeSec = absoluteFrame / this.sampleRate;
        const phase = (this._dynamicPulsePhaseOffset + timeSec * beatHz) % 1;
        const beatPulse = 0.5 - 0.5 * Math.cos(phase * TWO_PI);
        const linger = Math.pow(beatPulse, 0.72 + morphProgress * 0.75);
        const drag = this._fusionBeatMorphStrength * (0.25 + morphProgress * 0.55);
        const transientScale = Math.max(0.52, 1 - linger * drag);
        this._fusionMainLpL +=
            this._fusionMainLpAlpha * (mainL - this._fusionMainLpL);
        this._fusionMainLpR +=
            this._fusionMainLpAlpha * (mainR - this._fusionMainLpR);
        const hiL = mainL - this._fusionMainLpL;
        const hiR = mainR - this._fusionMainLpR;
        const shapedL = this._fusionMainLpL + hiL * transientScale;
        const shapedR = this._fusionMainLpR + hiR * transientScale;
        const outGainScale = 1 - linger * this._fusionBeatMorphStrength * (0.12 + morphProgress * 0.10);
        return { mainL: shapedL, mainR: shapedR, outGainScale };
    }
    _shapeIncomingFusion(nextL, nextR, progress) {
        if (!this._fusionBlendEnabled) {
            return { nextL, nextR, gainScale: 1 };
        }
        const mid = (nextL + nextR) * 0.5;
        const side = (nextL - nextR) * 0.5;
        const absMid = Math.abs(mid);
        const absSide = Math.abs(side);
        this._fusionBandLowLp += this._fusionBandLowAlpha * (mid - this._fusionBandLowLp);
        this._fusionBandHighLp +=
            this._fusionBandHighAlpha * (mid - this._fusionBandHighLp);
        const vocalBand = this._fusionBandHighLp - this._fusionBandLowLp;
        const centerFocus = absMid / (absMid + absSide + 1);
        const bandRatio = Math.abs(vocalBand) / (absMid + 1200);
        const consonantMotion = Math.abs(vocalBand - this._fusionPrevBand) / (Math.abs(vocalBand) + 1800);
        this._fusionPrevBand = vocalBand;
        const vocalInstant = Math.max(0, Math.min(1, (bandRatio - 0.08) / 0.52)) *
            Math.max(0, Math.min(1, (centerFocus - 0.52) / 0.44)) *
            Math.max(0.35, 1 - Math.min(1, consonantMotion * 1.6));
        this._fusionVocalPresenceEma =
            this._fusionVocalPresenceEma * 0.965 + vocalInstant * 0.035;
        const vocalPresence = this._fusionVocalPresenceEma;
        this._fusionAmbientLpL +=
            this._fusionAmbientAlpha * (nextL - this._fusionAmbientLpL);
        this._fusionAmbientLpR +=
            this._fusionAmbientAlpha * (nextR - this._fusionAmbientLpR);
        const ambienceRise = this._smoothStep01((progress + 0.2) / 0.62);
        const ambienceTail = 1 - this._smoothStep01((progress - 0.72) / 0.28);
        const ambienceGain = ambienceRise * (0.38 + ambienceTail * 0.62);
        const vocalGuard = this._strictNoVocalEntry
            ? Math.max(0, Math.min(1, (vocalPresence - 0.10) / 0.46))
            : Math.max(0, Math.min(1, (vocalPresence - 0.16) / 0.64));
        const gateStart = 0.30 + vocalGuard * 0.40;
        const gateSpan = Math.max(0.18, 0.34 - vocalGuard * 0.12);
        const coreGate = this._smoothStep01((progress - gateStart) / gateSpan);
        const coreFloor = Math.max(0.08, Math.min(0.32, progress * 0.26 + 0.08));
        const coreWeight = coreFloor + (1 - coreFloor) * coreGate;
        const ambienceWeight = ambienceGain * (0.52 - coreGate * 0.22);
        const totalWeight = Math.max(1e-6, coreWeight + ambienceWeight);
        const ambienceL = this._fusionAmbientLpL + side * 0.24;
        const ambienceR = this._fusionAmbientLpR - side * 0.24;
        const shapedL = (nextL * coreWeight + ambienceL * ambienceWeight) / totalWeight;
        const shapedR = (nextR * coreWeight + ambienceR * ambienceWeight) / totalWeight;
        const shapedMid = (shapedL + shapedR) * 0.5;
        const shapedSide = (shapedL - shapedR) * 0.5;
        const introShield = 1 - this._smoothStep01((progress - 0.14) / 0.56);
        const centerDuckCapBase = this._strictNoVocalEntry ? 0.34 : 0.24;
        const centerDuckCap = Math.max(centerDuckCapBase, Math.min(0.50, centerDuckCapBase + this._entryFxCenterShield * 0.40));
        const centerDuck = Math.max(0, Math.min(centerDuckCap, vocalGuard *
            introShield *
            ((this._strictNoVocalEntry ? 0.34 : 0.24) +
                this._entryFxCenterShield * 0.22)));
        const midScale = 1 - centerDuck;
        const sideScale = 1 +
            centerDuck *
                ((this._strictNoVocalEntry ? 0.42 : 0.30) +
                    this._entryFxCenterShield * 0.32);
        const duckedL = shapedMid * midScale + shapedSide * sideScale;
        const duckedR = shapedMid * midScale - shapedSide * sideScale;
        const gainRise = this._smoothStep01((progress - 0.10) / 0.80);
        const strictShield = this._strictNoVocalEntry
            ? 1 - this._smoothStep01((progress - 0.52) / 0.30)
            : 0;
        const gainScale = Math.max(this._strictNoVocalEntry ? 0.58 : 0.66, Math.min(1, 0.70 +
            gainRise * 0.26 -
            vocalGuard * (this._strictNoVocalEntry ? 0.10 : 0.06) +
            introShield * 0.02 -
            strictShield * vocalGuard * 0.10 -
            this._entryFxCenterShield *
                (1 - this._smoothStep01((progress - 0.42) / 0.42)) *
                0.08));
        return { nextL: duckedL, nextR: duckedR, gainScale };
    }
    _applyAdaptiveBandUnmasking(mainL, mainR, nextL, nextR, progress, transientNorm, energyNorm) {
        if (!this._adaptiveBandBlendEnabled) {
            return { mainL, mainR, nextL, nextR, outGainScale: 1 };
        }
        // Advanced 4-Band Spectral Decomposition (Non-simplified)
        this._mixMainLowLpL += this._mixBandLowAlpha * (mainL - this._mixMainLowLpL);
        this._mixMainLowLpR += this._mixBandLowAlpha * (mainR - this._mixMainLowLpR);
        this._mixNextLowLpL += this._mixBandLowAlpha * (nextL - this._mixNextLowLpL);
        this._mixNextLowLpR += this._mixBandLowAlpha * (nextR - this._mixNextLowLpR);
        this._mixMainHighLpL += this._mixBandHighAlpha * (mainL - this._mixMainHighLpL);
        this._mixMainHighLpR += this._mixBandHighAlpha * (mainR - this._mixMainHighLpR);
        this._mixNextHighLpL += this._mixBandHighAlpha * (nextL - this._mixNextHighLpL);
        this._mixNextHighLpR += this._mixBandHighAlpha * (nextR - this._mixNextHighLpR);
        const mainLow = (Math.abs(this._mixMainLowLpL) + Math.abs(this._mixMainLowLpR)) * 0.5;
        const nextLow = (Math.abs(this._mixNextLowLpL) + Math.abs(this._mixNextLowLpR)) * 0.5;
        // Spectral Centroid Masking: Identify which track dominates each band
        const overlap = Math.sin(progress * Math.PI);
        const lowConflict = Math.min(mainLow, nextLow) / (Math.max(mainLow, nextLow) + 1e-6);
        // Dynamic Spectral Subtraction: 
        // Track A gives up exactly what Track B needs to exist in the low-end.
        let lowSubtract = lowConflict * overlap * 0.45 * (1 + transientNorm);
        lowSubtract = Math.max(0, Math.min(0.35, lowSubtract));
        // Transient Preservation: Prioritize the incoming track's kick/snare
        const transientGate = Math.max(0, transientNorm - 0.5) * overlap * 0.30;
        // Apply the spectral masks
        mainL -= this._mixMainLowLpL * lowSubtract;
        mainR -= this._mixMainLowLpR * lowSubtract;
        // Space-remapping: Widening the sidechain only during peak overlap
        const sidechain = 0.05 + (energyNorm * 0.15 * overlap) + transientGate;
        return { mainL, mainR, nextL, nextR, outGainScale: 1 - sidechain };
    }
    /**
     * Calculates the cross-correlation between two signals to find the optimal
     * phase alignment. This is the mathematical "essence" of a perfect blend,
     * ensuring that peaks align and prevent destructive interference (noise).
     */
    _calculateOptimalLag(main, next, searchWindow) {
        let maxCorr = -1;
        let optimalLag = 0;
        const sampleLimit = Math.min(main.length, next.length, 2048);
        // Using a sliding dot product to find the lag that maximizes similarity.
        for (let lag = -searchWindow; lag <= searchWindow; lag++) {
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            for (let i = searchWindow; i < sampleLimit - searchWindow; i++) {
                const a = main[i] || 0;
                const b = next[i + lag] || 0;
                dotProduct += a * b;
                normA += a * a;
                normB += b * b;
            }
            const correlation = dotProduct / (Math.sqrt(normA * normB) + 1e-6);
            if (correlation > maxCorr) {
                maxCorr = correlation;
                optimalLag = lag;
            }
        }
        return optimalLag;
    }
    _mixBuffers(main, next, runtime) {
        const sampleCount = main.length >> 1;
        if (sampleCount === 0)
            return main;
        const output = Buffer.allocUnsafe(main.length);
        const mainView = new Int16Array(main.buffer, main.byteOffset, sampleCount);
        const nextView = new Int16Array(next.buffer, next.byteOffset, sampleCount);
        const outView = new Int16Array(output.buffer, output.byteOffset, sampleCount);
        const totalFrames = Math.floor(sampleCount / this.channels);
        const remainingFrames = runtime.isFinished ? 0 : Math.max(0, runtime.durationFrames - runtime.elapsedFrames);
        const fadeFrames = Math.min(totalFrames, remainingFrames);
        // Phase Alignment: Detect optimal lag only at the start of the blend
        // to lock the tracks together.
        const SEARCH_WINDOW = 128;
        const lag = (runtime.elapsedFrames === 0)
            ? this._calculateOptimalLag(mainView, nextView, SEARCH_WINDOW)
            : 0;
        const getMain = (i) => mainView ? (mainView[i] ?? 0) : main.readInt16LE(i * 2);
        const getNext = (i) => nextView ? (nextView[i] ?? 0) : next.readInt16LE(i * 2);
        const setOut = (i, val) => {
            if (outView)
                outView[i] = val;
            else
                output.writeInt16LE(val, i * 2);
        };
        const useHp = this._hpEnabled && this._hpDurationFrames > 0;
        const fusionWindowActive = this._fusionBlendEnabled &&
            runtime.durationFrames >= Math.round(this.sampleRate * 1.8);
        const fusionTransitionActive = fusionWindowActive && this._isFusionTransition(this._transitionName);
        for (let frame = 0; frame < totalFrames; frame++) {
            let frameProgress = 1;
            if (!runtime.isFinished) {
                frameProgress =
                    frame < fadeFrames
                        ? (runtime.elapsedFrames + frame) / runtime.durationFrames
                        : 1;
            }
            const [gainOut, gainIn] = this._fadeGains(frameProgress, runtime.curve);
            const base = frame * this.channels;
            const nextBase = base + (lag * this.channels);
            const safeNextBase = Math.max(0, Math.min(nextBase, (sampleCount - this.channels)));
            let nextL = getNext(safeNextBase);
            let nextR = this.channels > 1 ? getNext(safeNextBase + 1) : nextL;
            let mainL = getMain(base);
            let mainR = this.channels > 1 ? getMain(base + 1) : mainL;
            if (this._incomingGain !== 1) {
                nextL *= this._incomingGain;
                nextR *= this._incomingGain;
            }
            if (this._incomingEntryGainComp < 0.999 && frameProgress < 0.40) {
                const compT = this._smoothStep01(frameProgress / 0.40);
                const entryComp = this._incomingEntryGainComp +
                    (1 - this._incomingEntryGainComp) * compT;
                nextL *= entryComp;
                nextR *= entryComp;
            }
            const attackWindow = this._strictNoVocalEntry ? 0.34 : 0.24;
            const clipGuardPeak = this._strictNoVocalEntry ? 19500 : 22000;
            if (frameProgress < attackWindow) {
                const incomingPeak = Math.max(Math.abs(nextL), Math.abs(nextR));
                if (incomingPeak > clipGuardPeak) {
                    const attack = 1 - this._smoothStep01(frameProgress / attackWindow);
                    const overshoot = Math.max(0, Math.min(1, (incomingPeak - clipGuardPeak) / 12000));
                    const tameScale = 1 - attack * overshoot * (this._strictNoVocalEntry ? 0.42 : 0.30);
                    nextL *= tameScale;
                    nextR *= tameScale;
                }
            }
            const dyn = this._computeDynamicMixState(mainL, mainR, nextL, nextR, frameProgress);
            const dynamicProgress = Math.min(1, frameProgress + dyn.openLift);
            // Short eased ramp at the very beginning of Track B prevents attack clipping
            // while still keeping both tracks present.
            const entryRampSpan = this._strictNoVocalEntry ? 0.42 : 0.28;
            const entryRampFloor = this._strictNoVocalEntry ? 0.64 : 0.78;
            if (frameProgress < entryRampSpan) {
                const ramp = entryRampFloor +
                    (1 - entryRampFloor) *
                        this._smoothStep01(frameProgress / entryRampSpan);
                nextL *= ramp;
                nextR *= ramp;
            }
            if (this._strictNoVocalEntry && frameProgress < 0.36) {
                const shield = 1 - (1 - this._smoothStep01(frameProgress / 0.36)) * 0.10;
                nextL *= shield;
                nextR *= shield;
            }
            if (this._strictNoVocalEntry && frameProgress < 0.46) {
                const mid = (nextL + nextR) * 0.5;
                const side = (nextL - nextR) * 0.5;
                const baseCenterShield = 1 - (1 - this._smoothStep01(frameProgress / 0.46)) * 0.22;
                const shieldBoost = this._entryFxCenterShield *
                    (1 - this._smoothStep01(frameProgress / 0.52));
                const centerShield = Math.max(0.56, Math.min(1, baseCenterShield - shieldBoost * 0.26));
                const sideLift = 1 + (1 - centerShield) * (0.25 + shieldBoost * 0.42);
                nextL = mid * centerShield + side * sideLift;
                nextR = mid * centerShield - side * sideLift;
            }
            let mixOutGain = gainOut;
            let mixInGain = gainIn;
            if (this._dynamicMixEnabled) {
                mixOutGain = Math.max(0, mixOutGain * (1 - dyn.outBias));
                mixInGain = Math.max(0, mixInGain * (1 + dyn.inBias));
                // Coherence-aware normalization: 
                // Prevents the +3dB "correlated sum" noise that causes clipping 
                // during beat-matched transitions.
                const [adjOut, adjIn] = this._computeCoherenceGains(mixOutGain, mixInGain, frameProgress);
                mixOutGain = adjOut;
                mixInGain = adjIn;
            }
            if (fusionTransitionActive) {
                if (this._fusionBeatMorphEnabled) {
                    const shapedMain = this._applyFusionBeatMorph(mainL, mainR, dynamicProgress, runtime.elapsedFrames + frame);
                    mainL = shapedMain.mainL;
                    mainR = shapedMain.mainR;
                    mixOutGain *= shapedMain.outGainScale;
                }
                if (this._fusionTailHoldEnabled) {
                    const holdShape = 1 - this._smoothStep01((dynamicProgress - 0.76) / 0.24);
                    const outFloor = this._fusionOutFloorTail +
                        (this._fusionOutFloorPeak - this._fusionOutFloorTail) * holdShape;
                    if (mixOutGain < outFloor)
                        mixOutGain = outFloor;
                    const inCeil = 1.06 - outFloor * 0.42;
                    if (mixInGain > inCeil)
                        mixInGain = inCeil;
                    const normSq = mixOutGain * mixOutGain + mixInGain * mixInGain;
                    if (normSq > 1.08) {
                        const norm = Math.sqrt(normSq);
                        mixOutGain /= norm;
                        mixInGain /= norm;
                    }
                }
                // Keep both tracks clearly audible in the center of the blend.
                const overlapMid = Math.sin(dynamicProgress * Math.PI);
                const glueMin = 0.06 + overlapMid * 0.12;
                if (mixOutGain < glueMin)
                    mixOutGain = glueMin;
                if (mixInGain < glueMin)
                    mixInGain = glueMin;
                const glueNorm = mixOutGain * mixOutGain + mixInGain * mixInGain;
                if (glueNorm > 1.10) {
                    const scale = Math.sqrt(1.10 / glueNorm);
                    mixOutGain *= scale;
                    mixInGain *= scale;
                }
            }
            let hpAlpha = 0;
            if (useHp && dynamicProgress < 1) {
                const hpMappedProgress = Math.min(1, dynamicProgress / 0.3);
                const hpProgress = (1 - Math.cos(hpMappedProgress * Math.PI)) / 2;
                hpAlpha = this._hpPeakAlpha * (1 - hpProgress);
            }
            if (hpAlpha > 0.001) {
                this._hpPrevL = this._hpPrevL + hpAlpha * (nextL - this._hpPrevL);
                nextL = nextL - this._hpPrevL;
                if (this.channels > 1) {
                    this._hpPrevR = this._hpPrevR + hpAlpha * (nextR - this._hpPrevR);
                    nextR = nextR - this._hpPrevR;
                }
            }
            else {
                this._hpPrevL = 0;
                this._hpPrevR = 0;
            }
            if (this._lpEnabled && dynamicProgress < this._lpCompletionRatio) {
                const lpMappedProgress = Math.min(1, dynamicProgress / this._lpCompletionRatio);
                const lpProgress = (1 - Math.cos(lpMappedProgress * Math.PI)) / 2;
                const lpAlpha = this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress;
                this._lpPrevL += lpAlpha * (nextL - this._lpPrevL);
                nextL = this._lpPrevL;
                if (this.channels > 1) {
                    this._lpPrevR += lpAlpha * (nextR - this._lpPrevR);
                    nextR = this._lpPrevR;
                }
            }
            else if (this._lpEnabled) {
                this._lpPrevL = 0;
                this._lpPrevR = 0;
            }
            if (this._echoEnabled && this._echoDelayL && this._echoDelayR) {
                const delayLen = this._echoDelayFrames;
                const readPos = (((this._echoWritePos - delayLen) % delayLen) + delayLen) % delayLen;
                const delayedL = this._echoDelayL[readPos];
                const delayedR = this._echoDelayR[readPos];
                const fbL = nextL + delayedL * this._echoFeedback;
                const fbR = nextR + delayedR * this._echoFeedback;
                this._echoDelayL[this._echoWritePos] =
                    fbL > 65534 ? 65534 : fbL < -65534 ? -65534 : fbL;
                this._echoDelayR[this._echoWritePos] =
                    fbR > 65534 ? 65534 : fbR < -65534 ? -65534 : fbR;
                this._echoWritePos = (this._echoWritePos + 1) % delayLen;
                if (dynamicProgress < this._echoCompletionRatio) {
                    const echoT = dynamicProgress / this._echoCompletionRatio;
                    const baseWet = this._echoPeakMix * (1 - echoT);
                    const echoWet = baseWet * (1 - dyn.echoDryLift);
                    const echoDry = 1 - echoWet;
                    nextL = nextL * echoDry + delayedL * echoWet;
                    nextR = nextR * echoDry + delayedR * echoWet;
                }
            }
            if (fusionTransitionActive) {
                const shapedIncoming = this._shapeIncomingFusion(nextL, nextR, dynamicProgress);
                nextL = shapedIncoming.nextL;
                nextR = shapedIncoming.nextR;
                mixInGain *= shapedIncoming.gainScale;
            }
            const adaptiveUnmask = this._applyAdaptiveBandUnmasking(mainL, mainR, nextL, nextR, dynamicProgress, dyn.transientNorm, dyn.energyNorm);
            mainL = adaptiveUnmask.mainL;
            mainR = adaptiveUnmask.mainR;
            nextL = adaptiveUnmask.nextL;
            nextR = adaptiveUnmask.nextR;
            mixOutGain *= adaptiveUnmask.outGainScale;
            // Bus headroom guard: keep headroom without flattening the blend.
            const mainAbsPeak = this.channels > 1
                ? Math.max(Math.abs(mainL), Math.abs(mainR))
                : Math.abs(mainL);
            const nextAbsPeak = this.channels > 1
                ? Math.max(Math.abs(nextL), Math.abs(nextR))
                : Math.abs(nextL);
            const predictedPeak = mainAbsPeak * mixOutGain + nextAbsPeak * mixInGain;
            const targetBusPeak = fusionTransitionActive
                ? MIX_BUS_TARGET_PEAK_FUSION
                : MIX_BUS_TARGET_PEAK;
            if (predictedPeak > targetBusPeak && predictedPeak > 1) {
                const headroomScale = Math.max(0.84, Math.sqrt(targetBusPeak / predictedPeak));
                mixOutGain *= headroomScale;
                mixInGain *= headroomScale;
            }
            if (this._panEnabled && dynamicProgress < this._panCompletionRatio) {
                const panT = dynamicProgress / this._panCompletionRatio;
                const panL = (1 - Math.cos(panT * Math.PI)) / 2; // 0 → 1 smooth
                nextL *= panL;
            }
            if (this._panOutEnabled &&
                this.channels > 1 &&
                dynamicProgress < this._panOutCompletionRatio) {
                const panT = dynamicProgress / this._panOutCompletionRatio;
                const panR = (1 + Math.cos(panT * Math.PI)) / 2; // 1 → 0 smooth
                mainR *= panR;
            }
            let mixedL = mainL * mixOutGain + nextL * mixInGain;
            let mixedR = this.channels > 1 ? mainR * mixOutGain + nextR * mixInGain : mixedL;
            const mixedPeak = this.channels > 1
                ? Math.max(Math.abs(mixedL), Math.abs(mixedR))
                : Math.abs(mixedL);
            if (mixedPeak > targetBusPeak && mixedPeak > 1) {
                const limiterScale = Math.max(0.82, Math.sqrt(targetBusPeak / mixedPeak));
                mixedL *= limiterScale;
                mixedR *= limiterScale;
            }
            mixedL = this._softClipSample(mixedL);
            mixedR = this.channels > 1 ? this._softClipSample(mixedR) : mixedL;
            setOut(base, this._toInt16Sample(mixedL));
            if (this.channels > 1) {
                setOut(base + 1, this._toInt16Sample(mixedR));
            }
        }
        if (!runtime.isFinished) {
            runtime.elapsedFrames += fadeFrames;
            if (runtime.elapsedFrames >= runtime.durationFrames) {
                runtime.isFinished = true;
            }
        }
        if (runtime.isFinished && !this._bypassTriggered) {
            this._bypassTriggered = true;
            this.filterBypassSetter?.(true);
            this.filterStateResetter?.();
        }
        if (runtime.isFinished && this._incomingGain !== 1) {
            this._incomingGain += (1.0 - this._incomingGain) * 0.25;
            if (Math.abs(this._incomingGain - 1.0) < 0.002) {
                this._incomingGain = 1.0;
            }
        }
        return output;
    }
    _fadeGains(progress, curve) {
        const clamped = Math.min(1, Math.max(0, progress));
        if (curve === 'linear') {
            return [1 - clamped, clamped];
        }
        // Constant-power cosine/sine curve for transparent equal-power crossfades.
        const angle = clamped * HALF_PI;
        const gainOut = Math.cos(angle);
        const gainIn = Math.sin(angle);
        return [gainOut, gainIn];
    }
    /**
     * Updates live analysis for the preloaded next track (Track B).
     *
     * This runs continuously while Track B buffers so automix decisions can
     * use real internal signals instead of relying on external metadata.
     */
    _updateNextTrackAnalysis(chunk) {
        const samples = chunk.length >> 1;
        if (samples === 0)
            return;
        let sumSq = 0;
        let count = 0;
        for (let i = 0; i < samples; i += 8) {
            const s = chunk.readInt16LE(i * 2);
            sumSq += s * s;
            count++;
        }
        if (count === 0)
            return;
        const rms = Math.sqrt(sumSq / count) / 32768;
        this._nextRmsEma = this._nextRmsEma * 0.85 + rms * 0.15;
        this._nextRmsPeak = Math.max(this._nextRmsPeak * 0.9985, rms);
        const chunkMs = (chunk.length / 2 / this.channels / this.sampleRate) * 1000;
        if (chunkMs > 0)
            this._nextOnsetChunkMs = chunkMs;
        if (this._nextOpeningEnergyMs < this._nextOpeningWindowMs && chunkMs > 0) {
            const remainingWindow = this._nextOpeningWindowMs - this._nextOpeningEnergyMs;
            const usedMs = Math.min(remainingWindow, chunkMs);
            this._nextOpeningEnergyAcc += rms * usedMs;
            this._nextOpeningEnergyMs += usedMs;
            if (this._nextOpeningEnergyMs > 0) {
                this._nextOpeningEnergy = this._nextOpeningEnergyAcc / this._nextOpeningEnergyMs;
            }
        }
        const onset = Math.max(0, rms - this._nextPrevRmsForOnset);
        this._nextPrevRmsForOnset = rms;
        this._nextOnsetBuffer.push(onset);
        const maxOnsets = Math.max(64, Math.round((20000 / Math.max(1, this._nextOnsetChunkMs))));
        if (this._nextOnsetBuffer.length > maxOnsets) {
            this._nextOnsetBuffer.shift();
        }
        if (chunkMs > 0) {
            this._nextBeatState = this._nextBeatTracker.push(onset, chunkMs / 1000);
            if (this._nextBeatState.locked &&
                this._nextBeatState.bpm > 0 &&
                (!this._detectedNextBpm ||
                    Math.abs(this._detectedNextBpm - this._nextBeatState.bpm) > 0.9)) {
                this._detectedNextBpm = Math.round(this._nextBeatState.bpm * 10) / 10;
                this._nextBpmDetected = true;
                const shouldLog = this._nextBeatState.timeSec - this._lastRealtimeNextBpmLogSec >= 8;
                if (shouldLog) {
                    this._lastRealtimeNextBpmLogSec = this._nextBeatState.timeSec;
                    logger('info', 'AutoMix', `Next track BPM locked in preload: ${this._detectedNextBpm} (confidence ${(this._nextBeatState.confidence * 100).toFixed(0)}%)`);
                }
            }
        }
        if (!this._nextBpmDetected &&
            this._nextOnsetBuffer.length >= Math.round(6000 / this._nextOnsetChunkMs)) {
            const onsetsPerSec = 1000 / this._nextOnsetChunkMs;
            this._detectedNextBpm = estimateBpmFromOnsets(this._nextOnsetBuffer, onsetsPerSec);
            this._nextBpmDetected = true;
            if (this._detectedNextBpm) {
                logger('info', 'AutoMix', `Next track BPM detected from preload audio: ${this._detectedNextBpm}`);
            }
        }
        if (!this._nextKeyDetected && this._nextKeyPcmBytes < this._nextKeyMaxBytes) {
            this._nextKeyPcm.push(Buffer.from(chunk));
            this._nextKeyPcmBytes += chunk.length;
            if (this._nextKeyPcmBytes >= this.sampleRate * this.channels * 2 * 5) {
                const fullPcm = Buffer.concat(this._nextKeyPcm);
                this._detectedNextKey = estimateKeyFromPcm(fullPcm, this.sampleRate, this.channels);
                this._nextKeyDetected = true;
                this._nextKeyPcm = [];
                if (this._detectedNextKey) {
                    logger('info', 'AutoMix', `Next track key detected from preload audio: ${this._detectedNextKey.key} (${this._detectedNextKey.camelot}, confidence: ${(this._detectedNextKey.confidence * 100).toFixed(0)}%)`);
                }
            }
        }
    }
    /**
     * Update the smoothed RMS energy of the main stream (track A).
     * Called on every chunk flowing through _transform.
     */
    _updateEnergy(chunk) {
        const samples = chunk.length >> 1;
        if (samples === 0)
            return;
        let sumSq = 0;
        let count = 0;
        let sumBass = 0;
        let sumMid = 0;
        let sumTreble = 0;
        let sumFlux = 0;
        for (let i = 0; i < samples; i += 8) {
            const s = chunk.readInt16LE(i * 2);
            sumSq += s * s;
            this._mainSpecLowLp += this._mainSpecLowAlpha * (s - this._mainSpecLowLp);
            this._mainSpecMidLp += this._mainSpecMidAlpha * (s - this._mainSpecMidLp);
            this._mainSpecHighLp += this._mainSpecHighAlpha * (s - this._mainSpecHighLp);
            const bass = Math.abs(this._mainSpecLowLp);
            const midBand = Math.abs(this._mainSpecMidLp - this._mainSpecLowLp);
            const treble = Math.abs(s - this._mainSpecHighLp);
            sumBass += bass;
            sumMid += midBand;
            sumTreble += treble;
            const composite = midBand + treble * 1.15;
            sumFlux += Math.abs(composite - this._mainSpecPrevComposite);
            this._mainSpecPrevComposite = composite;
            count++;
        }
        if (count === 0)
            return;
        const rms = Math.sqrt(sumSq / count) / 32768; // normalized 0-1
        this._mainRmsEma = this._mainRmsEma * 0.85 + rms * 0.15; // Fast-responding EMA
        this._mainRmsPeak = Math.max(this._mainRmsPeak * 0.9985, rms); // Slowly decaying peak
        const toneTotal = sumBass + sumMid + sumTreble + 1;
        const brightness = Math.max(0, Math.min(1, (sumTreble * 1.10 + sumMid * 0.42) / toneTotal));
        const motion = Math.max(0, Math.min(1, (sumFlux / (sumMid + sumTreble + 1)) / 0.65));
        const centroidNorm = Math.max(0, Math.min(1, (sumBass * 140 + sumMid * 900 + sumTreble * 3200) / toneTotal / 3800));
        this._mainSpecBrightnessEma = this._mainSpecBrightnessEma * 0.92 + brightness * 0.08;
        this._mainSpecMotionEma = this._mainSpecMotionEma * 0.90 + motion * 0.10;
        this._mainSpecCentroidEma = this._mainSpecCentroidEma * 0.92 + centroidNorm * 0.08;
        const chunkMs = (chunk.length / 2 / this.channels / this.sampleRate) * 1000;
        if (chunkMs > 0)
            this._onsetChunkMs = chunkMs;
        const onset = Math.max(0, rms - this._prevRmsForOnset);
        this._prevRmsForOnset = rms;
        this._onsetBuffer.push(onset);
        if (chunkMs > 0) {
            this._rtBeatState = this._rtBeatTracker.push(onset, chunkMs / 1000);
            if (this._rtBeatState.locked &&
                this._rtBeatState.bpm > 0 &&
                (!this._detectedMainBpm ||
                    Math.abs(this._detectedMainBpm - this._rtBeatState.bpm) > 0.9)) {
                this._detectedMainBpm =
                    Math.round(this._rtBeatState.bpm * 10) / 10;
                const shouldLog = this._rtBeatState.timeSec - this._lastRealtimeBpmLogSec >= 8;
                if (shouldLog) {
                    this._lastRealtimeBpmLogSec = this._rtBeatState.timeSec;
                    logger('info', 'AutoMix', `Main track BPM locked in real-time: ${this._detectedMainBpm} (confidence ${(this._rtBeatState.confidence * 100).toFixed(0)}%)`);
                }
            }
        }
        if (!this._mainBpmDetected &&
            this._onsetBuffer.length >= Math.round(8000 / this._onsetChunkMs)) {
            const onsetsPerSec = 1000 / this._onsetChunkMs;
            this._detectedMainBpm = estimateBpmFromOnsets(this._onsetBuffer, onsetsPerSec);
            this._mainBpmDetected = true;
            if (this._detectedMainBpm) {
                logger('info', 'AutoMix', `Main track BPM detected from audio: ${this._detectedMainBpm}`);
            }
        }
        if (!this._mainKeyDetected &&
            this._mainKeyPcmBytes < this._mainKeyMaxBytes) {
            this._mainKeyPcm.push(Buffer.from(chunk));
            this._mainKeyPcmBytes += chunk.length;
            if (this._mainKeyPcmBytes >= this.sampleRate * this.channels * 2 * 5) {
                const fullPcm = Buffer.concat(this._mainKeyPcm);
                this._detectedMainKey = estimateKeyFromPcm(fullPcm, this.sampleRate, this.channels);
                this._mainKeyDetected = true;
                this._mainKeyPcm = []; // Free memory
                if (this._detectedMainKey) {
                    logger('info', 'AutoMix', `Main track key detected from audio: ${this._detectedMainKey.key} (${this._detectedMainKey.camelot}, confidence: ${(this._detectedMainKey.confidence * 100).toFixed(0)}%)`);
                }
            }
        }
    }
    /**
     * Returns the current smoothed energy of the main stream.
     * Used by the player for intelligent transition point detection.
     */
    getMainEnergy() {
        return { rms: this._mainRmsEma, peak: this._mainRmsPeak };
    }
    /**
     * Calculates the average RMS energy of Track B's opening seconds
     * from the ring buffer (non-destructive peek).
     * Returns 0 if ring buffer is not ready.
     */
    /**
     * Returns the BPM detected from the main stream's onset envelope,
     * or null if not enough data has been accumulated yet.
     */
    getMainTrackBpm() {
        if (this._rtBeatState.locked && this._rtBeatState.bpm > 0) {
            const live = Math.round(this._rtBeatState.bpm * 10) / 10;
            this._detectedMainBpm = live;
            this._mainBpmDetected = true;
            return live;
        }
        if (!this._mainBpmDetected &&
            this._onsetBuffer.length >= Math.round(4000 / this._onsetChunkMs)) {
            const onsetsPerSec = 1000 / this._onsetChunkMs;
            this._detectedMainBpm = estimateBpmFromOnsets(this._onsetBuffer, onsetsPerSec);
            this._mainBpmDetected = true;
            if (this._detectedMainBpm) {
                logger('info', 'AutoMix', `Main track BPM detected from audio (eager): ${this._detectedMainBpm}`);
            }
        }
        return this._detectedMainBpm;
    }
    getRealtimeBeatState() {
        return this._rtBeatState;
    }
    /**
     * Returns the musical key detected from the main stream's captured PCM,
     * or null if not enough audio has been accumulated yet.
     */
    getMainTrackKey() {
        if (!this._mainKeyDetected &&
            this._mainKeyPcmBytes >= this.sampleRate * this.channels * 2 * 3) {
            const fullPcm = Buffer.concat(this._mainKeyPcm);
            this._detectedMainKey = estimateKeyFromPcm(fullPcm, this.sampleRate, this.channels);
            this._mainKeyDetected = true;
            this._mainKeyPcm = []; // Free memory
            if (this._detectedMainKey) {
                logger('info', 'AutoMix', `Main track key detected from audio (eager): ${this._detectedMainKey.key} (${this._detectedMainKey.camelot})`);
            }
        }
        return this._detectedMainKey;
    }
    /**
     * Detects BPM from the buffered next track (Track B) ring buffer.
     * Non-destructive — peeks up to ~10 s of PCM data.
     * Returns null if the ring buffer is too small or detection fails.
     */
    getNextTrackBpm() {
        if (this._nextBeatState.locked && this._nextBeatState.bpm > 0) {
            const live = Math.round(this._nextBeatState.bpm * 10) / 10;
            this._detectedNextBpm = live;
            this._nextBpmDetected = true;
            return live;
        }
        if (!this._nextBpmDetected &&
            this._nextOnsetBuffer.length >= Math.round(4000 / this._nextOnsetChunkMs)) {
            const onsetsPerSec = 1000 / this._nextOnsetChunkMs;
            this._detectedNextBpm = estimateBpmFromOnsets(this._nextOnsetBuffer, onsetsPerSec);
            this._nextBpmDetected = true;
            if (this._detectedNextBpm) {
                logger('info', 'AutoMix', `Next track BPM detected from preload audio (eager): ${this._detectedNextBpm}`);
            }
        }
        if (this._detectedNextBpm)
            return this._detectedNextBpm;
        if (!this.ringBuffer ||
            this.ringBuffer.length < Math.round(3000 * this.bytesPerMs))
            return null;
        const maxBytes = Math.min(Math.round(10000 * this.bytesPerMs), this.ringBuffer.length);
        const peek = this.ringBuffer.peek(maxBytes);
        if (!peek || peek.length < 4)
            return null;
        const fallback = estimateBpmFromPcm(peek, this.sampleRate, this.channels);
        if (fallback) {
            this._detectedNextBpm = fallback;
            this._nextBpmDetected = true;
        }
        return fallback;
    }
    getNextTrackOpeningEnergy() {
        if (this._nextOpeningEnergyMs >= 500 && this._nextOpeningEnergy > 0) {
            return this._nextOpeningEnergy;
        }
        if (!this.ringBuffer || this.ringBuffer.length < 4)
            return 0;
        const maxBytes = Math.min(Math.round(3000 * this.bytesPerMs), this.ringBuffer.length);
        const peek = this.ringBuffer.peek(maxBytes);
        if (!peek || peek.length < 4)
            return 0;
        const samples = peek.length >> 1;
        let sumSq = 0;
        let count = 0;
        for (let i = 0; i < samples; i += 8) {
            const s = peek.readInt16LE(i * 2);
            sumSq += s * s;
            count++;
        }
        if (count === 0)
            return 0;
        return Math.sqrt(sumSq / count) / 32768;
    }
    getNextTrackBeatState() {
        return this._nextBeatState;
    }
    /**
     * Detects the musical key from the buffered next track (Track B) ring buffer.
     * Non-destructive — peeks up to ~10 s of PCM data.
     * Uses Goertzel-based chroma analysis + Krumhansl-Kessler key profiles.
     * Returns null if the ring buffer is too small or detection fails.
     */
    getNextTrackKey() {
        if (!this._nextKeyDetected &&
            this._nextKeyPcmBytes >= this.sampleRate * this.channels * 2 * 3) {
            const fullPcm = Buffer.concat(this._nextKeyPcm);
            this._detectedNextKey = estimateKeyFromPcm(fullPcm, this.sampleRate, this.channels);
            this._nextKeyDetected = true;
            this._nextKeyPcm = [];
            if (this._detectedNextKey) {
                logger('info', 'AutoMix', `Next track key detected from preload audio (eager): ${this._detectedNextKey.key} (${this._detectedNextKey.camelot})`);
            }
        }
        if (this._detectedNextKey)
            return this._detectedNextKey;
        if (!this.ringBuffer ||
            this.ringBuffer.length < Math.round(3000 * this.bytesPerMs))
            return null;
        const maxBytes = Math.min(Math.round(10000 * this.bytesPerMs), this.ringBuffer.length);
        const peek = this.ringBuffer.peek(maxBytes);
        if (!peek || peek.length < 4)
            return null;
        const fallback = estimateKeyFromPcm(peek, this.sampleRate, this.channels);
        if (fallback) {
            this._detectedNextKey = fallback;
            this._nextKeyDetected = true;
        }
        return fallback;
    }
    _transform(chunk, _encoding, callback) {
        let data = chunk;
        if (this.mainPending && this.mainPending.length > 0) {
            data = Buffer.concat([this.mainPending, chunk]);
            this.mainPending = null;
        }
        const remainder = data.length % 4;
        if (remainder > 0) {
            this.mainPending = Buffer.from(data.subarray(data.length - remainder));
            data = data.subarray(0, data.length - remainder);
        }
        if (!data.length || !this.crossfade || !this.ringBuffer) {
            if (data.length) {
                this._updateEnergy(data);
                this.push(data);
            }
            callback();
            return;
        }
        this._updateEnergy(data);
        const needed = data.length;
        this._drainSpillToRing();
        const totalBuffered = this.ringBuffer.length + this.nextSpillBytes;
        const resumeAt = this.crossfade?.isFinished
            ? Math.max(needed, Math.round(this.targetBufferBytes * 0.75))
            : needed;
        if (totalBuffered < resumeAt) {
            this._resumeNextStream();
        }
        const nextChunk = this.ringBuffer.read(needed);
        if (nextChunk) {
            if (!this.crossfade?.isFinished) {
                this._totalNextConsumedSamples += nextChunk.length / (this.channels * 2);
            }
        }
        if (!nextChunk) {
            const silence = Buffer.alloc(needed, 0);
            this.push(this._mixBuffers(data, silence, this.crossfade));
            callback();
            return;
        }
        let paddedNext = nextChunk;
        if (nextChunk.length !== data.length) {
            paddedNext = Buffer.allocUnsafe(data.length);
            paddedNext.fill(0);
            nextChunk.copy(paddedNext, 0, 0, nextChunk.length);
        }
        if (this.crossfade.isFinished) {
            if (!this._bypassTriggered) {
                this._bypassTriggered = true;
                this.filterBypassSetter?.(true);
                this.filterStateResetter?.();
            }
            const output = this.filterProcessor
                ? this.filterProcessor(paddedNext)
                : paddedNext;
            if (this._incomingGain !== 1) {
                const gain = this._incomingGain;
                const samps = output.length >> 1;
                for (let i = 0; i < samps; i++) {
                    const offset = i * 2;
                    const val = output.readInt16LE(offset) * gain;
                    output.writeInt16LE(this._toInt16Sample(val), offset);
                }
                this._incomingGain += (1.0 - this._incomingGain) * 0.25;
                if (Math.abs(this._incomingGain - 1.0) < 0.002) {
                    this._incomingGain = 1.0;
                }
            }
            this.push(output);
            callback();
            return;
        }
        const mixed = this._mixBuffers(data, paddedNext, this.crossfade);
        this.push(mixed);
        callback();
    }
    _flush(callback) {
        this._flushed = true;
        if (!this.crossfade && !this.ringBuffer) {
            this.clear();
            callback();
            return;
        }
        const FRAME_SIZE = 3840;
        const FRAME_MS = (FRAME_SIZE / 2 / this.channels / this.sampleRate) * 1000; // ~20 ms
        const INITIAL_BURST_MS = 200; // pre-fill 200 ms on entry
        const MAX_AHEAD_MS = 100; // stay max 100 ms ahead of wall clock
        const PUMP_CHECK_MS = 15; // check pace every 15 ms
        const MAX_PER_TICK = 15; // hard cap per tick to avoid event-loop stalls
        const STARVATION_TIMEOUT_MS = 5000; // end stream after 5 s of no data
        const ringLen = this.ringBuffer?.length ?? 0;
        const spillLen = this.nextSpillBytes;
        const streamAlive = this.nextStream &&
            !this.nextStream.destroyed &&
            !this.nextStream.readableEnded;
        logger('debug', 'Crossfade', `Bridge pump starting in _flush { ringMs: ${Math.round(ringLen / this.bytesPerMs)}, spillMs: ${Math.round(spillLen / this.bytesPerMs)}, streamAlive: ${!!streamAlive} }`);
        this._resumeNextStream();
        this._drainSpillToRing();
        const pump = () => {
            if (this._bridgePumpRunning)
                return;
            if (!this.crossfade) {
                const WAIT_LIMIT_MS = 15_000;
                const WAIT_POLL_MS = 50;
                const waitStart = Date.now();
                const waitForCrossfade = () => {
                    if (this.crossfade) {
                        pump();
                        return;
                    }
                    if (Date.now() - waitStart > WAIT_LIMIT_MS) {
                        logger('warn', 'Crossfade', 'Bridge pump: crossfade never initialized within wait window; ending stream');
                        callback();
                        return;
                    }
                    setTimeout(waitForCrossfade, WAIT_POLL_MS);
                };
                logger('debug', 'Crossfade', 'Bridge pump: waiting for crossfade initialization (source ended during pre-lead)');
                waitForCrossfade();
                return;
            }
            this._bridgePumpRunning = true;
            this._pumpTotalPausedMs = 0;
            this._pumpPausedAt = 0;
            let starvationStart = null;
            let bridgeSilenceStart = null;
            const pumpStartTime = Date.now();
            let totalPushedMs = 0;
            let filteredBCarry = Buffer.alloc(0);
            const step = () => {
                if (!this.crossfade) {
                    this._bridgePumpRunning = false;
                    callback();
                    return;
                }
                if (this._pumpPaused) {
                    setTimeout(step, 50);
                    return;
                }
                this._drainSpillToRing();
                this._resumeNextStream();
                if (this._bcfRing) {
                    this._bcfDrainSpill();
                    this._bcfResumeStream();
                }
                const wallElapsed = Date.now() - pumpStartTime - this._pumpTotalPausedMs;
                const budgetMs = totalPushedMs === 0 ? INITIAL_BURST_MS : wallElapsed + MAX_AHEAD_MS;
                let pushed = 0;
                while (totalPushedMs < budgetMs && pushed < MAX_PER_TICK) {
                    if (!this.ringBuffer)
                        break;
                    let nextChunk = this.ringBuffer.read(FRAME_SIZE);
                    if (nextChunk) {
                        starvationStart = null;
                        if (this._bridgeCrossfadeActive &&
                            !this._bcfRuntime &&
                            !this._bcfCountFrozen) {
                            this._bcfConsumedSamples += nextChunk.length / (this.channels * 2);
                        }
                    }
                    const streamDead = !this.nextStream ||
                        this.nextStream.destroyed ||
                        this.nextStream.readableEnded === true;
                    if (!nextChunk && !streamDead) {
                        if (!starvationStart) {
                            starvationStart = Date.now();
                        }
                        else if (Date.now() - starvationStart > STARVATION_TIMEOUT_MS) {
                            if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                                logger('warn', 'Crossfade', `Bridge starvation timeout during B→C blend — forcing swap to Track C`);
                                this._bcfRuntime.isFinished = true;
                                this._swapBridgeCrossfade();
                                starvationStart = null;
                                setTimeout(step, 5);
                                return;
                            }
                            logger('warn', 'Crossfade', `Audio bridge starvation timeout (${STARVATION_TIMEOUT_MS} ms); ending stream`);
                            this._bridgePumpRunning = false;
                            const bridgeDoneCb = this.onBridgeDrained;
                            this.clear();
                            bridgeDoneCb?.();
                            callback();
                            return;
                        }
                        break;
                    }
                    if (!nextChunk && streamDead) {
                        if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                            logger('info', 'Crossfade', 'Track B exhausted during bridge crossfade — force-completing blend to Track C');
                            const RESCUE_SILENCE = Buffer.alloc(FRAME_SIZE, 0); // silence for Track B
                            let rescuedFrames = 0;
                            const MAX_RESCUE = 2000; // safety cap (~40 s)
                            while (!this._bcfRuntime.isFinished &&
                                rescuedFrames < MAX_RESCUE) {
                                this._bcfDrainSpill();
                                this._bcfResumeStream();
                                const cChunk = this._bcfRing?.read(FRAME_SIZE);
                                if (!cChunk)
                                    break; // Track C also exhausted — give up
                                this._bcfConsumedSamples += cChunk.length / (this.channels * 2);
                                const bcfRT = this._bcfRuntime;
                                const framesInChunk = FRAME_SIZE / 2 / this.channels;
                                const fadeRemain = Math.max(0, bcfRT.durationFrames - bcfRT.elapsedFrames);
                                const fadeF = Math.min(framesInChunk, fadeRemain);
                                const mixed = Buffer.allocUnsafe(FRAME_SIZE);
                                for (let f = 0; f < framesInChunk; f++) {
                                    const progress = f < fadeF
                                        ? (bcfRT.elapsedFrames + f) / bcfRT.durationFrames
                                        : 1;
                                    const [, gainIn] = this._fadeGains(Math.min(1, progress), bcfRT.curve);
                                    const base = f * this.channels;
                                    let cL = cChunk.readInt16LE(base * 2);
                                    let cR = this.channels > 1 ? cChunk.readInt16LE((base + 1) * 2) : cL;
                                    if (this._hpEnabled && progress < 1) {
                                        const hpP = Math.min(1, progress / 0.3);
                                        const hpAlpha = this._hpPeakAlpha *
                                            (1 - (1 - Math.cos(hpP * Math.PI)) / 2);
                                        if (hpAlpha > 0.001) {
                                            this._bcfHpPrevL += hpAlpha * (cL - this._bcfHpPrevL);
                                            cL -= this._bcfHpPrevL;
                                            this._bcfHpPrevR += hpAlpha * (cR - this._bcfHpPrevR);
                                            cR -= this._bcfHpPrevR;
                                        }
                                    }
                                    if (this._lpEnabled && progress < this._lpCompletionRatio) {
                                        const lpP = Math.min(1, progress / this._lpCompletionRatio);
                                        const lpProgress = (1 - Math.cos(lpP * Math.PI)) / 2;
                                        const lpAlpha = this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress;
                                        this._bcfLpPrevL += lpAlpha * (cL - this._bcfLpPrevL);
                                        cL = Math.round(this._bcfLpPrevL);
                                        this._bcfLpPrevR += lpAlpha * (cR - this._bcfLpPrevR);
                                        cR = Math.round(this._bcfLpPrevR);
                                    }
                                    if (this._echoEnabled &&
                                        this._bcfEchoDelayL &&
                                        this._bcfEchoDelayR) {
                                        const delayLen = this._echoDelayFrames;
                                        const readPos = (((this._bcfEchoWritePos - delayLen) % delayLen) +
                                            delayLen) %
                                            delayLen;
                                        const delayedL = this._bcfEchoDelayL[readPos];
                                        const delayedR = this._bcfEchoDelayR[readPos];
                                        const rfbL = cL + delayedL * this._echoFeedback;
                                        const rfbR = cR + delayedR * this._echoFeedback;
                                        this._bcfEchoDelayL[this._bcfEchoWritePos] =
                                            rfbL > 65534 ? 65534 : rfbL < -65534 ? -65534 : rfbL;
                                        this._bcfEchoDelayR[this._bcfEchoWritePos] =
                                            rfbR > 65534 ? 65534 : rfbR < -65534 ? -65534 : rfbR;
                                        this._bcfEchoWritePos =
                                            (this._bcfEchoWritePos + 1) % delayLen;
                                        if (progress < this._echoCompletionRatio) {
                                            const echoT = progress / this._echoCompletionRatio;
                                            const echoWet = this._echoPeakMix * (1 - echoT);
                                            const echoDry = 1 - echoWet;
                                            cL = cL * echoDry + delayedL * echoWet;
                                            cR = cR * echoDry + delayedR * echoWet;
                                        }
                                    }
                                    cL = this._softClipSample(cL);
                                    cR = this._softClipSample(cR);
                                    const [adjOut, adjIn] = this._computeCoherenceGains(0, gainIn, progress);
                                    const mixL = cL * adjIn;
                                    const mixR = cR * adjIn;
                                    mixed.writeInt16LE(this._toInt16Sample(mixL), base * 2);
                                    if (this.channels > 1) {
                                        mixed.writeInt16LE(this._toInt16Sample(mixR), (base + 1) * 2);
                                    }
                                }
                                bcfRT.elapsedFrames += fadeF;
                                if (bcfRT.elapsedFrames >= bcfRT.durationFrames) {
                                    bcfRT.isFinished = true;
                                }
                                this.push(mixed);
                                totalPushedMs += FRAME_MS;
                                rescuedFrames++;
                            }
                            if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                                this._bcfRuntime.isFinished = true;
                            }
                            logger('info', 'Crossfade', `Bridge crossfade rescue complete — swapping to Track C (${rescuedFrames} frames rescued)`);
                            this._swapBridgeCrossfade();
                            starvationStart = null;
                            setTimeout(step, 5);
                            return;
                        }
                        const MAX_BRIDGE_SILENCE_MS = 90_000; // max 90 s of silence
                        const bcfHasData = this._bcfRing && this._bcfRing.length >= FRAME_SIZE;
                        if (bcfHasData && (this._bcfRuntime || this._bcfReady)) {
                            if (bridgeSilenceStart) {
                                const silenceElapsed = Date.now() - bridgeSilenceStart;
                                logger('info', 'Crossfade', `Bridge crossfade ready after ${Math.round(silenceElapsed)}ms of silence — resuming blend`);
                                bridgeSilenceStart = null;
                            }
                            starvationStart = null;
                            nextChunk = Buffer.alloc(FRAME_SIZE, 0);
                        }
                        else {
                            if (!bridgeSilenceStart) {
                                bridgeSilenceStart = Date.now();
                                logger('warn', 'Crossfade', 'Bridge pump starving (ring empty, stream dead) — pushing silence while awaiting crossfade trigger');
                                this.onBridgeStarving?.();
                            }
                            const silenceElapsed = Date.now() - bridgeSilenceStart;
                            if (silenceElapsed > MAX_BRIDGE_SILENCE_MS) {
                                logger('warn', 'Crossfade', `Bridge silence timeout (${Math.round(silenceElapsed)}ms) — ending stream`);
                                this._bridgePumpRunning = false;
                                const bridgeDoneCb = this.onBridgeDrained;
                                this.clear();
                                bridgeDoneCb?.();
                                callback();
                                return;
                            }
                            const silence = Buffer.alloc(FRAME_SIZE, 0);
                            this.push(silence);
                            totalPushedMs += FRAME_MS;
                            pushed++;
                            setTimeout(step, 5);
                            return;
                        }
                    }
                    if (!nextChunk)
                        break;
                    let outBuf = nextChunk;
                    if (this._bcfRuntime && !this._bcfRuntime.isFinished) {
                        this._bcfDrainSpill();
                        this._bcfResumeStream();
                        const trackCChunk = this._bcfRing?.read(FRAME_SIZE);
                        if (trackCChunk) {
                            this._bcfConsumedSamples +=
                                trackCChunk.length / (this.channels * 2);
                            const rawFiltered = this.filterProcessor
                                ? this.filterProcessor(outBuf)
                                : outBuf;
                            let filteredB = filteredBCarry.length > 0
                                ? Buffer.concat([filteredBCarry, rawFiltered])
                                : rawFiltered;
                            if (filteredB.length > FRAME_SIZE) {
                                filteredBCarry = Buffer.from(filteredB.subarray(FRAME_SIZE));
                                filteredB = filteredB.subarray(0, FRAME_SIZE);
                            }
                            else {
                                filteredBCarry = Buffer.alloc(0);
                                if (filteredB.length < FRAME_SIZE) {
                                    const padded = Buffer.allocUnsafe(FRAME_SIZE);
                                    padded.fill(0);
                                    filteredB.copy(padded, 0, 0, filteredB.length);
                                    filteredB = padded;
                                }
                            }
                            let paddedC = trackCChunk;
                            if (paddedC.length < FRAME_SIZE) {
                                const padded = Buffer.allocUnsafe(FRAME_SIZE);
                                padded.fill(0);
                                paddedC.copy(padded, 0, 0, paddedC.length);
                                paddedC = padded;
                            }
                            const totalFrames = FRAME_SIZE / 2 / this.channels;
                            const bcfRT = this._bcfRuntime;
                            const fadeFrames = Math.min(totalFrames, Math.max(0, bcfRT.durationFrames - bcfRT.elapsedFrames));
                            const mixed = Buffer.allocUnsafe(FRAME_SIZE);
                            const mainView = new Int16Array(filteredB.buffer, filteredB.byteOffset, FRAME_SIZE / 2);
                            const nextView = new Int16Array(paddedC.buffer, paddedC.byteOffset, FRAME_SIZE / 2);
                            const lag = (bcfRT.elapsedFrames === 0)
                                ? this._calculateOptimalLag(mainView, nextView, 128)
                                : 0;
                            for (let f = 0; f < totalFrames; f++) {
                                const progress = f < fadeFrames
                                    ? (bcfRT.elapsedFrames + f) / bcfRT.durationFrames
                                    : 1;
                                const [gainOut, gainIn] = this._fadeGains(Math.min(1, progress), bcfRT.curve);
                                const base = f * this.channels;
                                const nextBase = base + (lag * this.channels);
                                const safeNextBase = Math.max(0, Math.min(nextBase, (FRAME_SIZE / 2) - this.channels));
                                let cL = paddedC.readInt16LE(safeNextBase * 2);
                                let cR = this.channels > 1 ? paddedC.readInt16LE((safeNextBase + 1) * 2) : cL;
                                if (this._hpEnabled && progress < 1) {
                                    const hpP = Math.min(1, progress / 0.3);
                                    const hpAlpha = this._hpPeakAlpha * (1 - (1 - Math.cos(hpP * Math.PI)) / 2);
                                    if (hpAlpha > 0.001) {
                                        this._bcfHpPrevL += hpAlpha * (cL - this._bcfHpPrevL);
                                        cL -= this._bcfHpPrevL;
                                        this._bcfHpPrevR += hpAlpha * (cR - this._bcfHpPrevR);
                                        cR -= this._bcfHpPrevR;
                                    }
                                    else {
                                        this._bcfHpPrevL = 0;
                                        this._bcfHpPrevR = 0;
                                    }
                                }
                                if (this._lpEnabled && progress < this._lpCompletionRatio) {
                                    const lpP = Math.min(1, progress / this._lpCompletionRatio);
                                    const lpProgress = (1 - Math.cos(lpP * Math.PI)) / 2;
                                    const lpAlpha = this._lpPeakAlpha + (1.0 - this._lpPeakAlpha) * lpProgress;
                                    this._bcfLpPrevL += lpAlpha * (cL - this._bcfLpPrevL);
                                    cL = Math.round(this._bcfLpPrevL);
                                    this._bcfLpPrevR += lpAlpha * (cR - this._bcfLpPrevR);
                                    cR = Math.round(this._bcfLpPrevR);
                                }
                                if (this._echoEnabled &&
                                    this._bcfEchoDelayL &&
                                    this._bcfEchoDelayR) {
                                    const delayLen = this._echoDelayFrames;
                                    const readPos = (((this._bcfEchoWritePos - delayLen) % delayLen) +
                                        delayLen) %
                                        delayLen;
                                    const delayedL = this._bcfEchoDelayL[readPos];
                                    const delayedR = this._bcfEchoDelayR[readPos];
                                    const bfbL2 = cL + delayedL * this._echoFeedback;
                                    const bfbR2 = cR + delayedR * this._echoFeedback;
                                    this._bcfEchoDelayL[this._bcfEchoWritePos] =
                                        bfbL2 > 65534 ? 65534 : bfbL2 < -65534 ? -65534 : bfbL2;
                                    this._bcfEchoDelayR[this._bcfEchoWritePos] =
                                        bfbR2 > 65534 ? 65534 : bfbR2 < -65534 ? -65534 : bfbR2;
                                    this._bcfEchoWritePos = (this._bcfEchoWritePos + 1) % delayLen;
                                    if (progress < this._echoCompletionRatio) {
                                        const echoT = progress / this._echoCompletionRatio;
                                        const echoWet = this._echoPeakMix * (1 - echoT);
                                        const echoDry = 1 - echoWet;
                                        cL = cL * echoDry + delayedL * echoWet;
                                        cR = cR * echoDry + delayedR * echoWet;
                                    }
                                }
                                cL = this._softClipSample(cL);
                                cR = this._softClipSample(cR);
                                if (this._panEnabled && progress < this._panCompletionRatio) {
                                    const panT = progress / this._panCompletionRatio;
                                    const panL = (1 - Math.cos(panT * Math.PI)) / 2;
                                    cL *= panL;
                                }
                                const bL = filteredB.readInt16LE(base * 2);
                                const bR = this.channels > 1 ? filteredB.readInt16LE((base + 1) * 2) : bL;
                                const [adjOut, adjIn] = this._computeCoherenceGains(gainOut, gainIn, progress);
                                const mixL = bL * adjOut + cL * adjIn;
                                const mixR = bR * adjOut + cR * adjIn;
                                const clL = this._toInt16Sample(mixL);
                                const clR = this._toInt16Sample(mixR);
                                mixed.writeInt16LE(clL, base * 2);
                                if (this.channels > 1) {
                                    mixed.writeInt16LE(clR, (base + 1) * 2);
                                }
                            }
                            bcfRT.elapsedFrames += fadeFrames;
                            if (bcfRT.elapsedFrames >= bcfRT.durationFrames) {
                                bcfRT.isFinished = true;
                                logger('info', 'Crossfade', 'Bridge crossfade: blend complete — swapping to Track C');
                                this._swapBridgeCrossfade();
                                starvationStart = null;
                            }
                            const canPush = this.push(mixed);
                            totalPushedMs += FRAME_MS;
                            pushed++;
                            if (!canPush)
                                break;
                            continue;
                        }
                    }
                    if (this._incomingGain !== 1) {
                        const gain = this._incomingGain;
                        const samps = outBuf.length >> 1;
                        for (let s = 0; s < samps; s++) {
                            const offset = s * 2;
                            const val = outBuf.readInt16LE(offset) * gain;
                            outBuf.writeInt16LE(val < -32768 ? -32768 : val > 32767 ? 32767 : (val + 0.5) | 0, offset);
                        }
                        this._incomingGain += (1.0 - this._incomingGain) * 0.25;
                        if (Math.abs(this._incomingGain - 1.0) < 0.002) {
                            this._incomingGain = 1.0;
                        }
                    }
                    if (outBuf.length < FRAME_SIZE) {
                        const padded = Buffer.allocUnsafe(FRAME_SIZE);
                        padded.fill(0);
                        outBuf.copy(padded, 0, 0, outBuf.length);
                        outBuf = padded;
                    }
                    if (this.crossfade &&
                        !this.crossfade.isFinished &&
                        !this._bcfRuntime) {
                        const framesInChunk = FRAME_SIZE / 2 / this.channels;
                        this.crossfade.elapsedFrames += framesInChunk;
                        if (this.crossfade.elapsedFrames >= this.crossfade.durationFrames) {
                            this.crossfade.isFinished = true;
                        }
                    }
                    if (this.filterProcessor) {
                        outBuf = this.filterProcessor(outBuf);
                    }
                    const actualMs = (outBuf.length / 2 / this.channels / this.sampleRate) * 1000;
                    const canPush = this.push(outBuf);
                    totalPushedMs += actualMs;
                    pushed++;
                    if (!canPush)
                        break;
                }
                setTimeout(step, pushed > 0 ? PUMP_CHECK_MS : 5);
            };
            step();
        };
        pump();
    }
}
