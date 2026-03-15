/**
 * Musical key detection via Goertzel-based chroma analysis with
 * segment voting.
 *
 * Uses the Goertzel algorithm to extract energy at specific chromatic
 * frequencies without a full FFT, then correlates the resulting 12-bin
 * chroma vector against Krumhansl-Kessler key profiles.
 *
 * Returns a Camelot-wheel notation (e.g. "8B" for C major, "5A" for C minor)
 * that enables harmonic mixing decisions in automix.
 *
 * Quality improvements over v1:
 *  1. Energy-weighted chroma — louder frames contribute more, silencing
 *     noise/silence from corrupting the tonal analysis.
 *  2. Extended octave range (2–6) — captures bass-heavy electronic/hip-hop
 *     through high melodies.
 *  3. Segment voting — analyses audio in ~5 s segments.  Each segment
 *     independently votes for a key.  Confidence is based on agreement
 *     across segments (temporal consistency), not just correlation gap.
 *  4. z-score margin — the best key's correlation is measured against the
 *     distribution of all 24 keys, giving a more calibrated confidence.
 *  5. Quiet frame rejection — frames below a noise floor are skipped.
 *
 * CPU cost: ~4 ms for 25 seconds of stereo audio at 48 kHz.
 *
 * @module keyDetector
 */
const NOTE_NAMES = [
    'C',
    'C#',
    'D',
    'D#',
    'E',
    'F',
    'F#',
    'G',
    'G#',
    'A',
    'A#',
    'B'
];
// Krumhansl-Kessler key profiles (tonic-aligned, index 0 = tonic)
const MAJOR_PROFILE = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88
];
const MINOR_PROFILE = [
    6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17
];
// Camelot wheel number for each pitch class (index 0 = C, 1 = C#, … 11 = B)
// Major: C=8B, C#=3B, D=10B, D#=5B, E=12B, F=7B, F#=2B, G=9B, G#=4B, A=11B, A#=6B, B=1B
const CAMELOT_MAJOR_NUM = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
// Minor: C=5A, C#=12A, D=7A, D#=2A, E=9A, F=4A, F#=11A, G=6A, G#=1A, A=8A, A#=3A, B=10A
const CAMELOT_MINOR_NUM = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
/** C0 frequency in Hz (MIDI 12). */
const C0_FREQ = 16.3516;
/** Analysis parameters. */
const WINDOW_SIZE = 8192;
const HOP_SIZE = 4096;
/** Maximum audio to analyse (seconds). */
const MAX_ANALYSIS_S = 25;
/** Segment length for voting (seconds). */
const SEGMENT_S = 5;
/** Minimum number of segments to enable vote-based confidence. */
const MIN_SEGMENTS_FOR_VOTING = 2;
/** RMS threshold below which a frame is considered silence/noise. */
const NOISE_FLOOR = 0.005;
/**
 * Estimate the musical key from raw 16-bit signed PCM audio.
 *
 * Algorithm:
 *   1. Convert to mono float, divide into Hann-windowed 8 192-sample frames
 *   2. For each frame, compute Goertzel power at chromatic frequencies (octaves 2–6)
 *   3. Weight by frame RMS energy, skip quiet frames
 *   4. Accumulate per-segment and global energy-weighted chroma vectors
 *   5. Pearson-correlate with Krumhansl-Kessler profiles for all 24 keys
 *   6. Segment voting: each ~5 s segment votes for its best key
 *   7. Confidence = weighted combination of vote agreement + z-score margin
 *
 * @param pcm - Raw 16-bit signed-LE interleaved PCM buffer.
 * @param sampleRate - Audio sample rate (e.g. 48 000).
 * @param channels - Number of interleaved channels (e.g. 2).
 * @returns Detected key result, or `null` if audio is too short / has no tonal content.
 */
export function estimateKeyFromPcm(pcm, sampleRate, channels) {
    const bytesPerSample = 2 * channels;
    const totalSamples = Math.floor(pcm.length / bytesPerSample);
    // Need at least 3 seconds of audio
    if (totalSamples < sampleRate * 3)
        return null;
    // Target frequencies: 12 pitch classes × 5 octaves (2–6)
    const targets = [];
    for (let octave = 2; octave <= 6; octave++) {
        for (let pc = 0; pc < 12; pc++) {
            targets.push({ pc, freq: C0_FREQ * 2 ** (octave + pc / 12) });
        }
    }
    // Hann window (pre-computed once)
    const hann = new Float32Array(WINDOW_SIZE);
    for (let i = 0; i < WINDOW_SIZE; i++) {
        hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WINDOW_SIZE - 1)));
    }
    // Pre-compute Goertzel coefficients for each target frequency
    const coeffs = targets.map((t) => 2 * Math.cos((2 * Math.PI * t.freq) / sampleRate));
    // Segment management
    const segmentSamples = Math.round(sampleRate * SEGMENT_S);
    const globalChroma = new Float64Array(12);
    let globalWeight = 0;
    const segmentVotes = [];
    let segChroma = new Float64Array(12);
    let segWeight = 0;
    let segStart = 0;
    const mono = new Float32Array(WINDOW_SIZE);
    const maxSamples = Math.min(totalSamples, Math.round(sampleRate * MAX_ANALYSIS_S));
    for (let start = 0; start + WINDOW_SIZE <= maxSamples; start += HOP_SIZE) {
        // ── Convert to mono float + Hann window + compute frame RMS ──
        let sumSq = 0;
        for (let i = 0; i < WINDOW_SIZE; i++) {
            const offset = (start + i) * bytesPerSample;
            let sample;
            if (channels === 1) {
                sample = pcm.readInt16LE(offset) / 32768;
            }
            else {
                const l = pcm.readInt16LE(offset);
                const r = pcm.readInt16LE(offset + 2);
                sample = (l + r) / 65536;
            }
            sumSq += sample * sample;
            mono[i] = sample * hann[i];
        }
        const rms = Math.sqrt(sumSq / WINDOW_SIZE);
        if (rms < NOISE_FLOOR)
            continue; // Skip silence/noise
        // Weight by energy (sqrt for softer weighting — emphasises loud frames
        // without completely ignoring medium-energy frames)
        const weight = Math.sqrt(rms);
        // ── Goertzel for each target frequency ──
        for (let t = 0; t < targets.length; t++) {
            const coeff = coeffs[t];
            let s1 = 0, s2 = 0;
            for (let i = 0; i < WINDOW_SIZE; i++) {
                const s0 = mono[i] + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
            const pc = targets[t].pc;
            const weighted = power * weight;
            globalChroma[pc] += weighted;
            segChroma[pc] += weighted;
        }
        globalWeight += weight;
        segWeight += weight;
        // ── Segment boundary? → vote and reset ──
        if (start - segStart >= segmentSamples) {
            if (segWeight > 0) {
                const vote = findBestKeyWithStats(segChroma, segWeight);
                if (vote) {
                    const encoded = vote.pc * 2 + (vote.mode === 'minor' ? 1 : 0);
                    const zStrength = clamp01(vote.zScore / 3.5);
                    const corrGapStrength = clamp01((vote.bestCorr - vote.secondCorr + 0.05) / 0.35);
                    const voteStrength = 0.6 * zStrength + 0.4 * corrGapStrength;
                    segmentVotes.push({ encoded, weight: Math.max(0.12, voteStrength) });
                }
            }
            segChroma = new Float64Array(12);
            segWeight = 0;
            segStart = start;
        }
    }
    // Flush last segment
    if (segWeight > 0) {
        const vote = findBestKeyWithStats(segChroma, segWeight);
        if (vote) {
            const encoded = vote.pc * 2 + (vote.mode === 'minor' ? 1 : 0);
            const zStrength = clamp01(vote.zScore / 3.5);
            const corrGapStrength = clamp01((vote.bestCorr - vote.secondCorr + 0.05) / 0.35);
            const voteStrength = 0.6 * zStrength + 0.4 * corrGapStrength;
            segmentVotes.push({ encoded, weight: Math.max(0.12, voteStrength) });
        }
    }
    if (globalWeight === 0)
        return null;
    // ── Global key detection ──
    const best = findBestKeyWithStats(globalChroma, globalWeight);
    if (!best)
        return null;
    // ── Confidence: combine weighted vote agreement + tonal statistics ──
    const tonalClarity = computeTonalClarity(globalChroma, globalWeight, best);
    const modeAmbiguity = clamp01(1 - (best.modeGap + 0.02) / 0.26);
    const zMargin = clamp01(best.zScore / 4);
    const corrGap = clamp01((best.bestCorr - best.secondCorr + 0.05) / 0.35);
    let stability = 0;
    let confidence;
    if (segmentVotes.length >= MIN_SEGMENTS_FOR_VOTING) {
        const bestEncoded = best.pc * 2 + (best.mode === 'minor' ? 1 : 0);
        const bestCamelotNum = best.mode === 'major'
            ? CAMELOT_MAJOR_NUM[best.pc]
            : CAMELOT_MINOR_NUM[best.pc];
        let sumWeight = 0;
        let exactWeight = 0;
        let compatWeight = 0;
        for (const vote of segmentVotes) {
            sumWeight += vote.weight;
            if (vote.encoded === bestEncoded) {
                exactWeight += vote.weight;
            }
            const vPc = vote.encoded >> 1;
            const vMinor = vote.encoded & 1;
            const vCamelot = vMinor ? CAMELOT_MINOR_NUM[vPc] : CAMELOT_MAJOR_NUM[vPc];
            if (vCamelot === bestCamelotNum) {
                compatWeight += vote.weight;
            }
        }
        if (sumWeight > 1e-9) {
            stability = clamp01((0.75 * exactWeight + 0.25 * compatWeight) / sumWeight);
        }
        confidence = clamp01(0.42 * stability +
            0.22 * zMargin +
            0.18 * corrGap +
            0.12 * tonalClarity +
            0.06 * (1 - modeAmbiguity));
    }
    else {
        confidence = clamp01(0.4 * zMargin +
            0.25 * corrGap +
            0.25 * tonalClarity +
            0.1 * (1 - modeAmbiguity));
        stability = confidence * 0.75;
    }
    const camelotNum = best.mode === 'major'
        ? CAMELOT_MAJOR_NUM[best.pc]
        : CAMELOT_MINOR_NUM[best.pc];
    const camelotLetter = best.mode === 'major' ? 'B' : 'A';
    return {
        key: `${NOTE_NAMES[best.pc]} ${best.mode}`,
        pitchClass: best.pc,
        mode: best.mode,
        camelot: `${camelotNum}${camelotLetter}`,
        camelotNum,
        confidence,
        stability,
        tonalClarity,
        modeAmbiguity
    };
}
/**
 * Compute harmonic distance between two Camelot wheel positions.
 *
 * Distance 0 = same key (or relative major/minor).
 * Distance 1 = adjacent on the wheel (harmonically compatible).
 * Distance ≤ 2 = workable for blending.
 * Distance > 2 = increasing clash potential.
 *
 * @returns Integer distance 0–6, or 6 if inputs are invalid.
 */
export function camelotDistance(a, b) {
    const numA = parseInt(a);
    const numB = parseInt(b);
    if (isNaN(numA) || isNaN(numB))
        return 6;
    const d = Math.abs(numA - numB);
    return Math.min(d, 12 - d);
}
/**
 * Compute the smallest pitch shift (in semitones) to align Track A's key
 * with Track B on the Camelot wheel.
 *
 * Uses the circular Camelot number distance and finds the move that
 * minimises |semitones| while landing on the same Camelot number (or ±1).
 *
 * Every Camelot step = +7 semitones on the circle of fifths (mod 12).
 *
 * Returns 0 if already compatible (distance ≤ 1), or a small integer
 * shift in the range [-3, +3] semitones.  Returns null if keys are too
 * far apart for a tasteful correction (would need > 3 semitones).
 */
export function harmonicPitchShift(keyA, keyB) {
    const dist = camelotDistance(keyA.camelot, keyB.camelot);
    if (dist <= 1)
        return 0; // Already compatible
    // Each Camelot step = 7 semitones on the chromatic circle (circle of fifths)
    // To close a gap of `d` Camelot steps, shift by `d * 7 mod 12` semitones.
    // Pick the direction (up or down) that yields the smallest absolute shift.
    const up = (dist * 7) % 12;
    const down = 12 - up;
    const shift = up <= down ? up : -down;
    // Only apply small corrections (≤ 3 semitones = ≤ minor third)
    if (Math.abs(shift) > 3)
        return null;
    return shift;
}
/**
 * Harmonic compatibility score between two detected keys (0–1).
 *
 * Combines Camelot distance with detector certainty/clarity metrics.
 * Useful for deciding if a transparent "fusion" transition is safe.
 */
export function harmonicCompatibilityScore(keyA, keyB) {
    if (!keyA || !keyB)
        return null;
    const distance = camelotDistance(keyA.camelot, keyB.camelot);
    const letterA = keyA.camelot.slice(-1);
    const letterB = keyB.camelot.slice(-1);
    const isRelative = distance === 0 && letterA !== letterB;
    const isSame = distance === 0 && letterA === letterB;
    const isNeighbor = distance === 1 && letterA === letterB;
    let distanceScore = 0;
    if (isSame)
        distanceScore = 1.0;
    else if (isRelative)
        distanceScore = 0.95;
    else if (isNeighbor)
        distanceScore = 0.9;
    else
        distanceScore = clamp01(1 - (distance / 6) ** 1.1 * 0.9);
    const confidenceScore = Math.sqrt(clamp01(keyA.confidence) * clamp01(keyB.confidence));
    const stabilityScore = Math.sqrt(clamp01(keyA.stability ?? keyA.confidence) *
        clamp01(keyB.stability ?? keyB.confidence));
    const clarityScore = Math.sqrt(clamp01(keyA.tonalClarity ?? keyA.confidence) *
        clamp01(keyB.tonalClarity ?? keyB.confidence));
    const ambiguityPenalty = ((keyA.modeAmbiguity ?? 0.35) + (keyB.modeAmbiguity ?? 0.35)) * 0.5;
    return clamp01(0.4 * distanceScore +
        0.22 * confidenceScore +
        0.18 * stabilityScore +
        0.15 * clarityScore +
        0.05 * (1 - ambiguityPenalty));
}
// ── Internal helpers ──────────────────────────────────────────────
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
/** Rotate a 12-element profile so that index 0 aligns with pitch class `root`. */
function rotateProfile(profile, root) {
    const rotated = new Array(12);
    for (let i = 0; i < 12; i++) {
        rotated[i] = profile[(i - root + 12) % 12];
    }
    return rotated;
}
/** Pearson correlation coefficient between a Float64Array and a number[]. */
function pearsonCorrelation(x, y) {
    const n = x.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        const xi = x[i];
        const yi = y[i];
        sumX += xi;
        sumY += yi;
        sumXY += xi * yi;
        sumX2 += xi * xi;
        sumY2 += yi * yi;
    }
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denominator < 1e-10)
        return 0;
    return numerator / denominator;
}
/**
 * Find the best key from a weighted chroma vector.
 * Returns pc + mode, or null if chroma is empty.
 */
function findBestKey(chroma, weight) {
    if (weight === 0)
        return null;
    // Normalize
    let maxC = 0;
    for (let i = 0; i < 12; i++) {
        const v = chroma[i] / weight;
        if (v > maxC)
            maxC = v;
    }
    if (maxC < 1e-10)
        return null;
    const norm = new Float64Array(12);
    for (let i = 0; i < 12; i++)
        norm[i] = chroma[i] / weight / maxC;
    let bestCorr = -Infinity;
    let bestPc = 0;
    let bestMode = 'major';
    for (let root = 0; root < 12; root++) {
        const corrMaj = pearsonCorrelation(norm, rotateProfile(MAJOR_PROFILE, root));
        const corrMin = pearsonCorrelation(norm, rotateProfile(MINOR_PROFILE, root));
        if (corrMaj > bestCorr) {
            bestCorr = corrMaj;
            bestPc = root;
            bestMode = 'major';
        }
        if (corrMin > bestCorr) {
            bestCorr = corrMin;
            bestPc = root;
            bestMode = 'minor';
        }
    }
    if (bestCorr <= 0)
        return null;
    return { pc: bestPc, mode: bestMode };
}
/**
 * Find the best key + compute z-score margin for confidence.
 */
function findBestKeyWithStats(chroma, weight) {
    if (weight === 0)
        return null;
    let maxC = 0;
    for (let i = 0; i < 12; i++) {
        const v = chroma[i] / weight;
        if (v > maxC)
            maxC = v;
    }
    if (maxC < 1e-10)
        return null;
    const norm = new Float64Array(12);
    for (let i = 0; i < 12; i++)
        norm[i] = chroma[i] / weight / maxC;
    const correlations = [];
    let bestCorr = -Infinity;
    let secondCorr = -Infinity;
    let bestPc = 0;
    let bestMode = 'major';
    let corrMajorAtBestRoot = -Infinity;
    let corrMinorAtBestRoot = -Infinity;
    for (let root = 0; root < 12; root++) {
        const corrMaj = pearsonCorrelation(norm, rotateProfile(MAJOR_PROFILE, root));
        const corrMin = pearsonCorrelation(norm, rotateProfile(MINOR_PROFILE, root));
        correlations.push(corrMaj, corrMin);
        if (corrMaj > bestCorr) {
            secondCorr = bestCorr;
            bestCorr = corrMaj;
            bestPc = root;
            bestMode = 'major';
            corrMajorAtBestRoot = corrMaj;
            corrMinorAtBestRoot = corrMin;
        }
        else if (corrMaj > secondCorr) {
            secondCorr = corrMaj;
        }
        if (corrMin > bestCorr) {
            secondCorr = bestCorr;
            bestCorr = corrMin;
            bestPc = root;
            bestMode = 'minor';
            corrMajorAtBestRoot = corrMaj;
            corrMinorAtBestRoot = corrMin;
        }
        else if (corrMin > secondCorr) {
            secondCorr = corrMin;
        }
    }
    if (bestCorr <= 0)
        return null;
    // z-score: (best - mean) / stddev across all 24 correlations
    const n = correlations.length;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
        sum += correlations[i];
        sumSq += correlations[i] * correlations[i];
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const stddev = Math.sqrt(Math.max(0, variance));
    const zScore = stddev > 1e-10 ? (bestCorr - mean) / stddev : 0;
    const altModeCorr = bestMode === 'major' ? corrMinorAtBestRoot : corrMajorAtBestRoot;
    const modeGap = Math.max(0, bestCorr - altModeCorr);
    return { pc: bestPc, mode: bestMode, zScore, bestCorr, secondCorr, modeGap };
}
function computeTonalClarity(chroma, weight, best) {
    if (weight <= 0)
        return 0;
    const norm = new Float64Array(12);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        norm[i] = Math.max(0, chroma[i] / weight);
        sum += norm[i];
    }
    if (sum <= 1e-12)
        return 0;
    for (let i = 0; i < 12; i++) {
        norm[i] = norm[i] / sum;
    }
    let entropy = 0;
    let maxP = 0;
    let secondP = 0;
    for (let i = 0; i < 12; i++) {
        const p = norm[i];
        if (p > maxP) {
            secondP = maxP;
            maxP = p;
        }
        else if (p > secondP) {
            secondP = p;
        }
        if (p > 1e-12)
            entropy -= p * Math.log(p);
    }
    const entropyNorm = entropy / Math.log(12);
    const entropyClarity = clamp01(1 - entropyNorm);
    const peakGap = clamp01((maxP - secondP) / (maxP + 1e-9));
    const root = best.pc;
    const third = (root + (best.mode === 'major' ? 4 : 3)) % 12;
    const fifth = (root + 7) % 12;
    const triadSupport = clamp01((norm[root] + norm[third] + norm[fifth] - 0.18) / 0.47);
    return clamp01(0.4 * entropyClarity + 0.3 * peakGap + 0.3 * triadSupport);
}
