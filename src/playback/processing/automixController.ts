import { logger } from '../../utils.ts'
import type { PlayerTrack } from '../../typings/playback/player.types.ts'
import {
    camelotDistance,
    harmonicCompatibilityScore,
    harmonicPitchShift,
    type KeyResult
} from './keyDetector.ts'
import type { ScratchStyle } from '../../typings/playback/processing.types.ts'

export type AutoMixMode = 'smart' | 'fusion' | 'dj_fx' | 'radio' | 'turntable'

export type AutoMixTransition =
    | 'gapless'
    | 'crossfade_eq'
    | 'echo_out'
    | 'vocal_strip'
    | 'highpass_dissolve'
    | 'cinema_lift'
    | 'pulse_tunnel'
    | 'spinback'
    | 'filter_sweep'
    | 'reverb_wash'
    | 'vinyl_brake'
    | 'backspin'
    | 'scratch_out'
    | 'fusion_morph'
    | 'harmonic_weave'

export interface AutoMixDecision {
    transition: AutoMixTransition

    /** AutoMix's OWN transition duration (ms). Independent of crossfade config. */
    transitionDurationMs: number

    // ── Track A (outgoing) effects ──

    /** Animated lowpass on track A. null = no lowpass. */
    lowpassA: {
        smoothing: number
        /** How long the lowpass ramps from 0 % to target (ms). */
        durationMs: number
    } | null

    /** Animated highpass on track A (remove bass → "float"). null = no HPF. */
    highpassA: {
        smoothing: number
        /** How long the highpass ramps from 0 % to target (ms). */
        durationMs: number
    } | null

    /** Echo tail on track A. null = no echo. */
    echoA: {
        delay: number
        mix: number
        feedback: number
        /** How long the echo fades in from silent to full (ms). 0 = instant. */
        rampMs?: number
    } | null

    /** Reverb on track A for atmospheric fade. null = no reverb. */
    reverbA: {
        mix: number
        roomSize: number
        damping?: number
        /** How long the reverb fades in from dry to full (ms). 0 = instant. */
        rampMs?: number
    } | null

    /** Karaoke (vocal removal) on track A. null = no karaoke. */
    karaokeA: {
        level: number
        monoLevel: number
        filterBand: number
        filterWidth: number
        /** How long the karaoke effect fades in (ms). 0 = instant. */
        rampMs?: number
    } | null

    /** Phaser sweep on track A. null = no phaser. */
    phaserA: {
        rate: number
        depth: number
        mix: number
        /** How long the phaser fades in (ms). 0 = instant. */
        rampMs?: number
    } | null

    /** Tremolo flutter on track A. null = no tremolo. */
    tremoloA: {
        frequency: number
        depth: number
        /** How long the tremolo fades in (ms). 0 = instant. */
        rampMs?: number
    } | null

    // ── Track B (incoming) effects ──

    /** Inline highpass sweep on track B in the CrossfadeController. */
    highpassSweepB: boolean

    /** Peak highpass alpha for Track B sweep (0.12 default, lower = lighter). */
    highpassSweepAlpha?: number

    /** Inline lowpass sweep on Track B: starts muffled, opens to full spectrum. */
    lowpassSweepB?: boolean

    /** Peak lowpass alpha for Track B sweep (0.15 default, higher = more muffled). */
    lowpassSweepAlpha?: number

    /** Fraction of crossfade where lowpass sweep completes (0.2–1.0). */
    lowpassSweepCompletionRatio?: number

    /** Optional volume multiplier applied only to incoming Track B during crossfade. */
    incomingGainMultiplier?: number | null

    /** Optional timescale ramp for Track A before blend (beatmatch + pitch). */
    timescaleA?: {
        speed: number
        /** Pitch multiplier for harmonic correction (1.0 = no change). */
        pitch?: number
        durationMs: number
        curve?: 'linear' | 'sinusoidal' | 'exponential'
    } | null

    /** Stereo pan sweep on Track B: enters from right, sweeps to center. */
    stereoPanB?: boolean

    /** Fraction of crossfade where incoming pan reaches center (0.2–1.0). */
    incomingPanCompletionRatio?: number

    /** Stereo pan sweep on Track A: exits from center to left (spatial departure). */
    stereoPanA?: boolean

    /** Fraction of crossfade where outgoing pan reaches full departure (0.2–1.0). */
    outgoingPanCompletionRatio?: number

    // ── Track B (incoming) inline DSP ──

    /** Inline echo on incoming Track B (fades from wet → dry over the crossfade).
     *  Creates an "emerging from reverb" effect.  null = no echo. */
    echoB: {
        /** Echo delay in ms (50–800). */
        delay: number
        /** Wet mix at the start of crossfade (0–0.5).  Fades to 0. */
        mix: number
        /** Feedback amount (0–0.6). */
        feedback: number
    } | null

    /** Fraction of crossfade where incoming echo dries out (0.2–1.0). */
    incomingEchoCompletionRatio?: number

    // ── Physical effects (TapeTransformer / ScratchTransformer) ──

    /** TapeTransformer vinyl stop on Track A (real resampling with pitch drop). null = no tape. */
    tapeStopA: {
        durationMs: number
        curve?: 'linear' | 'exponential' | 'sinusoidal'
    } | null

    /** ScratchTransformer effect on Track A (physical vinyl scratch). null = no scratch. */
    scratchA: {
        durationMs: number
        style: ScratchStyle
    } | null
}

type DeezerMetadataOptions = {
    enabled?: boolean
    useBpm?: boolean
    useGain?: boolean
    maxBpmDiffRatio?: number
    tempoMatch?: boolean
}

type AutoMixAnalyzeOptions = {
    deezerMetadata?: DeezerMetadataOptions
    /** Track A's current RMS energy (0–1 range). */
    trackAEnergy?: number
    /** Track B's opening RMS energy (0–1 range). When available, refines transition selection. */
    trackBOpeningEnergy?: number
    /** Live BPM detected from Track A audio analysis. */
    liveBpmA?: number | null
    /** Live BPM detected from Track B preload analysis. */
    liveBpmB?: number | null
    /** Confidence (0-1) for Track A live BPM. */
    liveBpmAConfidence?: number | null
    /** Confidence (0-1) for Track B live BPM. */
    liveBpmBConfidence?: number | null
    /** Detected musical key for Track A (Camelot notation). */
    keyA?: KeyResult | null
    /** Detected musical key for Track B (Camelot notation). */
    keyB?: KeyResult | null
}

export default class AutoMixController {

    // ── Rotating counter for variety ──
    // Ensures consecutive transitions use different techniques even when
    // the structural analysis would pick the same one.  Not truly random —

    /**
     * Computes the optimal crossfade duration based on musical context.
     * The config `maxDurationMs` acts as a hard cap.
     */
    private static _computeOptimalDuration(
        maxDurationMs: number,
        bpmA: number | null,
        bpmB: number | null,
        keyDist: number,
        trackBEnergy: number,
        trackALengthMs: number,
        trackBLengthMs: number
    ): number {
        // High-fidelity base for Apple Music-like blends.
        // For Fusion mode, we want a very long runway (base 12s if allowed).
        let duration = Math.max(8000, maxDurationMs * 0.95)

        const bpm = bpmA ?? bpmB
        let genre: string = 'unknown'
        
        if (bpm && bpm > 0) {
            // Genre inference from BPM (based on user hints)
            if (bpm >= 118 && bpm <= 132) genre = 'house'
            else if (bpm >= 115 && bpm <= 145) genre = 'electronic'
            else if (bpm >= 80 && bpm <= 110) genre = 'hiphop'
            else if (bpm >= 110 && bpm <= 170) genre = 'rock'
            else if (bpm >= 60 && bpm <= 90) genre = 'bolero'

            // Genre-adaptive duration scaling
            if (genre === 'house' || genre === 'electronic') {
                duration *= 1.25 // Electronic genres love long blends
            } else if (genre === 'hiphop') {
                duration *= 0.85 // Hip-hop prefers punchier handoffs
            }

            const bpmFactor = Math.pow(120 / bpm, 0.28)
            duration *= Math.max(0.75, Math.min(1.35, bpmFactor))
        }

        // Beat-match bonus: if BPMs are very close, stretch the blend for transparency.
        if (bpmA && bpmB && Math.abs(bpmA - bpmB) < 1.5) {
            duration *= 1.15
        }

        if (keyDist >= 0) {
            if (keyDist > 4) duration *= 0.75 // Dissonant? Move faster.
            else if (keyDist > 2) duration *= 0.90
        }

        if (trackBEnergy > 0.25) {
            duration *= 0.82
        } else if (trackBEnergy >= 0 && trackBEnergy < 0.05) {
            duration *= 1.40 // Atmospheric builds
        }

        const minLen = Math.min(
            trackALengthMs > 0 ? trackALengthMs : 180000,
            trackBLengthMs > 0 ? trackBLengthMs : 180000
        )
        duration = Math.min(duration, minLen * 0.25)

        const floorMs = Math.min(
            maxDurationMs,
            maxDurationMs >= 6000
                ? 6000
                : Math.max(1500, Math.round(maxDurationMs * 0.75))
        )
        const clamped = Math.round(Math.max(floorMs, Math.min(maxDurationMs, duration)))

        if (bpm && bpm > 0) {
            return quantizeDurationToPhrase(clamped, bpm, floorMs, maxDurationMs)
        }

        return clamped
    }

    // ── Variety tracking ──
    // Prevents repeating the same transition in consecutive uses.
    // The scoring engine penalises recently used transitions so the
    // mix sounds varied even when the musical context is similar.
    private static _recentHistory: AutoMixTransition[] = []

    /**
     * Makes a crossfade transition decision based on local metadata
     * and a feature-driven scoring engine.  No external API calls —
     * purely deterministic from track info + audio features.
     *
     * Every candidate transition is scored against ALL available
     * features (key, BPM, energy, duration, mode, variety history).
     * The highest-scoring transition wins, with weighted random from
     * the top tier for natural variety.
     *
     * @param trackA - Currently playing track (outgoing).
     * @param trackB - Next track (incoming).
     * @param crossfadeDurationMs - Configured crossfade duration.
     * @param mode - AutoMix mode from config.
     */
    public static analyze(
        trackA: PlayerTrack,
        trackB: PlayerTrack,
        crossfadeDurationMs: number,
        mode: AutoMixMode,
        options: AutoMixAnalyzeOptions = {}
    ): AutoMixDecision {
        const titleA = trackA.info.title || ''
        const titleB = trackB.info.title || ''
        const authorA = trackA.info.author || ''
        const authorB = trackB.info.author || ''

        // ── Live streams → gapless only ──
        if (trackA.info.isStream || trackB.info.isStream) {
            logger('info', 'AutoMix', `Stream detected → gapless: [${titleA}] → [${titleB}]`)
            return gapless()
        }

        // ── Same album → gapless ──
        const piA = trackA.pluginInfo as Record<string, any> | undefined
        const piB = trackB.pluginInfo as Record<string, any> | undefined
        const albumA = piA?.['albumName'] || piA?.['albumUrl']
        const albumB = piB?.['albumName'] || piB?.['albumUrl']
        if (albumA && albumA === albumB) {
            logger('info', 'AutoMix', `Same album → gapless: [${titleA}] → [${titleB}]`)
            return gapless()
        }

        const deezerCfg = options.deezerMetadata || {}
        const deezerEnabled = deezerCfg.enabled === true
        const useBpm = deezerCfg.useBpm !== false
        const useGain = deezerEnabled && deezerCfg.useGain !== false
        const tempoMatch = deezerCfg.tempoMatch !== false
        const maxBpmDiffRatio =
            typeof deezerCfg.maxBpmDiffRatio === 'number' && deezerCfg.maxBpmDiffRatio > 0
                ? deezerCfg.maxBpmDiffRatio
                : 0.08

        const metaBpmA = readDeezerNumeric(trackA, 'bpm')
        const metaBpmB = readDeezerNumeric(trackB, 'bpm')
        const metaBpmSourceA = readDeezerText(trackA, 'bpmSource')
        const metaBpmSourceB = readDeezerText(trackB, 'bpmSource')
        const selectedA = selectTempoCandidate({
            liveBpm: options.liveBpmA ?? null,
            liveConfidence: options.liveBpmAConfidence ?? null,
            metadataBpm: metaBpmA,
            metadataSource: metaBpmSourceA,
            trackLabel: 'A'
        })
        const selectedB = selectTempoCandidate({
            liveBpm: options.liveBpmB ?? null,
            liveConfidence: options.liveBpmBConfidence ?? null,
            metadataBpm: metaBpmB,
            metadataSource: metaBpmSourceB,
            trackLabel: 'B'
        })
        const bpmA = selectedA.bpm
        const bpmB = selectedB.bpm
        const bpmSourceA = selectedA.source
        const bpmSourceB = selectedB.source
        const gainA = readDeezerNumeric(trackA, 'gain')
        const gainB = readDeezerNumeric(trackB, 'gain')

        let incomingGainMultiplier: number | null = null
        if (useGain && Number.isFinite(gainA) && Number.isFinite(gainB)) {
            const deltaDb = (gainA as number) - (gainB as number)
            const clampedDb = Math.max(-8, Math.min(8, deltaDb))
            incomingGainMultiplier = Math.max(
                0.5,
                Math.min(1.5, Math.pow(10, clampedDb / 20))
            )
        }

        // AutoMix is the boss — it determines the ideal blend length based
        // on BPM, key, energy, and track length.  The configured duration
        // acts as a maximum cap (user preference / buffer constraint).
        const trackAEnergy = options.trackAEnergy ?? -1
        const trackBEnergy = options.trackBOpeningEnergy ?? -1
        const configuredDurationMs = crossfadeDurationMs
        crossfadeDurationMs = AutoMixController._computeOptimalDuration(
            configuredDurationMs, bpmA, bpmB, -1 /* keyDist computed below */,
            trackBEnergy,
            trackA.info.length || 0,
            trackB.info.length || 0
        )

        // Only trust key detection when BOTH tracks have confidence > 30%.
        // Low-confidence keys would cause false key-clash decisions, potentially
        // picking heavy FX transitions (echo_out, vocal_strip) unnecessarily.
        const MIN_KEY_CONFIDENCE = 0.30
        const keySignalA = keySignalReliability(options.keyA ?? null)
        const keySignalB = keySignalReliability(options.keyB ?? null)
        const keysReliable = !!(options.keyA?.camelot && options.keyB?.camelot
            && options.keyA.confidence > MIN_KEY_CONFIDENCE
            && options.keyB.confidence > MIN_KEY_CONFIDENCE)
            && keySignalA >= 0.36
            && keySignalB >= 0.36
        const keyDist = keysReliable
            ? camelotDistance(options.keyA!.camelot, options.keyB!.camelot)
            : -1
        const harmonicScore = keysReliable
            ? harmonicCompatibilityScore(options.keyA ?? null, options.keyB ?? null)
            : null

        // Refine duration now that keyDist is available
        if (keyDist >= 0) {
            crossfadeDurationMs = AutoMixController._computeOptimalDuration(
                configuredDurationMs, bpmA, bpmB, keyDist,
                trackBEnergy,
                trackA.info.length || 0,
                trackB.info.length || 0
            )
        }
        if (harmonicScore != null) {
            if (harmonicScore >= 0.84) {
                crossfadeDurationMs = Math.min(
                    configuredDurationMs,
                    Math.round(crossfadeDurationMs * 1.08)
                )
            } else if (harmonicScore <= 0.46) {
                crossfadeDurationMs = Math.max(
                    4500,
                    Math.round(crossfadeDurationMs * 0.92)
                )
            }
        }

        // A calm tail into a much hotter Track B opening needs more runway.
        const energyKnownEarly = trackAEnergy >= 0 && trackBEnergy >= 0
        const strongEnergyRiseEarly = energyKnownEarly &&
            trackAEnergy > 0 &&
            trackAEnergy < 0.16 &&
            trackBEnergy > 0.18 &&
            trackBEnergy > trackAEnergy * 1.55
        const energeticOpeningJumpEarly = energyKnownEarly &&
            trackAEnergy > 0 &&
            trackBEnergy > 0.24 &&
            trackBEnergy - trackAEnergy > 0.10
        if (strongEnergyRiseEarly || energeticOpeningJumpEarly) {
            const stretchFactor = strongEnergyRiseEarly ? 1.18 : 1.12
            const floorMs = energeticOpeningJumpEarly ? 6200 : 4500
            const stretched = Math.round(crossfadeDurationMs * stretchFactor)
            crossfadeDurationMs = Math.max(
                floorMs,
                Math.min(configuredDurationMs, stretched)
            )
            if ((bpmA ?? bpmB) && (bpmA ?? bpmB)! > 0) {
                crossfadeDurationMs = quantizeDurationToPhrase(
                    crossfadeDurationMs,
                    (bpmA ?? bpmB)!,
                    floorMs,
                    configuredDurationMs
                )
            }
        }

        logger('info', 'AutoMix', `Optimal duration: ${crossfadeDurationMs}ms` +
            (bpmA ? ` (BPM A: ${(bpmA as number).toFixed(0)})` : '') +
            (keyDist >= 0 ? ` (key dist: ${keyDist})` : '') +
            (harmonicScore != null ? ` (harmonic: ${(harmonicScore * 100).toFixed(0)}%)` : '') +
            (trackBEnergy >= 0 ? ` (B energy: ${(trackBEnergy * 100).toFixed(0)}%)` : ''))

        // ── BPM relationship ──
        let bpmMatch: { speedRatio: number; diff: number; variant: string } | null = null
        if (useBpm && Number.isFinite(bpmA) && Number.isFinite(bpmB)
            && (bpmA as number) > 0 && (bpmB as number) > 0) {
            bpmMatch = findBestBpmRatio(bpmA as number, bpmB as number)
        }
        const bpmConfidence = bpmMatch
            ? computeTempoConfidence(bpmSourceA, bpmSourceB, bpmMatch.variant)
            : 0
        const lowConfidenceTempo = !!(
            bpmMatch &&
            bpmMatch.diff <= maxBpmDiffRatio &&
            bpmConfidence < 0.78
        )
        const lowConfidenceVariantTempo = !!(
            bpmMatch &&
            bpmMatch.diff <= maxBpmDiffRatio &&
            bpmMatch.variant !== 'direct' &&
            bpmConfidence < 0.80
        )

        // ── Derived features ──
        const sameArtist = authorA.toLowerCase() === authorB.toLowerCase()
        const durationA = trackA.info.length || 0
        const durationB = trackB.info.length || 0
        const durationRatio = (durationA > 0 && durationB > 0)
            ? Math.abs(durationA - durationB) / Math.max(durationA, durationB)
            : 0
        const avgDuration = ((durationA || 180_000) + (durationB || 180_000)) / 2
        const isShort = durationA < 30_000 || durationB < 30_000
        const hasTempoData = !!bpmMatch
        const hasKeyData = keyDist >= 0
        const isEnergyKnown = trackAEnergy >= 0 && trackBEnergy >= 0
        const highEnergyPair = isEnergyKnown && trackAEnergy > 0.35 && trackBEnergy > 0.16
        const strongEnergyRise = isEnergyKnown &&
            trackAEnergy > 0 &&
            trackAEnergy < 0.16 &&
            trackBEnergy > 0.18 &&
            trackBEnergy > trackAEnergy * 1.55
        const energeticOpeningJump = isEnergyKnown &&
            trackAEnergy > 0 &&
            trackBEnergy > 0.24 &&
            trackBEnergy - trackAEnergy > 0.10
        const energyPivotMode = strongEnergyRise || energeticOpeningJump
        const largeBpmGap = !!bpmMatch && bpmMatch.diff > 0.16
        const extremeBpmGap = !!bpmMatch && bpmMatch.diff > 0.28
        const strongEnergyDrop = isEnergyKnown && trackAEnergy > 0.25 && trackBEnergy < 0.12
        const largeGainCorrection = incomingGainMultiplier != null &&
            Math.abs(20 * Math.log10(incomingGainMultiplier)) > 5

        // ══════════════════════════════════════════════════════════════
        //  Scoring engine — evaluate fitness of every transition
        // ══════════════════════════════════════════════════════════════
        //
        //  Instead of rigid pools + round-robin, each candidate gets a
        //  score computed from ALL available features.  The transition
        //  with the highest fitness wins.  A small weighted-random from
        //  the top tier ensures natural variety without sacrificing
        //  musical intelligence.

        type Candidate = {
            transition: AutoMixTransition
            build: () => AutoMixDecision
            score: number
        }

        const d = crossfadeDurationMs
        const candidates: Candidate[] = [
            { transition: 'fusion_morph', build: () => fusionMorph(d, bpmA), score: 0 },
            { transition: 'harmonic_weave', build: () => harmonicWeave(d, bpmA), score: 0 },
            { transition: 'crossfade_eq', build: () => crossfadeEq(d, true, bpmA), score: 0 },
            { transition: 'highpass_dissolve', build: () => highpassDissolve(d, bpmA), score: 0 },
            { transition: 'cinema_lift', build: () => cinemaLift(d, bpmA), score: 0 },
            { transition: 'pulse_tunnel', build: () => pulseTunnel(d, bpmA), score: 0 },
            { transition: 'echo_out', build: () => echoOut(d, bpmA), score: 0 },
            { transition: 'vocal_strip', build: () => vocalStrip(d, bpmA), score: 0 },
            { transition: 'filter_sweep', build: () => filterSweep(d, bpmA), score: 0 },
            { transition: 'reverb_wash', build: () => reverbWash(d, bpmA), score: 0 },
            { transition: 'spinback', build: () => spinback(d, bpmA), score: 0 },
            { transition: 'vinyl_brake', build: () => vinylBrake(d, bpmA), score: 0 },
            { transition: 'backspin', build: () => backspinTransition(d, bpmA), score: 0 },
            { transition: 'scratch_out', build: () => scratchOut(d, bpmA), score: 0 },
        ]

        const CLEAN: Set<AutoMixTransition> = new Set(['fusion_morph', 'harmonic_weave', 'crossfade_eq', 'highpass_dissolve', 'pulse_tunnel'])
        const ATMOSPHERIC: Set<AutoMixTransition> = new Set(['fusion_morph', 'harmonic_weave', 'echo_out', 'reverb_wash', 'vocal_strip', 'filter_sweep', 'cinema_lift'])
        const PHYSICAL: Set<AutoMixTransition> = new Set(['spinback', 'vinyl_brake', 'backspin', 'scratch_out'])
        const MASKING: Set<AutoMixTransition> = new Set(['echo_out', 'vocal_strip', 'reverb_wash', 'cinema_lift'])
        const lastTransition = AutoMixController._recentHistory[0] ?? null
        const lastWasPhysical = !!lastTransition && PHYSICAL.has(lastTransition)
        const lastWasAtmospheric = !!lastTransition && ATMOSPHERIC.has(lastTransition)
        const lastWasClean = !!lastTransition && CLEAN.has(lastTransition)

        for (const c of candidates) {
            let s = 10 // neutral baseline

            const clean = CLEAN.has(c.transition)
            const atmo = ATMOSPHERIC.has(c.transition)
            const phys = PHYSICAL.has(c.transition)
            const mask = MASKING.has(c.transition)

            // Keep vocals/instrumentals intact in modern medley-style blends.
            // "vocal_strip" is now an exception path, not a default.
            if (c.transition === 'vocal_strip') {
                if (mode === 'fusion') s -= 55
                else if (mode === 'smart') s -= 40
                else if (mode === 'radio') s -= 28
                else s -= 14
                if (!sameArtist) s -= 10
            }

            // ── 1. Key compatibility ──
            if (keyDist >= 0) {
                if (keyDist <= 1) {
                    // Perfect / near-perfect harmony → clean transitions shine
                    if (clean) s += 12
                    else if (atmo && !mask) s += 4
                    if (mask) s -= 4 // masking is wasteful when keys match
                    if (c.transition === 'fusion_morph') s += 15 // Priority for fusion
                } else if (keyDist <= 3) {
                    // Moderate compatibility
                    if (clean) s += 5
                    if (mask) s += 2
                    if (c.transition === 'fusion_morph') s += 8
                } else {
                    // Key clash → strongly favour masking transitions
                    if (mask) s += 18
                    if (clean) s -= 12 // bare crossfade exposes the dissonance
                    if (phys) s += 3   // physical effects also hide clashes
                    if (c.transition === 'fusion_morph') s -= 10
                }
            }

            if (harmonicScore != null) {
                if (harmonicScore >= 0.84) {
                    if (c.transition === 'fusion_morph') s += 12
                    if (c.transition === 'harmonic_weave') s += 18
                    if (c.transition === 'crossfade_eq') s += 8
                    if (mask) s -= 5
                } else if (harmonicScore >= 0.70) {
                    if (c.transition === 'harmonic_weave') s += 10
                    if (clean) s += 4
                    if (phys) s -= 3
                } else if (harmonicScore <= 0.46) {
                    if (c.transition === 'harmonic_weave') s -= 8
                    if (c.transition === 'fusion_morph') s -= 6
                    if (mask) s += 8
                    if (c.transition === 'cinema_lift') s += 4
                }
            }

            // ── 2. Track B opening energy ──
            if (trackBEnergy >= 0) {
                if (trackBEnergy < 0.05) {
                    // Quiet intro → atmospheric / gradual build
                    if (atmo) s += 10
                    if (phys) s -= 6 // dramatic slam into silence feels wrong
                    if (c.transition === 'fusion_morph') s += 12
                } else if (trackBEnergy < 0.15) {
                    // Mid-low energy → balanced
                    if (atmo) s += 3
                    if (c.transition === 'fusion_morph') s += 5
                } else if (trackBEnergy > 0.25) {
                    // Loud / punchy → clean & tight transitions
                    if (clean) s += 8
                    if (c.transition === 'filter_sweep') s += 5
                    if (c.transition === 'reverb_wash') s -= 4 // wash + loud = muddy
                    if (c.transition === 'fusion_morph') s -= 5 // maybe too long for punchy
                }
            }

            // Track A is calm but B opens hot: avoid sudden "electric slam".
            if (energyPivotMode) {
                if (c.transition === 'fusion_morph') s += 15
                if (c.transition === 'crossfade_eq') s += 12
                if (c.transition === 'filter_sweep') s += 10
                if (c.transition === 'highpass_dissolve') s += 9
                if (c.transition === 'cinema_lift') s -= 18
                if (c.transition === 'pulse_tunnel') s -= 9
                if (c.transition === 'reverb_wash') s -= 10
                if (c.transition === 'echo_out') s -= 7
            }

            // ── 3. BPM relationship ──
            if (bpmMatch) {
                if (bpmMatch.diff <= maxBpmDiffRatio) {
                    // BPMs "match". If this match only appears through half/double
                    // variants from fallback audio BPM, treat it as low-confidence:
                    // prefer cinematic/safe blends over hard tempo-assumptive ones.
                    if (lowConfidenceTempo) {
                        if (energyPivotMode) {
                            if (clean) s += 4
                            if (c.transition === 'fusion_morph') s += 10
                            if (c.transition === 'crossfade_eq') s += 8
                            if (c.transition === 'filter_sweep') s += 6
                            if (c.transition === 'highpass_dissolve') s += 5
                            if (c.transition === 'cinema_lift') s -= 12
                            if (c.transition === 'pulse_tunnel') s -= 8
                            if (phys) s -= 12
                        } else {
                            if (clean) s += 2
                            if (c.transition === 'fusion_morph') s += 12
                            if (c.transition === 'crossfade_eq') s += 3
                            if (c.transition === 'cinema_lift') s += 9
                            if (c.transition === 'pulse_tunnel') s += 8
                            if (c.transition === 'filter_sweep') s += 1
                            if (phys) s -= 10
                        }
                    } else {
                        // High-confidence BPM match → harmonic/clean transitions.
                        if (clean) s += 6
                        if (c.transition === 'fusion_morph') s += 18
                        if (c.transition === 'filter_sweep') s += 7
                        if (c.transition === 'cinema_lift') s += 4
                        if (phys) s -= 8 // physical effects break rhythmic flow
                    }
                } else if (bpmMatch.diff > 0.15) {
                    // Big BPM mismatch: in smart/fusion we still prefer musical
                    // masking/filter pivots instead of overusing physical FX.
                    if (extremeBpmGap) {
                        if (mode === 'turntable' || mode === 'dj_fx') {
                            if (phys) s += 14
                        } else {
                            if (phys) s += 2
                            if (clean) s += 2
                            if (mask) s += 8
                            if (c.transition === 'fusion_morph') s += 4
                            if (c.transition === 'filter_sweep') s += 6
                            if (c.transition === 'highpass_dissolve') s += 5
                            if (c.transition === 'pulse_tunnel') s += 7
                            if (c.transition === 'cinema_lift') s += 5
                        }
                    } else {
                        if (mode === 'turntable' || mode === 'dj_fx') {
                            if (phys) s += 10
                        } else {
                            if (phys) s += 1
                            if (clean) s += 3
                            if (mask) s += 5
                            if (c.transition === 'fusion_morph') s += 6
                            if (c.transition === 'filter_sweep') s += 5
                            if (c.transition === 'highpass_dissolve') s += 4
                            if (c.transition === 'pulse_tunnel') s += 5
                            if (c.transition === 'cinema_lift') s += 4
                        }
                    }
                } else {
                    // Moderate mismatch
                    if (phys) s += 4
                    if (mask) s += 3
                    if (c.transition === 'fusion_morph') s += 8
                }
            }
            if (lowConfidenceVariantTempo) {
                if (energyPivotMode) {
                    if (c.transition === 'fusion_morph') s += 10
                    if (c.transition === 'crossfade_eq') s += 7
                    if (c.transition === 'filter_sweep') s += 5
                    if (c.transition === 'highpass_dissolve') s += 4
                    if (c.transition === 'cinema_lift') s -= 12
                    if (c.transition === 'pulse_tunnel') s -= 7
                } else {
                    if (c.transition === 'fusion_morph') s += 12
                    if (c.transition === 'cinema_lift') s += 8
                    if (c.transition === 'pulse_tunnel') s += 6
                    if (c.transition === 'crossfade_eq') s += 2
                    if (c.transition === 'filter_sweep') s -= 4
                    if (c.transition === 'highpass_dissolve') s -= 3
                }
            }

            // Strong outgoing→incoming energy drop + BPM contrast:
            // avoid abrupt "slam" FX and favor spectral handoff transitions.
            if (strongEnergyDrop && largeBpmGap) {
                if (c.transition === 'fusion_morph') s += 15
                if (c.transition === 'crossfade_eq') s += 12
                if (c.transition === 'filter_sweep') s += 9
                if (c.transition === 'cinema_lift') s += 10
                if (c.transition === 'pulse_tunnel') s += 7
                if (c.transition === 'highpass_dissolve') s += 5
                if (c.transition === 'echo_out') s -= 3
                if (c.transition === 'reverb_wash') s -= 6
                if (c.transition === 'vocal_strip') s -= (mode === 'fusion' ? 12 : 4)
                if (c.transition === 'spinback' || c.transition === 'backspin') s -= 6
            }
            if (trackBEnergy >= 0 && trackBEnergy < 0.03) {
                if (c.transition === 'fusion_morph') s += 10
                if (c.transition === 'crossfade_eq') s += 6
                if (c.transition === 'cinema_lift') s += 6
                if (c.transition === 'pulse_tunnel') s += 4
                if (c.transition === 'highpass_dissolve') s -= 4
                if (c.transition === 'echo_out') s -= 3
                if (c.transition === 'vocal_strip') s -= (mode === 'fusion' ? 10 : 3)
            }

            // ── 4. Same artist → vocal_strip removes clashing vocals ──
            if (sameArtist) {
                // Keep a small same-artist bonus, but avoid making it dominant.
                if (c.transition === 'vocal_strip') s += (mode === 'fusion' ? 0 : 4)
                if (c.transition === 'fusion_morph') s += (mode === 'fusion' ? 12 : 5)
            }

            // ── 5. Track duration ──
            if (isShort) {
                // Short tracks (skits/interludes) → quick clean transitions
                if (clean) s += 12
                if (phys) s -= 8
                if (atmo) s -= 5
                if (c.transition === 'fusion_morph') s -= 15 // Way too long
            }
            if (durationRatio > 0.30) {
                // Duration disparity → dramatic effects appropriate
                if (phys) s += 6
                if (c.transition === 'echo_out') s += 4
            }
            if (avgDuration > 240_000) {
                // Long tracks → cinematic
                if (atmo) s += 5
                if (c.transition === 'fusion_morph') s += 10
                if (c.transition === 'reverb_wash') s += 3
            }
            if (durationA < 90_000 || durationB < 90_000) {
                if (c.transition === 'reverb_wash') s -= 6
                if (c.transition === 'fusion_morph') s -= 8
            }

            // ── 5.1 Missing analysis data → safer choices ──
            // When key/BPM are unknown, prefer conservative transitions.
            if (!hasTempoData && !hasKeyData) {
                if (clean) s += 6
                if (phys) s -= 12
                if (c.transition === 'reverb_wash') s -= 4
                if (c.transition === 'fusion_morph') s += 10
            } else if (!hasTempoData) {
                if (clean) s += 3
                if (phys) s -= 8
                if (c.transition === 'fusion_morph') s += 5
            }
            if (!isEnergyKnown && atmo) s -= 2

            // Large loudness correction windows are more stable with clean transitions.
            if (largeGainCorrection) {
                if (clean) s += 4
                if (atmo) s -= 3
                if (c.transition === 'fusion_morph') s += 6
            }

            // ── 6. Mode preference ──
            switch (mode) {
                case 'radio':
                    if (clean) s += 10
                    if (phys) s -= 20 // no vinyl tricks on radio
                    if (c.transition === 'reverb_wash') s -= 5
                    if (c.transition === 'fusion_morph') s += 8
                    if (c.transition === 'harmonic_weave') s += 7
                    break
                case 'dj_fx':
                    if (phys) s += 5
                    if (atmo) s += 2
                    break
                case 'turntable':
                    // Turntable mode: gentle preference for physical effects.
                    // Nudges scoring toward backspin, scratch, vinyl_brake,
                    // spinback without forcefully excluding other options.
                    if (phys) s += 15
                    if (clean) s -= 8
                    if (atmo) s -= 3
                    if (c.transition === 'backspin') s += 5
                    if (c.transition === 'scratch_out') s += 4
                    if (c.transition === 'vinyl_brake') s += 3
                    if (c.transition === 'spinback') s += 2
                    if (c.transition === 'fusion_morph') s -= 10
                    break
                case 'fusion':
                    if (atmo) s += 5
                    if (phys) s += 3
                    if (clean && c.transition === 'crossfade_eq') s -= 3
                    if (c.transition === 'fusion_morph') s += 25 // Huge bonus for Fusion mode
                    if (c.transition === 'harmonic_weave') s += 16
                    if (energyPivotMode) {
                        if (c.transition === 'fusion_morph') s += 10
                        if (c.transition === 'harmonic_weave') s += 9
                        if (c.transition === 'crossfade_eq') s += 7
                        if (c.transition === 'filter_sweep') s += 6
                        if (c.transition === 'highpass_dissolve') s += 5
                        if (c.transition === 'cinema_lift') s -= 12
                        if (c.transition === 'pulse_tunnel') s -= 6
                    } else {
                        if (c.transition === 'fusion_morph') s += 5
                        if (c.transition === 'cinema_lift') s += 8
                        if (c.transition === 'pulse_tunnel') s += 5
                    }
                    break
                case 'smart':
                    // Smart mode should sound intentional and stable:
                    // mostly clean/atmospheric, with physical FX only when
                    // the context strongly justifies them.
                    if (!highEnergyPair && !largeBpmGap) {
                        if (phys) s -= 8
                    }
                    if (highEnergyPair && !strongEnergyDrop) {
                        if (phys) s += 3
                    }
                    if (largeBpmGap) {
                        if (c.transition === 'filter_sweep') s += 6
                        if (c.transition === 'highpass_dissolve') s += 6
                        if (phys) s -= 2
                    }
                    if (extremeBpmGap) {
                        if (mask) s += 4
                        if (phys) s -= 3
                    }

                    if (keyDist >= 2 && keyDist <= 5) {
                        if (atmo) s += 6
                    }
                    if (c.transition === 'fusion_morph') s += 12
                    if (c.transition === 'harmonic_weave') s += 11
                    if (c.transition === 'filter_sweep') s += 4
                    if (c.transition === 'crossfade_eq') s += 2
                    if (!energyPivotMode) {
                        if (c.transition === 'cinema_lift') s += 7
                        if (c.transition === 'pulse_tunnel') s += 5
                    }
                    if (energyPivotMode) {
                        if (c.transition === 'fusion_morph') s += 8
                        if (c.transition === 'cinema_lift') s -= 10
                        if (c.transition === 'crossfade_eq') s += 7
                        if (c.transition === 'filter_sweep') s += 6
                        if (c.transition === 'highpass_dissolve') s += 6
                    }
                    if (lowConfidenceVariantTempo) {
                        if (energyPivotMode) {
                            if (c.transition === 'fusion_morph') s += 6
                            if (c.transition === 'cinema_lift') s -= 9
                            if (c.transition === 'pulse_tunnel') s -= 6
                            if (c.transition === 'crossfade_eq') s += 6
                            if (c.transition === 'filter_sweep') s += 4
                        } else {
                            if (c.transition === 'fusion_morph') s += 8
                            if (c.transition === 'cinema_lift') s += 6
                            if (c.transition === 'pulse_tunnel') s += 5
                            if (c.transition === 'filter_sweep') s -= 3
                        }
                    }
                    break
            }

            // ── 6.1 Transition continuity ──
            // Avoid chains of equally aggressive transitions.
            if (lastTransition) {
                if (phys && lastWasPhysical) s -= 10
                if (atmo && lastWasAtmospheric && trackBEnergy < 0.12) s -= 5
                if (clean && lastWasPhysical) s += 4
                if (clean && lastWasClean && keyDist > 4) s -= 4
            }

            // ── 6.2 Outlier guards ──
            if (trackBEnergy > 0.24) {
                if (c.transition === 'reverb_wash') s -= 8
                if (c.transition === 'echo_out') s -= 4
            }
            if (!sameArtist && keyDist >= 0 && keyDist <= 1 && bpmMatch && bpmMatch.diff <= maxBpmDiffRatio) {
                if (c.transition === 'vocal_strip') s -= 6
            }
            if (d >= 8000 && mode !== 'turntable' && mode !== 'dj_fx' && phys) {
                s -= 5
            }

            // In high-compatibility contexts, alternate fusion flavors so the
            // sequence feels "alive" instead of repeating one fixed profile.
            const recentFusionCount = AutoMixController._recentHistory
                .slice(0, 2)
                .filter((t) => t === 'fusion_morph' || t === 'harmonic_weave')
                .length
            if (mode === 'fusion' || mode === 'smart') {
                if (
                    harmonicScore != null &&
                    harmonicScore >= 0.82 &&
                    bpmMatch &&
                    bpmMatch.diff <= Math.max(0.12, maxBpmDiffRatio) &&
                    !energyPivotMode
                ) {
                    if (c.transition === 'harmonic_weave') s += 12
                    if (c.transition === 'fusion_morph') s -= 6
                }
                if (lastTransition === 'fusion_morph' && c.transition === 'fusion_morph') {
                    s -= 18
                }
                if (recentFusionCount >= 2 && c.transition === 'fusion_morph') {
                    s -= 24
                }
                if (
                    lastTransition === 'fusion_morph' &&
                    c.transition === 'harmonic_weave' &&
                    harmonicScore != null &&
                    harmonicScore >= 0.70
                ) {
                    s += 8
                }
            }

            // ── 7. Variety: penalise recently used transitions ──
            const recency = AutoMixController._recentHistory.indexOf(c.transition)
            if (recency === 0) s -= 20   // just used → heavy penalty
            else if (recency === 1) s -= 12
            else if (recency === 2) s -= 6
            else if (recency === 3) s -= 3

            c.score = s
        }

        // Sort descending by score
        candidates.sort((a, b) => b.score - a.score)

        // Deterministic selection from a narrow top tier to reduce
        // erratic "coin flip" picks while preserving subtle variety.
        const topCandidate = candidates[0]
        if (!topCandidate) return gapless()
        const bestScore = topCandidate.score
        const tierWindow = mode === 'smart' ? 4 : 6
        const tier = candidates.filter(c => c.score >= bestScore - tierWindow && c.score > 0)
        const safeTier = tier.length > 0 ? tier : [topCandidate]
        const pairSeed = `${trackA.info.identifier}|${trackB.info.identifier}|${mode}`
        let pick = safeTier[0] || topCandidate
        let bestComposite = Number.NEGATIVE_INFINITY
        for (const c of safeTier) {
            const jitter = stableUnit(`${pairSeed}|${c.transition}`) * 0.35
            const composite = c.score + jitter
            if (composite > bestComposite) {
                bestComposite = composite
                pick = c
            }
        }

        if (energyPivotMode && trackBEnergy >= 0.22) {
            const pivotTransitions = new Set<AutoMixTransition>([
                'harmonic_weave',
                'crossfade_eq',
                'filter_sweep',
                'highpass_dissolve',
            ])
            const pivotPick = candidates.find(c => pivotTransitions.has(c.transition))
            if (pivotPick && !pivotTransitions.has(pick.transition)) {
                logger(
                    'info',
                    'AutoMix',
                    `Energy pivot override: ${pick.transition} → ${pivotPick.transition} for [${titleA}] → [${titleB}]`
                )
                pick = pivotPick
            }
        }

        // Record in history (keep last 5)
        AutoMixController._recentHistory.unshift(pick.transition)
        if (AutoMixController._recentHistory.length > 5) {
            AutoMixController._recentHistory.pop()
        }

        // Build the chosen transition
        let decision = pick.build()

        // Dynamic incoming ducking from live energy when metadata gain is unavailable.
        if (
            incomingGainMultiplier == null &&
            isEnergyKnown &&
            trackAEnergy > 0 &&
            trackBEnergy > 0
        ) {
            const ratio = trackAEnergy / trackBEnergy
            if (ratio < 0.98) {
                const duck = Math.sqrt(Math.max(0.18, ratio))
                incomingGainMultiplier = Math.max(0.56, Math.min(1.0, duck))
            }
            if (energyPivotMode) {
                incomingGainMultiplier = Math.max(
                    0.50,
                    Math.min(
                        0.80,
                        incomingGainMultiplier != null
                            ? incomingGainMultiplier
                            : 0.72
                    )
                )
            }
        }

        decision.incomingGainMultiplier = incomingGainMultiplier
        AutoMixController._applySignaturePolish(decision, {
            mode,
            keyDist,
            bpmDiff: bpmMatch?.diff ?? null,
            bpmForEcho: bpmB ?? bpmA,
            trackAEnergy,
            trackBEnergy,
            strongEnergyDrop,
            strongEnergyRise,
            energyPivotMode,
            largeBpmGap,
            extremeBpmGap,
            sameArtist
        })

        if (
            decision.transition === 'fusion_morph' ||
            decision.transition === 'harmonic_weave'
        ) {
            const fusionFloorMs = mode === 'fusion' ? 16000 : 14000
            decision.transitionDurationMs = Math.max(
                decision.transitionDurationMs,
                fusionFloorMs
            )
        }

        // Avoid "plain fade" perception in hard handoffs: when BPM gap is large
        // and Track B opens quietly, prefer a more shaped transition than filter sweep.
        if (
            decision.transition === 'filter_sweep' &&
            bpmMatch &&
            bpmMatch.diff >= 0.24 &&
            trackBEnergy >= 0 &&
            trackBEnergy < 0.12
        ) {
            const replacement = mode === 'dj_fx' || mode === 'turntable'
                ? pulseTunnel(decision.transitionDurationMs, bpmA)
                : cinemaLift(decision.transitionDurationMs, bpmA)
            replacement.incomingGainMultiplier = decision.incomingGainMultiplier
            AutoMixController._applySignaturePolish(replacement, {
                mode,
                keyDist,
                bpmDiff: bpmMatch?.diff ?? null,
                bpmForEcho: bpmB ?? bpmA,
                trackAEnergy,
                trackBEnergy,
                strongEnergyDrop,
                strongEnergyRise,
                energyPivotMode,
                largeBpmGap,
                extremeBpmGap,
                sameArtist
            })
            decision = replacement
        }

        // ── Apply BPM timescale matching ──
        // Smart mode can stretch tolerance slightly (up to 10%) to smooth
        // difficult transitions without falling into aggressive FX too early.
        const fusionTempoTransition =
            decision.transition === 'fusion_morph' ||
            decision.transition === 'harmonic_weave'
        const tempoMatchTolerance = mode === 'smart'
            ? Math.max(maxBpmDiffRatio, fusionTempoTransition ? 0.16 : 0.12)
            : (fusionTempoTransition ? Math.max(maxBpmDiffRatio, 0.14) : maxBpmDiffRatio)
        const baseSpeedClamp = mode === 'smart' ? 0.10 : 0.12
        const maxSpeedClamp = fusionTempoTransition ? 0.18 : baseSpeedClamp
        const allowTempoTimescale = !(
            bpmMatch &&
            bpmMatch.variant !== 'direct' &&
            bpmConfidence < 0.75
        )
        if (tempoMatch && bpmMatch && bpmMatch.diff <= tempoMatchTolerance && allowTempoTimescale) {
            const adaptiveSpeedClamp = fusionTempoTransition
                ? Math.min(
                    maxSpeedClamp,
                    baseSpeedClamp + Math.max(0, bpmMatch.diff - 0.08) * 0.35
                )
                : baseSpeedClamp
            const rawSpeed = Math.round(bpmMatch.speedRatio * 1000) / 1000
            const targetSpeed = Math.max(
                1 - adaptiveSpeedClamp,
                Math.min(1 + adaptiveSpeedClamp, rawSpeed)
            )
            // Skip timescale if clamped speed barely differs from 1.0
            if (Math.abs(targetSpeed - 1.0) >= 0.015) {
                decision.timescaleA = {
                    speed: targetSpeed,
                    durationMs: Math.max(2500, Math.min(15000, Math.round(decision.transitionDurationMs * 1.2))),
                    curve: 'sinusoidal'
                }
                if (options.keyA && options.keyB
                    && options.keyA.confidence > 0.30 && options.keyB.confidence > 0.30
                    && keyDist >= 2 && keyDist <= 3) {
                    const semitones = harmonicPitchShift(options.keyA, options.keyB)
                    if (semitones != null && semitones !== 0) {
                        decision.timescaleA.pitch = Math.pow(2, semitones / 12)
                        logger('info', 'AutoMix',
                            `Harmonic pitch correction: ${semitones > 0 ? '+' : ''}${semitones} semitones `
                            + `(${options.keyA.camelot} → ${options.keyB.camelot})`)
                    }
                }
            }
        }

        // Build score report for log
        const topScores = candidates.slice(0, 4)
            .map(c => `${c.transition}:${c.score}`)
            .join(' ')
        const keyTag = keyDist >= 0 ? ` key:${keyDist}` : ''
        const harmonicTag = harmonicScore != null
            ? ` harm:${Math.round(harmonicScore * 100)}%`
            : ''
        const bpmTag = bpmMatch
            ? ` bpm-diff:${(bpmMatch.diff * 100).toFixed(1)}%(${bpmMatch.variant}, conf:${Math.round(bpmConfidence * 100)}%)`
            : ''
        const energyTag = trackBEnergy >= 0 ? ` energy:${(trackBEnergy * 100).toFixed(0)}%` : ''

        logger('info', 'AutoMix',
            `${decision.transition} (score ${pick.score}) for guild: ` +
            `[${titleA}] → [${titleB}]${keyTag}${harmonicTag}${bpmTag}${energyTag} | ${topScores}`)

        return decision
    }

    private static _applySignaturePolish(
        decision: AutoMixDecision,
        context: {
            mode: AutoMixMode
            keyDist: number
            bpmDiff: number | null
            bpmForEcho: number | null
            trackAEnergy: number
            trackBEnergy: number
            strongEnergyDrop: boolean
            strongEnergyRise: boolean
            energyPivotMode: boolean
            largeBpmGap: boolean
            extremeBpmGap: boolean
            sameArtist: boolean
        }
    ): void {
        if (context.mode === 'turntable') return

        const keyContrast = context.keyDist >= 0
            ? Math.max(0, Math.min(1, context.keyDist / 6))
            : 0.35
        const tempoContrast = context.bpmDiff != null
            ? Math.max(0, Math.min(1, context.bpmDiff / 0.30))
            : 0.25
        const energyContrast = (context.trackAEnergy >= 0 && context.trackBEnergy >= 0)
            ? Math.max(0, Math.min(1, Math.abs(context.trackAEnergy - context.trackBEnergy) / 0.35))
            : 0.30
        const contrast = (keyContrast + tempoContrast + energyContrast) / 3

        const polishedTransitions = new Set<AutoMixTransition>([
            'fusion_morph',
            'harmonic_weave',
            'filter_sweep',
            'highpass_dissolve',
            'crossfade_eq',
            'vocal_strip',
            'cinema_lift',
            'pulse_tunnel',
            'echo_out'
        ])
        if (!polishedTransitions.has(decision.transition)) return
        if (contrast < 0.45 && !context.energyPivotMode) return

        // Spatial motion adds "wow" while keeping the blend clean.
        decision.stereoPanA = true
        decision.stereoPanB = true

        // Ensure Track B arrives through a shaped spectral window.
        // For fusion/harmonic transitions we avoid HP+LP at the same time
        // because that can isolate vocals and kill the instrumental bed.
        const fusionLike =
            decision.transition === 'fusion_morph' ||
            decision.transition === 'harmonic_weave'

        if (fusionLike) {
            decision.highpassSweepB = false
            decision.lowpassSweepB = true

            const lpBase = decision.lowpassSweepAlpha ?? 0.15
            const lpBoost = contrast >= 0.75 ? 0.018 : 0.012
            decision.lowpassSweepAlpha = Math.max(0.13, Math.min(0.20, lpBase + lpBoost))
            decision.lowpassSweepCompletionRatio = context.strongEnergyDrop ? 0.46 : 0.34
        } else {
            decision.highpassSweepB = true
            decision.lowpassSweepB = true

            const hpBase = decision.highpassSweepAlpha ?? 0.06
            const lpBase = decision.lowpassSweepAlpha ?? 0.08
            const hpBoost = contrast >= 0.75 ? 0.015 : 0.008
            let lpBoost = contrast >= 0.75 ? 0.012 : 0.006
            if (context.strongEnergyDrop) lpBoost += 0.006

            decision.highpassSweepAlpha = Math.max(0.04, Math.min(0.10, hpBase + hpBoost))
            decision.lowpassSweepAlpha = Math.max(0.07, Math.min(0.12, lpBase + lpBoost))
            decision.lowpassSweepCompletionRatio = context.strongEnergyDrop ? 0.62 : 0.52
        }

        if (context.energyPivotMode) {
            if (fusionLike) {
                decision.lowpassSweepAlpha = Math.max(
                    decision.lowpassSweepAlpha ?? 0.12,
                    0.14
                )
                decision.lowpassSweepCompletionRatio = Math.max(
                    decision.lowpassSweepCompletionRatio ?? 0.42,
                    0.40
                )
                decision.lowpassSweepCompletionRatio = Math.min(
                    0.52,
                    decision.lowpassSweepCompletionRatio
                )
            } else {
                decision.lowpassSweepAlpha = Math.max(
                    decision.lowpassSweepAlpha ?? 0.10,
                    0.105
                )
                decision.lowpassSweepCompletionRatio = Math.max(
                    decision.lowpassSweepCompletionRatio ?? 0.52,
                    0.78
                )
            }
            if (decision.incomingGainMultiplier == null) {
                decision.incomingGainMultiplier = 0.68
            } else {
                decision.incomingGainMultiplier = fusionLike
                    ? Math.max(0.58, Math.min(0.82, decision.incomingGainMultiplier))
                    : Math.max(0.50, Math.min(0.80, decision.incomingGainMultiplier))
            }
        }

        // Add a subtle incoming echo for cinematic emergence when needed.
        if (!decision.echoB) {
            decision.echoB = {
                delay: beatSyncedDelay(context.bpmForEcho, 0.5, 220),
                mix: context.extremeBpmGap ? 0.13 : 0.10,
                feedback: context.extremeBpmGap ? 0.20 : 0.16
            }
        }
        decision.incomingEchoCompletionRatio = context.extremeBpmGap ? 0.72 : 0.64

        // Keep vocal blends cleaner when artists differ.
        if (!context.sameArtist && decision.transition === 'vocal_strip' && decision.echoA) {
            decision.echoA.mix = Math.max(0.08, Math.min(0.14, decision.echoA.mix - 0.02))
        }

        // If contrast is extreme and energy drops hard, avoid too much wetness.
        if (context.strongEnergyDrop && context.largeBpmGap) {
            if (decision.reverbA) {
                decision.reverbA.mix = Math.max(0.10, Math.min(0.24, decision.reverbA.mix))
            }
            if (decision.echoA) {
                decision.echoA.mix = Math.max(0.08, Math.min(0.22, decision.echoA.mix))
            }
        }

        // Control spatial choreography timing for cleaner perception.
        decision.incomingPanCompletionRatio = context.extremeBpmGap ? 0.35 : 0.28
        decision.outgoingPanCompletionRatio = context.strongEnergyDrop ? 0.58 : 0.48
        if (context.energyPivotMode) {
            decision.incomingPanCompletionRatio = Math.max(
                decision.incomingPanCompletionRatio ?? 0.28,
                0.45
            )
            decision.incomingEchoCompletionRatio = Math.max(
                decision.incomingEchoCompletionRatio ?? 0.64,
                0.76
            )
        }
    }
}

// ── Transition Builders ──
// Echo delay and reverb parameters are BPM-adaptive when a tempo is known,
// falling back to hardcoded values when BPM is unavailable.

function stableHash(input: string): number {
    let hash = 2166136261
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function stableUnit(input: string): number {
    return stableHash(input) / 4294967295
}

function keySignalReliability(key: KeyResult | null): number {
    if (!key) return 0
    const confidence = Math.max(0, Math.min(1, key.confidence))
    const stability = Math.max(0, Math.min(1, key.stability ?? confidence))
    const clarity = Math.max(0, Math.min(1, key.tonalClarity ?? confidence))
    const ambiguity = Math.max(0, Math.min(1, key.modeAmbiguity ?? 0.35))
    return Math.max(
        0,
        Math.min(
            1,
            0.45 * confidence + 0.25 * stability + 0.20 * clarity + 0.10 * (1 - ambiguity)
        )
    )
}

function quantizeDurationToPhrase(durationMs: number, bpm: number, minMs: number, maxMs: number): number {
    if (!Number.isFinite(bpm) || bpm <= 0) {
        return Math.max(minMs, Math.min(maxMs, Math.round(durationMs)))
    }

    const beatMs = 60000 / bpm
    const beatGroups = [8, 12, 16, 24, 32]
    let best = Math.max(minMs, Math.min(maxMs, Math.round(durationMs)))
    let bestDiff = Number.POSITIVE_INFINITY

    for (const beats of beatGroups) {
        const candidate = Math.round(beatMs * beats)
        if (candidate < minMs || candidate > maxMs) continue
        const diff = Math.abs(candidate - durationMs)
        if (diff < bestDiff) {
            best = candidate
            bestDiff = diff
        }
    }

    // Keep the quantizer gentle: ignore candidate if it would jump too far
    // from the analytical duration target.
    if (bestDiff > durationMs * 0.35) {
        return Math.max(minMs, Math.min(maxMs, Math.round(durationMs)))
    }

    return best
}

function gapless(): AutoMixDecision {
    return {
        transition: 'gapless',
        transitionDurationMs: 500,
        lowpassA: null,
        highpassA: null,
        echoA: null,
        reverbA: null,
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: false,
        lowpassSweepB: false,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * DJ EQ crossfade — clean & professional.
 *
 * Track A: progressive lowpass sweep (warmth → muffle), light echo + ambient
 *          reverb for glue.  Parameters chosen so the effect is audible but
 *          never "effecty" — it should sound like a smooth club blend.
 * Track B: highpass sweep (thin → full body).
 *
 *  Echo     beat-synced eighth note (fallback: 340 ms).
 *  Reverb   BPM-adaptive room size (fallback: 0.50).
 */
function crossfadeEq(durationMs: number, withEcho = true, bpm: number | null = null): AutoMixDecision {
    const ramp = Math.round(durationMs * 0.85)

    // Beat-synced: eighth note (0.5 beat) for subtle rhythmic echo
    const echoDelay = beatSyncedDelay(bpm, 0.5, 340)
    const echoFeedback = adaptiveFeedback(bpm, 0.20)
    const roomSize = adaptiveRoomSize(bpm, 0.50)
    const damping = adaptiveDamping(bpm, 0.55)

    // BPM-adaptive HP sweep: faster BPM → lighter sweep (track B punches through)
    const hpAlpha = bpm && bpm > 0
        ? Math.max(0.03, Math.min(0.07, 0.05 * Math.pow(120 / bpm, 0.2)))
        : 0.05

    return {
        transition: 'crossfade_eq',
        transitionDurationMs: durationMs,
        // Refined Lowpass: smoother cutoff ramp
        lowpassA: {
            smoothing: 28, // ~715 Hz (slightly warmer than 800)
            durationMs: durationMs
        },
        // NEW: Subtle Highpass on Track A to 'hollow out' the sound towards the end
        highpassA: {
            smoothing: 40, // ~120 Hz cutoff
            durationMs: Math.round(durationMs * 0.9)
        },
        echoA: withEcho
            ? { delay: echoDelay, mix: 0.08, feedback: echoFeedback, rampMs: ramp }
            : null,
        reverbA: { mix: 0.10, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: hpAlpha,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Atmospheric "Echo Out" — dramatic, Apple Music‑style.
 *
 * Phase 1  Progressive lowpass on Track A — highs fade away.
 * Phase 2  Heavy echo + cathedral reverb → spacious, atmospheric tail.
 * Phase 3  Track B enters thin (highpass sweep) → fills out.
 *
 *  Echo     beat-synced dotted eighth (0.75 beat, fallback: 480 ms).
 *  Reverb   BPM-adaptive cathedral (fallback: roomSize 0.90, damping 0.22).
 */
function echoOut(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Atmospheric transitions benefit from longer blends
    durationMs = Math.round(durationMs * 1.10)
    const ramp = Math.round(durationMs * 0.80)

    // Beat-synced: dotted eighth (0.75 beat) for groovy spacious tail
    const echoDelay = beatSyncedDelay(bpm, 0.75, 480)
    const echoFeedback = adaptiveFeedback(bpm, 0.40)
    const roomSize = adaptiveRoomSize(bpm, 0.90)
    const damping = adaptiveDamping(bpm, 0.22)

    // BPM-adaptive HP sweep: slower BPM → heavier sweep (more dramatic entrance)
    const hpAlpha = bpm && bpm > 0
        ? Math.max(0.04, Math.min(0.08, 0.06 * Math.pow(120 / bpm, 0.25)))
        : 0.06

    return {
        transition: 'echo_out',
        transitionDurationMs: durationMs,
        // Lowpass smoothing 40 → cutoff ~500 Hz (distant, hollow mood).
        // Old value (1000) hit the 200 Hz floor → identical to all other
        // builders.  40 → 500 Hz gives a clearly deeper muffle than
        // crossfade_eq (800 Hz) while keeping some body for the echo tail.
        lowpassA: {
            smoothing: 40,
            durationMs: durationMs
        },
        highpassA: null,
        echoA: {
            delay: echoDelay,
            mix: 0.24,
            feedback: echoFeedback,
            rampMs: ramp
        },
        reverbA: {
            mix: 0.24,
            roomSize,
            damping,
            rampMs: ramp
        },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: hpAlpha,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        // Track B enters with echo that fades to dry — "emerging from space"
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 300),
            mix: 0.14,
            feedback: 0.25
        },
        tapeStopA: null,
        scratchA: null
    }
}

function readDeezerNumeric(track: PlayerTrack, field: 'bpm' | 'gain'): number | null {
    const pluginInfo = (track.pluginInfo || {}) as Record<string, any>
    const deezerMeta = pluginInfo['deezer'] || pluginInfo['deezerMetadata'] || null
    if (!deezerMeta || typeof deezerMeta !== 'object') return null
    const value = Number(deezerMeta[field])
    return Number.isFinite(value) ? value : null
}

function readDeezerText(track: PlayerTrack, field: string): string | null {
    const pluginInfo = (track.pluginInfo || {}) as Record<string, any>
    const deezerMeta = pluginInfo['deezer'] || pluginInfo['deezerMetadata'] || null
    if (!deezerMeta || typeof deezerMeta !== 'object') return null
    const raw = deezerMeta[field]
    return typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim().toLowerCase()
        : null
}

function tempoSourceConfidence(source: string | null): number {
    if (!source) return 0.70
    if (source.includes('audio-live')) return 0.92
    if (source.includes('audio') && source.includes('lowconf')) return 0.62
    if (source.includes('audio')) return 0.80
    if (source.includes('deezer') || source.includes('api') || source.includes('metadata')) return 0.74
    return 0.76
}

function computeTempoConfidence(
    sourceA: string | null,
    sourceB: string | null,
    variant: string
): number {
    let confidence = (tempoSourceConfidence(sourceA) + tempoSourceConfidence(sourceB)) / 2
    if (variant !== 'direct') confidence *= 0.70
    return Math.max(0.35, Math.min(1.0, confidence))
}

function asValidTempo(value: number | null | undefined): number | null {
    return Number.isFinite(value) && (value as number) > 0
        ? Number(value)
        : null
}

function asConfidence(value: number | null | undefined): number | null {
    if (!Number.isFinite(value)) return null
    return Math.max(0, Math.min(1, Number(value)))
}

function tempoRatioDiff(a: number, b: number): number {
    return Math.abs(a - b) / Math.max(a, b)
}

function selectTempoCandidate(input: {
    liveBpm: number | null
    liveConfidence: number | null
    metadataBpm: number | null
    metadataSource: string | null
    trackLabel: 'A' | 'B'
}): { bpm: number | null; source: string | null } {
    const live = asValidTempo(input.liveBpm)
    const liveConf = asConfidence(input.liveConfidence)
    const meta = asValidTempo(input.metadataBpm)
    const metaSource = input.metadataSource ?? null

    if (!live && !meta) return { bpm: null, source: null }
    if (live && !meta) {
        return {
            bpm: live,
            source: liveConf != null && liveConf < 0.40 ? 'audio-live-lowconf' : 'audio-live'
        }
    }
    if (!live && meta) {
        return { bpm: meta, source: metaSource ?? 'metadata' }
    }

    const diff = tempoRatioDiff(live!, meta!)
    // Prefer real-time audio whenever confidence is reasonable.
    if ((liveConf ?? 0.55) >= 0.45) {
        return { bpm: live!, source: 'audio-live' }
    }
    // Low-confidence live detection can still win if close to metadata.
    if (diff <= 0.18) {
        return { bpm: live!, source: 'audio-live-lowconf' }
    }

    logger(
        'debug',
        'AutoMix',
        `Tempo source fallback to metadata for Track ${input.trackLabel} (live conf ${(liveConf ?? 0).toFixed(2)}, diff ${(diff * 100).toFixed(1)}%)`
    )
    return { bpm: meta!, source: metaSource ?? 'metadata' }
}


// ── NEW Transition Builders ──────────────────────────────────────

/**
 * Vocal Strip — karaoke + reverb wash (DJ vocal extraction).
 *
 * The karaoke filter removes centre-panned vocals from Track A, leaving
 * the instrumental bed.  Paired with reverb + echo it creates a dreamy
 * instrumental tail that blends seamlessly into Track B.
 *
 * Best when:
 * - Tracks have different vocalists (avoids vocal clash)
 * - Slower tempos where vocals linger
 */
function vocalStrip(durationMs: number, bpm: number | null = null): AutoMixDecision {
    const ramp = Math.round(durationMs * 0.80)
    const echoDelay = beatSyncedDelay(bpm, 0.5, 300)
    const echoFeedback = adaptiveFeedback(bpm, 0.30)
    const roomSize = adaptiveRoomSize(bpm, 0.65)
    const damping = adaptiveDamping(bpm, 0.40)

    return {
        transition: 'vocal_strip',
        transitionDurationMs: durationMs,
        // Light lowpass to soften the instrumental bed (cutoff ~670 Hz)
        lowpassA: { smoothing: 30, durationMs },
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.10, feedback: echoFeedback, rampMs: ramp },
        reverbA: { mix: 0.16, roomSize, damping, rampMs: ramp },
        karaokeA: {
            level: 1.0,        // Full vocal removal
            monoLevel: 1.0,    // Mono vocal removal
            filterBand: 220,   // Vocal frequency focus (Hz)
            filterWidth: 100,  // Bandwidth
            rampMs: Math.round(durationMs * 0.5) // Vocals dissolve over first half
        },
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.06,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        // Track B enters with light echo (dreamy instrumental blends well)
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 250),
            mix: 0.12,
            feedback: 0.20
        },
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Highpass Dissolve — Track A thins out into the air.
 *
 * Instead of muffling (lowpass), Track A loses bass and body, becoming
 * airy and ethereal.  Combined with heavy reverb it sounds like the
 * music is floating away.  Track B enters full-bodied from below.
 *
 * Classic DJ technique: "kill the bass" on the outgoing deck while
 * bringing in the new track's low end.
 */
function highpassDissolve(durationMs: number, bpm: number | null = null): AutoMixDecision {
    const ramp = Math.round(durationMs * 0.85)
    const echoDelay = beatSyncedDelay(bpm, 0.75, 400)
    const echoFeedback = adaptiveFeedback(bpm, 0.25)
    const roomSize = adaptiveRoomSize(bpm, 0.75)
    const damping = adaptiveDamping(bpm, 0.30)

    return {
        transition: 'highpass_dissolve',
        transitionDurationMs: durationMs,
        lowpassA: null,
        // Highpass: Track A loses bass progressively → becomes thin/airy
        // smoothing 150 → alpha ≈ 0.36 → cutoff ≈ 3400 Hz (Butterworth 12 dB/oct).
        // Old value (800) hit alpha ≈ 0.48 → 5050 Hz which removed ALL bass+mids
        // and sounded like listening through a tin can.  3400 Hz keeps the
        // "thin / airy" character while preserving some upper-mid body.
        highpassA: { smoothing: 150, durationMs },
        echoA: { delay: echoDelay, mix: 0.10, feedback: echoFeedback, rampMs: ramp },
        reverbA: { mix: 0.22, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        // No highpass on Track B — it enters full-bodied while A goes thin
        highpassSweepB: false,
        lowpassSweepB: false,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Cinema Lift — premium cinematic handoff.
 *
 * Track A keeps groove but narrows spectrum while ambience grows.
 * Track B emerges in stereo with subtle synced echo and opens fast.
 */
function cinemaLift(durationMs: number, bpm: number | null = null): AutoMixDecision {
    durationMs = Math.round(durationMs * 1.08)
    const ramp = Math.round(durationMs * 0.82)
    const echoDelay = beatSyncedDelay(bpm, 0.75, 360)
    const roomSize = adaptiveRoomSize(bpm, 0.62)
    const damping = adaptiveDamping(bpm, 0.38)

    const tremoloFreq = bpm && bpm > 0
        ? Math.round(Math.max(0.7, Math.min(3.2, bpm / 72)) * 100) / 100
        : 1.6

    return {
        transition: 'cinema_lift',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 55, durationMs },
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.16, feedback: 0.22, rampMs: ramp },
        reverbA: { mix: 0.20, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.38,
            depth: 0.40,
            mix: 0.14,
            rampMs: ramp
        },
        tremoloA: {
            frequency: tremoloFreq,
            depth: 0.08,
            rampMs: ramp
        },
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.09,
        highpassSweepAlpha: 0.08,
        lowpassSweepCompletionRatio: 0.50,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: true,
        incomingPanCompletionRatio: 0.30,
        stereoPanA: true,
        outgoingPanCompletionRatio: 0.50,
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 230),
            mix: 0.12,
            feedback: 0.18
        },
        incomingEchoCompletionRatio: 0.66,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Pulse Tunnel — modern club handoff with spectral tunnel effect.
 *
 * Track A transitions through a tighter band, then Track B opens quickly
 * with controlled spatial motion. Designed for large BPM or style gaps.
 */
function pulseTunnel(durationMs: number, bpm: number | null = null): AutoMixDecision {
    durationMs = Math.round(durationMs * 0.96)
    const ramp = Math.round(durationMs * 0.80)
    const echoDelay = beatSyncedDelay(bpm, 0.5, 280)
    const roomSize = adaptiveRoomSize(bpm, 0.50)
    const damping = adaptiveDamping(bpm, 0.50)

    return {
        transition: 'pulse_tunnel',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 45, durationMs },
        highpassA: { smoothing: 170, durationMs: Math.round(durationMs * 0.85) },
        echoA: { delay: echoDelay, mix: 0.13, feedback: 0.22, rampMs: ramp },
        reverbA: { mix: 0.14, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.62,
            depth: 0.42,
            mix: 0.13,
            rampMs: ramp
        },
        tremoloA: {
            frequency: bpm && bpm > 0 ? Math.max(0.8, Math.min(4.0, Math.round((bpm / 50) * 100) / 100)) : 1.8,
            depth: 0.10,
            rampMs: ramp
        },
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.09,
        highpassSweepAlpha: 0.08,
        lowpassSweepCompletionRatio: 0.46,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: true,
        incomingPanCompletionRatio: 0.24,
        stereoPanA: true,
        outgoingPanCompletionRatio: 0.44,
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 200),
            mix: 0.10,
            feedback: 0.16
        },
        incomingEchoCompletionRatio: 0.56,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Spinback / Brake — vinyl DJ turntable stop.
 *
 * Track A decelerates (timescale ramp down to 0.6×) with a phaser sweep
 * that simulates the sound of a turntable slowing.  Echo tail catches the
 * last fragments.  Track B enters clean and full.
 *
 * Feels dramatic and intentional — great for transitions between different
 * genres or tempos where a clean blend would sound jarring.
 */
function spinback(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Physical effects are inherently shorter — dramatic, quick
    durationMs = Math.round(durationMs * 0.65)
    const ramp = Math.round(durationMs * 0.70)
    const echoDelay = beatSyncedDelay(bpm, 1.0, 500)  // quarter note for dramatic tail
    const echoFeedback = adaptiveFeedback(bpm, 0.40)
    const roomSize = adaptiveRoomSize(bpm, 0.60)
    const damping = adaptiveDamping(bpm, 0.45)

    return {
        transition: 'spinback',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 50, durationMs },
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.30, feedback: echoFeedback, rampMs: ramp },
        reverbA: { mix: 0.25, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.3,       // Slow sweep simulating turntable wobble
            depth: 0.8,
            mix: 0.35,
            rampMs: ramp
        },
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.06,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        // Real TapeTransformer: Cubic Hermite Spline resampling with authentic
        // pitch drop.  Far superior to the timescale filter for vinyl stop effects
        // because it models per-sample rate change (smooth deceleration curve)
        // rather than a chunked filter transition.
        tapeStopA: {
            durationMs: Math.round(durationMs * 0.85),
            curve: 'exponential'  // Accelerating slowdown (like turntable friction)
        },
        scratchA: null
    }
}

/**
 * Filter Sweep — DJ filter knob + tremolo flutter.
 *
 * Simulates the classic "filter sweep" technique where the DJ moves
 * a resonant filter through the frequency spectrum.  Lowpass narrows
 * the sound while a phaser adds movement and a slow tremolo creates
 * a pulsing gate effect.
 *
 * The tremolo syncs loosely to the beat for a rhythmic, hypnotic fade.
 */
function filterSweep(durationMs: number, bpm: number | null = null): AutoMixDecision {
    const ramp = Math.round(durationMs * 0.85)
    const roomSize = adaptiveRoomSize(bpm, 0.45)
    const damping = adaptiveDamping(bpm, 0.55)

    // Tremolo frequency: beat-synced quarter note pulse (or 2 Hz fallback)
    const tremoloFreq = bpm && bpm > 0
        ? Math.round(Math.max(0.5, Math.min(4.0, bpm / 60)) * 100) / 100
        : 2.0

    return {
        transition: 'filter_sweep',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 80, durationMs },
        highpassA: null,
        echoA: null,  // Intentionally dry — the sweep is the star
        reverbA: { mix: 0.12, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.5,        // Slow sweep through the spectrum
            depth: 0.5,
            mix: 0.18,
            rampMs: ramp
        },
        tremoloA: {
            frequency: tremoloFreq,
            depth: 0.15,      // Subtle pulsing, not hard-gating
            rampMs: ramp
        },
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.07,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Reverb Wash — Track A dissolves into a pure reverberant shimmer.
 *
 * No lowpass, no highpass.  Instead the track's dry signal fades while
 * massive cathedral reverb + echo flood the stereo field.  The effect
 * is a luminous wash of harmonics that slowly gives way to Track B.
 *
 * Think of it as the "reverb throw" technique — DJs cut the dry signal
 * and let the reverb tail ring out while the new track drops in.
 */
function reverbWash(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Atmospheric shimmer — give it extra time to breathe
    durationMs = Math.round(durationMs * 1.15)
    const ramp = Math.round(durationMs * 0.75)
    // Dotted quarter note for spacious, musical tail
    const echoDelay = beatSyncedDelay(bpm, 1.5, 600)
    const echoFeedback = adaptiveFeedback(bpm, 0.42)
    const roomSize = adaptiveRoomSize(bpm, 0.95)
    const damping = adaptiveDamping(bpm, 0.18)  // Very low damping = long, bright tail

    return {
        transition: 'reverb_wash',
        transitionDurationMs: durationMs,
        lowpassA: null,
        highpassA: null,
        echoA: {
            delay: echoDelay,
            mix: 0.28,
            feedback: echoFeedback,
            rampMs: ramp
        },
        reverbA: {
            mix: 0.30,       // Wet reverb wash, tamed to avoid clipping
            roomSize,
            damping,
            rampMs: ramp
        },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.07,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: {
            delay: beatSyncedDelay(bpm, 0.75, 350),
            mix: 0.14,
            feedback: 0.30
        },
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Vinyl Brake — authentic turntable power-down using TapeTransformer.
 *
 * Uses the real TapeTransformer (Cubic Hermite Spline resampling) for
 * an authentic pitch-dropping vinyl stop effect.  The record slows from
 * 1.0× to near-zero with the characteristic descending pitch.
 *
 * Paired with light lowpass + reverb to soften the tail.  No echo or
 * phaser — the tape stop effect speaks for itself.
 *
 * Best for: genre changes, energy shifts, dramatic endings.
 */
function vinylBrake(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Physical effects are inherently shorter — dramatic, quick
    durationMs = Math.round(durationMs * 0.70)
    const ramp = Math.round(durationMs * 0.80)
    const roomSize = adaptiveRoomSize(bpm, 0.55)
    const damping = adaptiveDamping(bpm, 0.40)

    return {
        transition: 'vinyl_brake',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 50, durationMs },
        highpassA: null,
        echoA: null,
        reverbA: { mix: 0.16, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.06,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: {
            durationMs: Math.round(durationMs * 0.90),
            curve: 'sinusoidal'  // Gradual at first, accelerates (natural brake feel)
        },
        scratchA: null
    }
}

/**
 * Backspin — DJ backspin using ScratchTransformer.
 *
 * Simulates a DJ grabbing the record and spinning it backwards.
 * The ScratchTransformer rapidly reverses playback direction with
 * physically-modelled speed curves (cross-zero fast, high-speed
 * reverse, slow to stop).
 *
 * Sounds dramatic and unmistakable — the classic "rewind" effect.
 * Best for: hype transitions, genre switches, party mixes.
 */
function backspinTransition(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Physical effects are inherently shorter — dramatic, quick
    durationMs = Math.round(durationMs * 0.60)
    const ramp = Math.round(durationMs * 0.70)
    const echoDelay = beatSyncedDelay(bpm, 0.5, 350)
    const echoFeedback = adaptiveFeedback(bpm, 0.35)

    return {
        transition: 'backspin',
        transitionDurationMs: durationMs,
        lowpassA: null,
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.16, feedback: echoFeedback, rampMs: ramp },
        reverbA: null,
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.07,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: {
            durationMs: Math.round(durationMs * 0.75),
            style: 'backspin'
        }
    }
}

/**
 * Scratch Out — DJ friction stop using ScratchTransformer ``wash`` style.
 *
 * The wash style decelerates with a "friction bounce" at the end —
 * like a DJ lightly touching the record to slow it down with the
 * characteristic wobble before it stops.
 *
 * Paired with echo to catch the bouncing fragments.  Light and playful
 * compared to the heavier vinyl_brake or backspin.
 *
 * Best for: lighter genres, pop, funk, upbeat transitions.
 */
function scratchOut(durationMs: number, bpm: number | null = null): AutoMixDecision {
    // Physical effects are inherently shorter — dramatic, quick
    durationMs = Math.round(durationMs * 0.70)
    const ramp = Math.round(durationMs * 0.75)
    const echoDelay = beatSyncedDelay(bpm, 0.75, 400)
    const echoFeedback = adaptiveFeedback(bpm, 0.30)
    const roomSize = adaptiveRoomSize(bpm, 0.40)
    const damping = adaptiveDamping(bpm, 0.50)

    return {
        transition: 'scratch_out',
        transitionDurationMs: durationMs,
        lowpassA: { smoothing: 35, durationMs },
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.16, feedback: echoFeedback, rampMs: ramp },
        reverbA: { mix: 0.12, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: null,
        tremoloA: null,
        highpassSweepB: true,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.08,
        highpassSweepAlpha: 0.06,
        incomingGainMultiplier: null,
        timescaleA: null,
        stereoPanB: false,
        stereoPanA: false,
        echoB: null,
        tapeStopA: null,
        scratchA: {
            durationMs: Math.round(durationMs * 0.80),
            style: 'wash'
        }
    }
}

/**
 * Harmonic Weave — fusion premium with staged harmonic reveal.
 *
 * Track A narrows gently while preserving groove. Track B enters with
 * instrumental bed first and opens to full spectrum quickly.
 */
function harmonicWeave(durationMs: number, bpm: number | null = null): AutoMixDecision {
    durationMs = Math.round(durationMs * 1.08)
    const ramp = Math.round(durationMs * 0.90)
    const roomSize = adaptiveRoomSize(bpm, 0.58)
    const damping = adaptiveDamping(bpm, 0.45)

    return {
        transition: 'harmonic_weave',
        transitionDurationMs: durationMs,
        lowpassA: null,
        highpassA: null,
        echoA: {
            delay: beatSyncedDelay(bpm, 0.5, 260),
            mix: 0.09,
            feedback: adaptiveFeedback(bpm, 0.19),
            rampMs: ramp
        },
        reverbA: { mix: 0.12, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.32,
            depth: 0.30,
            mix: 0.09,
            rampMs: ramp
        },
        tremoloA: null,
        highpassSweepB: false,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.15,
        highpassSweepAlpha: 0.06,
        lowpassSweepCompletionRatio: 0.36,
        incomingGainMultiplier: 0.98,
        timescaleA: null,
        stereoPanB: true,
        incomingPanCompletionRatio: 0.50,
        stereoPanA: true,
        outgoingPanCompletionRatio: 0.52,
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 220),
            mix: 0.09,
            feedback: 0.16
        },
        incomingEchoCompletionRatio: 0.74,
        tapeStopA: null,
        scratchA: null
    }
}

/**
 * Fusion Morph — ultra-transparent atmospheric handoff.
 * 
 * One track grows into the other over a very long duration (10-15s).
 * Uses multi-band frequency crossover and spatial arrive choreography.
 */
function fusionMorph(durationMs: number, bpm: number | null = null): AutoMixDecision {
    const ramp = Math.round(durationMs * 0.90)
    const echoDelay = beatSyncedDelay(bpm, 0.5, 280)
    const roomSize = adaptiveRoomSize(bpm, 0.55)
    const damping = adaptiveDamping(bpm, 0.45)

    return {
        transition: 'fusion_morph',
        transitionDurationMs: durationMs,
        lowpassA: null,
        highpassA: null,
        echoA: { delay: echoDelay, mix: 0.06, feedback: 0.18, rampMs: ramp },
        reverbA: { mix: 0.08, roomSize, damping, rampMs: ramp },
        karaokeA: null,
        phaserA: {
            rate: 0.25,
            depth: 0.35,
            mix: 0.10,
            rampMs: ramp
        },
        tremoloA: null,
        highpassSweepB: false,
        lowpassSweepB: true,
        lowpassSweepAlpha: 0.14,
        highpassSweepAlpha: 0.06,
        lowpassSweepCompletionRatio: 0.34,
        incomingGainMultiplier: 0.98,
        timescaleA: null,
        stereoPanB: true,
        incomingPanCompletionRatio: 0.55,
        stereoPanA: true,
        outgoingPanCompletionRatio: 0.45,
        echoB: {
            delay: beatSyncedDelay(bpm, 0.5, 220),
            mix: 0.08,
            feedback: 0.15
        },
        incomingEchoCompletionRatio: 0.70,
        tapeStopA: null,
        scratchA: null
    }
}


// ── BPM-Adaptive Helpers ──────────────────────────────────────────

/**
 * Compute a beat-synced echo delay in milliseconds.
 *
 * @param bpm - Track BPM (null if unknown → returns `fallback`).
 * @param subdivision - Beat fraction (0.5 = eighth note, 0.75 = dotted eighth, 1.0 = quarter).
 * @param fallback - Default delay (ms) when BPM is unavailable.
 * @returns Delay in ms, clamped to 100–800 ms.
 */
function beatSyncedDelay(bpm: number | null, subdivision: number, fallback: number): number {
    if (!bpm || bpm <= 0) return fallback
    const delay = (60000 / bpm) * subdivision
    return Math.max(100, Math.min(800, Math.round(delay)))
}

/**
 * BPM-adaptive reverb room size — faster BPM → smaller, tighter room.
 * Scaled relative to 120 BPM baseline.
 */
function adaptiveRoomSize(bpm: number | null, base: number): number {
    if (!bpm || bpm <= 0) return Math.round(base * 100) / 100
    const raw = base * Math.pow(120 / bpm, 0.25)
    return Math.round(Math.max(0.35, Math.min(0.95, raw)) * 100) / 100
}

/**
 * BPM-adaptive reverb damping — faster BPM → more damping (shorter tail).
 * Scaled relative to 120 BPM baseline.
 */
function adaptiveDamping(bpm: number | null, base: number): number {
    if (!bpm || bpm <= 0) return Math.round(base * 100) / 100
    const raw = base * Math.pow(bpm / 120, 0.3)
    return Math.round(Math.max(0.15, Math.min(0.75, raw)) * 100) / 100
}

/**
 * BPM-adaptive echo feedback — slower BPM → more feedback (longer echo tail),
 * faster BPM → less feedback (prevents muddy rapid repetitions).
 * Scaled relative to 120 BPM baseline.
 */
function adaptiveFeedback(bpm: number | null, base: number): number {
    if (!bpm || bpm <= 0) return Math.round(Math.min(base, 0.45) * 100) / 100
    const raw = base * Math.pow(120 / bpm, 0.2)
    // Capped at 0.45 (was 0.60) — high feedback causes delay-line energy
    // to accumulate beyond Int16 range even with soft-limiting.  0.45 gives
    // audible repeats (~6 until inaudible) without runaway growth.
    return Math.round(Math.max(0.15, Math.min(0.45, raw)) * 100) / 100
}

/**
 * Find the best tempo match including half-time and double-time variants.
 *
 * Checks bpmB directly, bpmB×2 (half-time Track B), and bpmB÷2 (double-time).
 * Returns the variant that produces the speed ratio closest to 1.0.
 *
 * Example: Track A at 128 BPM, Track B at 63 BPM (hip-hop half-time)
 * → double-B gives 126/128 = 0.984 → 1.6 % diff → matches!
 */
function findBestBpmRatio(bpmA: number, bpmB: number): {
    speedRatio: number
    effectiveBpmB: number
    diff: number
    variant: string
} {
    const candidates = [
        { effectiveBpmB: bpmB, speedRatio: bpmB / bpmA, diff: Math.abs(1 - bpmB / bpmA), variant: 'direct' },
        { effectiveBpmB: bpmB * 2, speedRatio: (bpmB * 2) / bpmA, diff: Math.abs(1 - (bpmB * 2) / bpmA), variant: 'double-B' },
        { effectiveBpmB: bpmB / 2, speedRatio: (bpmB / 2) / bpmA, diff: Math.abs(1 - (bpmB / 2) / bpmA), variant: 'half-B' },
    ]
    return candidates.reduce((best, c) => c.diff < best.diff ? c : best)
}
