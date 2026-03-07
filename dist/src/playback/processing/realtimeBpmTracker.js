const DEFAULTS = {
    minBpm: 70,
    maxBpm: 195,
    minIntervalSec: 0.24,
    maxIntervalSec: 1.25,
    refractorySec: 0.18,
    thresholdSigma: 2.4,
    noiseFloor: 0.0015,
    lockThreshold: 0.52,
    maxIntervals: 12
};
const HARMONIC_CANDIDATES = [
    { multiplier: 1, weight: 1.0 },
    { multiplier: 2, weight: 0.62 },
    { multiplier: 0.5, weight: 0.62 },
    { multiplier: 1.5, weight: 0.45 },
    { multiplier: 2 / 3, weight: 0.45 }
];
/**
 * Clean-room real-time beat/BPM tracker.
 *
 * Notes:
 * - Works from onset envelope samples (not raw PCM).
 * - Detects beats from onset flux (fast-vs-slow envelope) with adaptive threshold.
 * - Uses interval voting with harmonic candidates to reduce octave mistakes.
 * - Applies robust confidence (consistency + candidate separation + sample size).
 * - Maintains phase anchor so beat phase stays stable between events.
 */
export class RealtimeBpmTracker {
    opts;
    timeSec = 0;
    fastEnv = 0;
    slowEnv = 0;
    fluxMean = 0;
    fluxDev = 0;
    prevFlux = 0;
    beatStrength = 0;
    lastBeatSec = Number.NEGATIVE_INFINITY;
    intervalsSec = [];
    bpm = 0;
    confidence = 0;
    phase = 0;
    phaseAnchorSec = Number.NEGATIVE_INFINITY;
    phasePeriodSec = 0;
    constructor(options = {}) {
        this.opts = { ...DEFAULTS, ...options };
    }
    reset() {
        this.timeSec = 0;
        this.fastEnv = 0;
        this.slowEnv = 0;
        this.fluxMean = 0;
        this.fluxDev = 0;
        this.prevFlux = 0;
        this.beatStrength = 0;
        this.lastBeatSec = Number.NEGATIVE_INFINITY;
        this.intervalsSec = [];
        this.bpm = 0;
        this.confidence = 0;
        this.phase = 0;
        this.phaseAnchorSec = Number.NEGATIVE_INFINITY;
        this.phasePeriodSec = 0;
    }
    getState() {
        const lastBeatAgeSec = Number.isFinite(this.lastBeatSec)
            ? Math.max(0, this.timeSec - this.lastBeatSec)
            : Number.POSITIVE_INFINITY;
        const locked = this._isLocked();
        return {
            timeSec: this.timeSec,
            bpm: this.bpm,
            confidence: this.confidence,
            phase: this.phase,
            locked,
            lastBeatAgeSec
        };
    }
    push(onset, deltaSec) {
        if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
            return this.getState();
        }
        const cleanOnset = Number.isFinite(onset) && onset > 0 ? onset : 0;
        this.timeSec += deltaSec;
        // Onset flux extraction: fast envelope minus slow envelope.
        const compressed = Math.sqrt(cleanOnset);
        this.fastEnv = this.fastEnv * 0.82 + compressed * 0.18;
        this.slowEnv = this.slowEnv * 0.968 + compressed * 0.032;
        const flux = Math.max(0, this.fastEnv - this.slowEnv);
        // Adaptive noise model for flux thresholding.
        this.fluxMean = this.fluxMean * 0.986 + flux * 0.014;
        const fluxDistance = Math.abs(flux - this.fluxMean);
        this.fluxDev = this.fluxDev * 0.986 + fluxDistance * 0.014;
        const threshold = this.fluxMean + this.fluxDev * this.opts.thresholdSigma + this.opts.noiseFloor;
        const beatGap = this.timeSec - this.lastBeatSec;
        const rising = flux > this.prevFlux * 1.015;
        const refractory = this._adaptiveRefractorySec();
        const strength = this.fluxDev > 1e-7 ? (flux - threshold) / this.fluxDev : 0;
        const beatDetected = flux > threshold &&
            rising &&
            beatGap >= refractory &&
            strength > 0;
        // When locked, reject implausibly early hits unless very strong.
        if (beatDetected &&
            this._isLocked() &&
            this.phasePeriodSec > 0 &&
            beatGap < this.phasePeriodSec * 0.43 &&
            strength < 1.8) {
            this.prevFlux = flux;
            this._updatePhase();
            return this.getState();
        }
        if (beatDetected) {
            this._ingestBeat(this.timeSec, strength);
        }
        this.prevFlux = flux;
        this._updatePhase();
        return this.getState();
    }
    _ingestBeat(beatTimeSec, strength) {
        const clampedStrength = RealtimeBpmTracker._clamp(strength, 0, 5);
        this.beatStrength = this.beatStrength * 0.86 + clampedStrength * 0.14;
        if (Number.isFinite(this.lastBeatSec)) {
            const rawInterval = beatTimeSec - this.lastBeatSec;
            const interval = this._normalizeInterval(rawInterval);
            if (interval >= this.opts.minIntervalSec &&
                interval <= this.opts.maxIntervalSec) {
                this.intervalsSec.push(interval);
                if (this.intervalsSec.length > this.opts.maxIntervals) {
                    this.intervalsSec.shift();
                }
                const estimate = this._estimateTempoFromIntervals();
                if (estimate.tempo > 0) {
                    if (this.bpm <= 0) {
                        this.bpm = estimate.tempo;
                    }
                    else {
                        const alpha = 0.08 + this.confidence * 0.24;
                        this.bpm = this.bpm + (estimate.tempo - this.bpm) * alpha;
                    }
                    this.phasePeriodSec = 60 / this.bpm;
                }
                const consistency = estimate.consistency;
                const separation = estimate.separation;
                const sampleFactor = Math.min(1, this.intervalsSec.length / 8);
                const strengthFactor = RealtimeBpmTracker._clamp(this.beatStrength / 2.6, 0, 1);
                const rawConfidence = RealtimeBpmTracker._clamp(consistency * 0.48 + separation * 0.26 + sampleFactor * 0.16 + strengthFactor * 0.1, 0, 1);
                this.confidence = this.confidence * 0.80 + rawConfidence * 0.20;
                this._updatePhaseAnchor(beatTimeSec);
            }
        }
        if (!Number.isFinite(this.phaseAnchorSec)) {
            this.phaseAnchorSec = beatTimeSec;
        }
        this.lastBeatSec = beatTimeSec;
    }
    _updatePhase() {
        if (!(this.bpm > 0) || !(this.phasePeriodSec > 0)) {
            this.phase = 0;
            return;
        }
        const anchor = Number.isFinite(this.phaseAnchorSec)
            ? this.phaseAnchorSec
            : this.lastBeatSec;
        if (!Number.isFinite(anchor)) {
            this.phase = 0;
            return;
        }
        const cycles = (this.timeSec - anchor) / this.phasePeriodSec;
        const frac = cycles - Math.floor(cycles);
        this.phase = frac < 0 ? frac + 1 : frac;
    }
    _normalizeTempo(bpm) {
        if (!Number.isFinite(bpm) || bpm <= 0)
            return 0;
        let v = bpm;
        while (v < this.opts.minBpm)
            v *= 2;
        while (v > this.opts.maxBpm)
            v /= 2;
        return Math.round(v * 10) / 10;
    }
    _isLocked() {
        return (this.bpm > 0 &&
            this.confidence >= this.opts.lockThreshold &&
            this.intervalsSec.length >= 3);
    }
    _adaptiveRefractorySec() {
        if (!(this.bpm > 0)) {
            return this.opts.refractorySec;
        }
        const period = 60 / this.bpm;
        return RealtimeBpmTracker._clamp(period * 0.42, 0.11, this.opts.refractorySec);
    }
    _normalizeInterval(intervalSec) {
        if (!(intervalSec > 0))
            return 0;
        let v = intervalSec;
        if (this.phasePeriodSec > 0) {
            const target = this.phasePeriodSec;
            while (v > target * 1.75)
                v /= 2;
            while (v < target * 0.55)
                v *= 2;
        }
        return v;
    }
    _estimateTempoFromIntervals() {
        if (this.intervalsSec.length === 0) {
            return { tempo: 0, consistency: 0, separation: 0 };
        }
        const bins = new Map();
        const currentTempo = this.bpm > 0 ? this.bpm : null;
        const n = this.intervalsSec.length;
        for (let i = 0; i < n; i++) {
            const interval = this.intervalsSec[i];
            const recency = 0.52 + ((i + 1) / n) * 0.48;
            for (const candidate of HARMONIC_CANDIDATES) {
                const rawTempo = 60 / interval * candidate.multiplier;
                const tempo = this._normalizeTempo(rawTempo);
                if (!(tempo > 0))
                    continue;
                const bin = Math.round(tempo * 2) / 2;
                let score = recency * candidate.weight;
                if (currentTempo) {
                    const distance = Math.abs(bin - currentTempo);
                    const closeness = 1 / (1 + distance / 9);
                    score *= 0.55 + closeness * 0.45;
                }
                const prev = bins.get(bin) ?? 0;
                bins.set(bin, prev + score);
            }
        }
        let bestTempo = 0;
        let bestScore = 0;
        let secondScore = 0;
        for (const entry of bins.entries()) {
            const tempo = entry[0];
            const score = entry[1];
            if (score > bestScore) {
                secondScore = bestScore;
                bestScore = score;
                bestTempo = tempo;
            }
            else if (score > secondScore) {
                secondScore = score;
            }
        }
        const consistency = this._intervalConsistency();
        const separation = bestScore > 1e-7
            ? RealtimeBpmTracker._clamp((bestScore - secondScore) / bestScore, 0, 1)
            : 0;
        return {
            tempo: bestTempo,
            consistency,
            separation
        };
    }
    _updatePhaseAnchor(beatTimeSec) {
        if (!(this.phasePeriodSec > 0)) {
            this.phaseAnchorSec = beatTimeSec;
            return;
        }
        if (!Number.isFinite(this.phaseAnchorSec)) {
            this.phaseAnchorSec = beatTimeSec;
            return;
        }
        const k = Math.round((beatTimeSec - this.phaseAnchorSec) / this.phasePeriodSec);
        const predicted = this.phaseAnchorSec + k * this.phasePeriodSec;
        const error = beatTimeSec - predicted;
        // Tighten the error window: only allow correction if within 25% of period.
        const boundedError = RealtimeBpmTracker._clamp(error, -this.phasePeriodSec * 0.25, this.phasePeriodSec * 0.25);
        // Adaptive proportional-integral correction for the anchor.
        // Higher confidence allows faster convergence.
        const pGain = 0.28 + this.confidence * 0.42;
        const iGain = 0.04 + this.confidence * 0.08;
        this.phaseAnchorSec += (boundedError * pGain) + (this.fluxMean * boundedError * iGain);
        // Safety: ensure anchor doesn't drift too far from the current window.
        if (Math.abs(this.timeSec - this.phaseAnchorSec) > this.phasePeriodSec * 16) {
            this.phaseAnchorSec = beatTimeSec;
        }
    }
    _intervalConsistency() {
        const n = this.intervalsSec.length;
        if (n === 0)
            return 0;
        if (n === 1)
            return 0.30;
        if (n === 2)
            return 0.45;
        const median = RealtimeBpmTracker._median(this.intervalsSec);
        if (!(median > 0))
            return 0;
        const absDevs = this.intervalsSec.map(v => Math.abs(v - median));
        const mad = RealtimeBpmTracker._median(absDevs);
        const relMad = mad / median;
        return RealtimeBpmTracker._clamp(1 - relMad / 0.18, 0, 1);
    }
    static _median(values) {
        if (values.length === 0)
            return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const half = sorted.length >> 1;
        if (sorted.length % 2 === 0) {
            return ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) * 0.5;
        }
        return sorted[half] ?? 0;
    }
    static _clamp(value, min, max) {
        if (value < min)
            return min;
        if (value > max)
            return max;
        return value;
    }
}
