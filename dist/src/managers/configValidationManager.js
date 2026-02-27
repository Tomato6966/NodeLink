import { validateProperty } from "../utils.js";
const KNOWN_PLACEHOLDERS = new Set([
    'token_here',
    'your_token_here',
    'changeme',
    'change_me',
    'your-token-here',
    'insert_token_here',
    'placeholder',
    'PLACEHOLDER',
    'YOUR_TOKEN',
    'YOUR_API_KEY',
    'YOUR_CLIENT_ID',
    'YOUR_CLIENT_SECRET',
]);
const VALID_AUDIO_QUALITIES = new Set(['high', 'medium', 'low', 'lowest']);
const VALID_RESAMPLING_QUALITIES = new Set(['best', 'medium', 'fastest', 'zero', 'linear']);
const VALID_FADING_CURVES = new Set(['linear', 'exponential', 'sinusoidal']);
const VALID_FADING_TYPES = new Set(['volume', 'tape', 'both']);
const VALID_CROSSFADE_CURVES = new Set(['linear', 'sine', 'sinusoidal']);
const VALID_CROSSFADE_MODES = new Set(['preload', 'stream']);
const VALID_VOICE_FORMATS = new Set(['opus', 'pcm_s16le']);
const VALID_ROUTE_STRATEGIES = new Set(['RotateOnBan', 'RoundRobin', 'LoadBalance']);
const VALID_METRICS_AUTH_TYPES = new Set(['Bearer', 'Basic']);
export default class ConfigValidationManager {
    warnings = [];
    options;
    constructor(options) {
        this.options = options;
    }
    validate() {
        const errors = [];
        this.warnings = [];
        const domains = [
            () => this.validateServer(),
            () => this.validateCluster(),
            () => this.validateAudio(),
            () => this.validatePlayback(),
            () => this.validateSources(),
            () => this.validateSearch(),
            () => this.validateRoutePlanner(),
            () => this.validateRateLimit(),
            () => this.validateDosProtection(),
            () => this.validateLogging(),
            () => this.validateConnection(),
            () => this.validateVoiceReceive(),
            () => this.validateMix(),
            () => this.validateMetrics(),
        ];
        for (const validateDomain of domains) {
            try {
                validateDomain();
            }
            catch (err) {
                errors.push(err.message);
            }
        }
        if (this.warnings.length > 0) {
            const warningLines = this.warnings
                .map((w) => `  ⚠  ${w.path}: ${w.message}`)
                .join('\n');
            console.warn(`\n[NodeLink] Configuration warnings:\n${warningLines}\n`);
        }
        if (errors.length > 0) {
            throw new Error('Configuration errors:\n\n' + errors.join('\n\n'));
        }
    }
    validateServer() {
        const server = this.options.server;
        const rules = [
            this.nonEmptyStringRule('server.host', () => server?.host),
            this.intRangeRule('server.port', () => server?.port, 1, 65535),
            this.nonEmptyStringRule('server.password', () => server?.password),
            this.booleanRule('server.useBunServer', () => server?.useBunServer),
        ];
        this.runRules(rules);
    }
    validateCluster() {
        const cluster = this.options.cluster;
        if (!cluster)
            return;
        const workers = cluster.workers;
        const rules = [
            this.nonNegativeIntRule('cluster.workers', () => workers),
            this.nonNegativeIntRule('cluster.minWorkers', () => cluster.minWorkers),
            {
                path: 'cluster.minWorkers',
                expected: workers === 0
                    ? 'auto-scaled workers'
                    : `<= cluster.workers (${workers})`,
                get: () => cluster.minWorkers,
                validate: (v) => Number.isInteger(v) && (workers === 0 || v <= workers),
            },
            this.positiveIntRule('cluster.commandTimeout', () => cluster.commandTimeout),
            this.positiveIntRule('cluster.fastCommandTimeout', () => cluster.fastCommandTimeout),
            this.nonNegativeIntRule('cluster.maxRetries', () => cluster.maxRetries),
        ];
        if (cluster.hibernation) {
            rules.push(this.booleanRule('cluster.hibernation.enabled', () => cluster.hibernation.enabled), this.positiveIntRule('cluster.hibernation.timeoutMs', () => cluster.hibernation.timeoutMs));
        }
        const ssw = cluster.specializedSourceWorker;
        if (ssw) {
            rules.push(this.booleanRule('cluster.specializedSourceWorker.enabled', () => ssw.enabled), this.positiveIntRule('cluster.specializedSourceWorker.count', () => ssw.count), this.positiveIntRule('cluster.specializedSourceWorker.microWorkers', () => ssw.microWorkers), this.positiveIntRule('cluster.specializedSourceWorker.tasksPerWorker', () => ssw.tasksPerWorker), this.booleanRule('cluster.specializedSourceWorker.silentLogs', () => ssw.silentLogs));
        }
        const runtime = cluster.runtime;
        if (runtime) {
            rules.push(this.nonNegativeIntRule('cluster.runtime.workerMaxOldSpaceMb', () => runtime.workerMaxOldSpaceMb), this.nonNegativeIntRule('cluster.runtime.sourceWorkerMaxOldSpaceMb', () => runtime.sourceWorkerMaxOldSpaceMb), this.booleanRule('cluster.runtime.workerExposeGc', () => runtime.workerExposeGc), this.booleanRule('cluster.runtime.sourceWorkerExposeGc', () => runtime.sourceWorkerExposeGc));
        }
        const scaling = cluster.scaling;
        if (scaling) {
            rules.push(this.positiveIntRule('cluster.scaling.maxPlayersPerWorker', () => scaling.maxPlayersPerWorker), this.positiveIntRule('cluster.scaling.checkIntervalMs', () => scaling.checkIntervalMs), this.positiveIntRule('cluster.scaling.idleWorkerTimeoutMs', () => scaling.idleWorkerTimeoutMs), this.positiveIntRule('cluster.scaling.queueLengthScaleUpFactor', () => scaling.queueLengthScaleUpFactor), this.positiveIntRule('cluster.scaling.lagPenaltyLimit', () => scaling.lagPenaltyLimit), {
                path: 'cluster.scaling.targetUtilization',
                expected: 'number between 0 and 1 (exclusive)',
                get: () => scaling.targetUtilization,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1,
            }, {
                path: 'cluster.scaling.scaleUpThreshold',
                expected: 'number between 0 and 1 (exclusive)',
                get: () => scaling.scaleUpThreshold,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1,
            }, {
                path: 'cluster.scaling.scaleDownThreshold',
                expected: 'number between 0 and 1 (exclusive)',
                get: () => scaling.scaleDownThreshold,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1,
            }, {
                path: 'cluster.scaling.cpuPenaltyLimit',
                expected: 'number between 0 and 1 (exclusive)',
                get: () => scaling.cpuPenaltyLimit,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1,
            }, {
                path: 'cluster.scaling.scaleDownThreshold',
                expected: `number < cluster.scaling.scaleUpThreshold (${scaling.scaleUpThreshold})`,
                get: () => scaling.scaleDownThreshold,
                validate: (v) => typeof v === 'number' && v < scaling.scaleUpThreshold,
            }, {
                path: 'cluster.scaling.targetUtilization',
                expected: `number between scaleDownThreshold (${scaling.scaleDownThreshold}) and scaleUpThreshold (${scaling.scaleUpThreshold})`,
                get: () => scaling.targetUtilization,
                validate: (v) => typeof v === 'number' &&
                    v >= scaling.scaleDownThreshold &&
                    v <= scaling.scaleUpThreshold,
            });
        }
        const endpoint = cluster.endpoint;
        if (endpoint) {
            rules.push(this.booleanRule('cluster.endpoint.patchEnabled', () => endpoint.patchEnabled), this.booleanRule('cluster.endpoint.allowExternalPatch', () => endpoint.allowExternalPatch), this.nonEmptyStringRule('cluster.endpoint.code', () => endpoint.code));
        }
        this.runRules(rules);
    }
    validateAudio() {
        const audio = this.options.audio;
        const rules = [
            this.booleanRule('audio.loudnessNormalizer', () => audio?.loudnessNormalizer),
            this.nonNegativeIntRule('audio.lookaheadMs', () => audio?.lookaheadMs),
            {
                path: 'audio.gateThresholdLUFS',
                expected: 'number <= 0',
                get: () => audio?.gateThresholdLUFS,
                validate: (v) => typeof v === 'number' && v <= 0,
            },
            this.enumRule('audio.quality', () => audio?.quality, VALID_AUDIO_QUALITIES),
            this.enumRule('audio.resamplingQuality', () => audio?.resamplingQuality, VALID_RESAMPLING_QUALITIES),
        ];
        const fading = audio?.fading;
        if (fading) {
            rules.push(this.booleanRule('audio.fading.enabled', () => fading.enabled));
            const fadingEvents = ['trackStart', 'trackEnd', 'trackStop', 'seek', 'pause', 'resume'];
            for (const event of fadingEvents) {
                const ev = fading[event];
                if (!ev)
                    continue;
                rules.push(this.nonNegativeIntRule(`audio.fading.${event}.duration`, () => ev.duration), this.enumRule(`audio.fading.${event}.curve`, () => ev.curve, VALID_FADING_CURVES), this.enumRule(`audio.fading.${event}.type`, () => ev.type, VALID_FADING_TYPES));
            }
            const ducking = fading.ducking;
            if (ducking) {
                rules.push(this.booleanRule('audio.fading.ducking.enabled', () => ducking.enabled), this.nonNegativeIntRule('audio.fading.ducking.duration', () => ducking.duration), this.enumRule('audio.fading.ducking.curve', () => ducking.curve, VALID_FADING_CURVES), {
                    path: 'audio.fading.ducking.targetVolume',
                    expected: 'number between 0 and 1 (inclusive)',
                    get: () => ducking.targetVolume,
                    validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
                });
            }
        }
        const crossfade = audio?.crossfade;
        if (crossfade) {
            rules.push(this.booleanRule('audio.crossfade.enabled', () => crossfade.enabled), this.nonNegativeIntRule('audio.crossfade.duration', () => crossfade.duration), this.enumRule('audio.crossfade.curve', () => crossfade.curve, VALID_CROSSFADE_CURVES), this.enumRule('audio.crossfade.mode', () => crossfade.mode, VALID_CROSSFADE_MODES), this.nonNegativeIntRule('audio.crossfade.minBufferMs', () => crossfade.minBufferMs), this.nonNegativeIntRule('audio.crossfade.bufferMs', () => crossfade.bufferMs));
            if (crossfade.enabled) {
                rules.push({
                    path: 'audio.crossfade.duration',
                    expected: 'integer > 0 when audio.crossfade.enabled is true',
                    get: () => crossfade.duration,
                    validate: (v) => Number.isInteger(v) && v > 0,
                });
            }
            if (crossfade.bufferMs !== 0) {
                rules.push({
                    path: 'audio.crossfade.minBufferMs',
                    expected: `integer <= audio.crossfade.bufferMs (${crossfade.bufferMs})`,
                    get: () => crossfade.minBufferMs,
                    validate: (v) => Number.isInteger(v) && v <= crossfade.bufferMs,
                });
            }
        }
        this.runRules(rules);
    }
    validatePlayback() {
        const trackStuck = this.options.trackStuckThresholdMs;
        const rules = [
            this.intRangeRule('playerUpdateInterval', () => this.options.playerUpdateInterval, 250, 60000),
            this.positiveIntRule('statsUpdateInterval', () => this.options.statsUpdateInterval),
            this.positiveIntRule('eventTimeoutMs', () => this.options.eventTimeoutMs),
            {
                path: 'trackStuckThresholdMs',
                expected: 'integer >= 1000 (milliseconds)',
                get: () => trackStuck,
                validate: (v) => Number.isInteger(v) && v >= 1000,
            },
            {
                path: 'zombieThresholdMs',
                expected: `integer > trackStuckThresholdMs (${trackStuck})`,
                get: () => this.options.zombieThresholdMs,
                validate: (v) => Number.isInteger(v) && v > trackStuck,
            },
        ];
        this.runRules(rules);
    }
    validateSources() {
        const sources = this.options.sources;
        if (!sources)
            return;
        const rules = [];
        const { spotify, applemusic, tidal, jiosaavn, audius } = sources;
        if (spotify?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.spotify.playlistLoadLimit', () => spotify.playlistLoadLimit), this.nonNegativeIntRule('sources.spotify.albumLoadLimit', () => spotify.albumLoadLimit), this.positiveIntRule('sources.spotify.playlistPageLoadConcurrency', () => spotify.playlistPageLoadConcurrency), this.positiveIntRule('sources.spotify.albumPageLoadConcurrency', () => spotify.albumPageLoadConcurrency), {
                path: 'sources.spotify.credentials',
                expected: 'clientId and clientSecret must be set together',
                get: () => Boolean(spotify.clientId) === Boolean(spotify.clientSecret),
                validate: (v) => v === true,
            });
            if (spotify.externalAuthUrl) {
                rules.push(this.urlRule('sources.spotify.externalAuthUrl', () => spotify.externalAuthUrl));
            }
            this.warnIfPlaceholder('sources.spotify.clientId', spotify.clientId);
            this.warnIfPlaceholder('sources.spotify.clientSecret', spotify.clientSecret);
        }
        if (applemusic?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.applemusic.playlistLoadLimit', () => applemusic.playlistLoadLimit), this.nonNegativeIntRule('sources.applemusic.albumLoadLimit', () => applemusic.albumLoadLimit), this.positiveIntRule('sources.applemusic.playlistPageLoadConcurrency', () => applemusic.playlistPageLoadConcurrency), this.positiveIntRule('sources.applemusic.albumPageLoadConcurrency', () => applemusic.albumPageLoadConcurrency));
            this.warnIfPlaceholder('sources.applemusic.mediaApiToken', applemusic.mediaApiToken);
        }
        if (tidal?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.tidal.playlistLoadLimit', () => tidal.playlistLoadLimit), this.positiveIntRule('sources.tidal.playlistPageLoadConcurrency', () => tidal.playlistPageLoadConcurrency));
            if (tidal.token !== undefined) {
                rules.push({
                    path: 'sources.tidal.token',
                    expected: 'string (non-whitespace if provided)',
                    get: () => tidal.token,
                    validate: (v) => typeof v === 'string' && (v === '' || v.trim().length > 0),
                });
                this.warnIfPlaceholder('sources.tidal.token', tidal.token);
            }
        }
        if (audius?.enabled) {
            rules.push({
                path: 'sources.audius.appName',
                expected: 'string',
                get: () => audius.appName,
                validate: (v) => v === undefined || typeof v === 'string',
            }, {
                path: 'sources.audius.apiKey',
                expected: 'string',
                get: () => audius.apiKey,
                validate: (v) => v === undefined || typeof v === 'string',
            }, {
                path: 'sources.audius.apiSecret',
                expected: 'string',
                get: () => audius.apiSecret,
                validate: (v) => v === undefined || typeof v === 'string',
            }, this.nonNegativeIntRule('sources.audius.playlistLoadLimit', () => audius.playlistLoadLimit), this.nonNegativeIntRule('sources.audius.albumLoadLimit', () => audius.albumLoadLimit));
        }
        if (jiosaavn?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.jiosaavn.playlistLoadLimit', () => jiosaavn.playlistLoadLimit), this.nonNegativeIntRule('sources.jiosaavn.artistLoadLimit', () => jiosaavn.artistLoadLimit), {
                path: 'sources.jiosaavn.playlistLoadLimit',
                expected: `integer >= artistLoadLimit (${jiosaavn.artistLoadLimit})`,
                get: () => jiosaavn.playlistLoadLimit,
                validate: (v) => v >= jiosaavn.artistLoadLimit,
            });
        }
        const eternalbox = sources.eternalbox;
        if (eternalbox?.enabled) {
            rules.push(this.urlRule('sources.eternalbox.baseUrl', () => eternalbox.baseUrl), this.positiveIntRule('sources.eternalbox.searchResults', () => eternalbox.searchResults), this.positiveIntRule('sources.eternalbox.maxBranches', () => eternalbox.maxBranches), this.nonNegativeIntRule('sources.eternalbox.cacheMaxBytes', () => eternalbox.cacheMaxBytes), this.booleanRule('sources.eternalbox.enrichSpotify', () => eternalbox.enrichSpotify), this.booleanRule('sources.eternalbox.includeAnalysis', () => eternalbox.includeAnalysis), this.booleanRule('sources.eternalbox.eternalStream', () => eternalbox.eternalStream), this.booleanRule('sources.eternalbox.infiniteStream', () => eternalbox.infiniteStream), this.nonNegativeIntRule('sources.eternalbox.maxReconnects', () => eternalbox.maxReconnects), this.positiveIntRule('sources.eternalbox.reconnectDelayMs', () => eternalbox.reconnectDelayMs), {
                path: 'sources.eternalbox.minRandomBranchChance',
                expected: 'number between 0 and 1 (inclusive)',
                get: () => eternalbox.minRandomBranchChance,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
            }, {
                path: 'sources.eternalbox.maxRandomBranchChance',
                expected: 'number between 0 and 1 (inclusive)',
                get: () => eternalbox.maxRandomBranchChance,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
            }, {
                path: 'sources.eternalbox.minRandomBranchChance',
                expected: `number <= maxRandomBranchChance (${eternalbox.maxRandomBranchChance})`,
                get: () => eternalbox.minRandomBranchChance,
                validate: (v) => v <= eternalbox.maxRandomBranchChance,
            });
        }
        const youtube = sources.youtube;
        if (youtube?.enabled) {
            if (youtube.cipher?.url !== undefined) {
                rules.push(this.urlRule('sources.youtube.cipher.url', () => youtube.cipher.url));
            }
        }
        const pipertts = sources.pipertts;
        if (pipertts?.enabled) {
            rules.push(this.urlRule('sources.pipertts.url', () => pipertts.url));
        }
        const pandora = sources.pandora;
        if (pandora?.enabled && pandora.remoteTokenUrl) {
            rules.push(this.urlRule('sources.pandora.remoteTokenUrl', () => pandora.remoteTokenUrl));
        }
        const qobuz = sources.qobuz;
        if (qobuz?.enabled) {
            this.warnIfPlaceholder('sources.qobuz.userToken', qobuz.userToken);
        }
        const yandexmusic = sources.yandexmusic;
        if (yandexmusic?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.yandexmusic.artistLoadLimit', () => yandexmusic.artistLoadLimit), this.nonNegativeIntRule('sources.yandexmusic.albumLoadLimit', () => yandexmusic.albumLoadLimit), this.nonNegativeIntRule('sources.yandexmusic.playlistLoadLimit', () => yandexmusic.playlistLoadLimit));
            this.warnIfPlaceholder('sources.yandexmusic.accessToken', yandexmusic.accessToken);
        }
        const gaana = sources.gaana;
        if (gaana?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.gaana.playlistLoadLimit', () => gaana.playlistLoadLimit), this.nonNegativeIntRule('sources.gaana.albumLoadLimit', () => gaana.albumLoadLimit), this.nonNegativeIntRule('sources.gaana.artistLoadLimit', () => gaana.artistLoadLimit));
        }
        const flowery = sources.flowery;
        if (flowery?.enabled) {
            rules.push({
                path: 'sources.flowery.speed',
                expected: 'number > 0',
                get: () => flowery.speed,
                validate: (v) => typeof v === 'number' && v > 0,
            }, this.nonNegativeIntRule('sources.flowery.silence', () => flowery.silence), this.booleanRule('sources.flowery.translate', () => flowery.translate), this.booleanRule('sources.flowery.enforceConfig', () => flowery.enforceConfig));
        }
        const lazypytts = sources.lazypytts;
        if (lazypytts?.enabled) {
            rules.push(this.positiveIntRule('sources.lazypytts.maxTextLength', () => lazypytts.maxTextLength), this.booleanRule('sources.lazypytts.enforceConfig', () => lazypytts.enforceConfig));
        }
        this.runRules(rules);
    }
    validateSearch() {
        const rules = [
            this.intRangeRule('maxSearchResults', () => this.options.maxSearchResults, 1, 100),
            this.intRangeRule('maxAlbumPlaylistLength', () => this.options.maxAlbumPlaylistLength, 1, 500),
            {
                path: 'defaultSearchSource',
                expected: 'string or non-empty string[] of enabled source names in config.sources',
                get: () => this.options.defaultSearchSource,
                validate: (v) => {
                    const sources = this.options.sources;
                    if (!sources)
                        return false;
                    if (typeof v === 'string')
                        return sources[v]?.enabled === true;
                    if (Array.isArray(v)) {
                        if (v.length === 0)
                            return false;
                        return v.every((name) => typeof name === 'string' && sources[name]?.enabled === true);
                    }
                    return false;
                },
            },
        ];
        const unified = this.options.unifiedSearchSources;
        if (unified !== undefined) {
            rules.push({
                path: 'unifiedSearchSources',
                expected: 'non-empty string[] of enabled source names in config.sources',
                get: () => unified,
                validate: (v) => {
                    const sources = this.options.sources;
                    if (!sources || !Array.isArray(v) || v.length === 0)
                        return false;
                    return v.every((name) => typeof name === 'string' && sources[name]?.enabled === true);
                },
            });
        }
        this.runRules(rules);
    }
    validateRoutePlanner() {
        const routePlanner = this.options.routePlanner;
        if (!routePlanner)
            return;
        const rules = [
            this.enumRule('routePlanner.strategy', () => routePlanner.strategy, VALID_ROUTE_STRATEGIES),
        ];
        if (routePlanner.bannedIpCooldown !== undefined) {
            rules.push(this.positiveIntRule('routePlanner.bannedIpCooldown', () => routePlanner.bannedIpCooldown));
        }
        this.runRules(rules);
    }
    validateRateLimit() {
        const rateLimit = this.options.rateLimit;
        if (!rateLimit || rateLimit.enabled === false)
            return;
        const rules = [
            this.booleanRule('rateLimit.enabled', () => rateLimit.enabled),
        ];
        const sections = ['global', 'perIp', 'perUserId', 'perGuildId'];
        let prevSection = null;
        let prevCfg = null;
        for (const section of sections) {
            const cfg = rateLimit[section];
            if (!cfg) {
                prevSection = section;
                prevCfg = null;
                continue;
            }
            rules.push(this.positiveIntRule(`rateLimit.${section}.maxRequests`, () => cfg.maxRequests), this.positiveIntRule(`rateLimit.${section}.timeWindowMs`, () => cfg.timeWindowMs));
            if (prevSection !== null && prevCfg !== null) {
                const capturedPrevSection = prevSection;
                const capturedPrevCfg = prevCfg;
                rules.push({
                    path: `rateLimit.${section}.maxRequests`,
                    expected: `integer <= rateLimit.${capturedPrevSection}.maxRequests (${capturedPrevCfg.maxRequests})`,
                    get: () => cfg.maxRequests,
                    validate: (v) => Number.isInteger(v) && v > 0 && v <= capturedPrevCfg.maxRequests,
                });
            }
            prevSection = section;
            prevCfg = cfg;
        }
        this.runRules(rules);
    }
    validateDosProtection() {
        const dos = this.options.dosProtection;
        if (!dos)
            return;
        const rules = [
            this.booleanRule('dosProtection.enabled', () => dos.enabled),
        ];
        if (dos.thresholds) {
            rules.push(this.positiveIntRule('dosProtection.thresholds.burstRequests', () => dos.thresholds.burstRequests), this.positiveIntRule('dosProtection.thresholds.timeWindowMs', () => dos.thresholds.timeWindowMs));
        }
        if (dos.mitigation) {
            rules.push(this.nonNegativeIntRule('dosProtection.mitigation.delayMs', () => dos.mitigation.delayMs), this.positiveIntRule('dosProtection.mitigation.blockDurationMs', () => dos.mitigation.blockDurationMs));
        }
        this.runRules(rules);
    }
    validateLogging() {
        const logging = this.options.logging;
        if (!logging)
            return;
        const rules = [];
        if (logging.file) {
            rules.push(this.booleanRule('logging.file.enabled', () => logging.file.enabled), this.positiveIntRule('logging.file.ttlDays', () => logging.file.ttlDays));
            if (logging.file.enabled) {
                rules.push(this.nonEmptyStringRule('logging.file.path', () => logging.file.path));
            }
        }
        if (logging.debug) {
            const debugFields = [
                'all', 'request', 'session', 'player', 'filters',
                'sources', 'lyrics', 'youtube', 'youtube-cipher', 'sabr', 'potoken',
            ];
            for (const field of debugFields) {
                if (logging.debug[field] !== undefined) {
                    rules.push(this.booleanRule(`logging.debug.${field}`, () => logging.debug[field]));
                }
            }
        }
        this.runRules(rules);
    }
    validateConnection() {
        const connection = this.options.connection;
        if (!connection)
            return;
        const rules = [
            this.booleanRule('connection.logAllChecks', () => connection.logAllChecks),
            this.positiveIntRule('connection.interval', () => connection.interval),
            this.positiveIntRule('connection.timeout', () => connection.timeout),
        ];
        if (connection.thresholds) {
            rules.push({
                path: 'connection.thresholds.bad',
                expected: 'number > 0 (Mbps)',
                get: () => connection.thresholds.bad,
                validate: (v) => typeof v === 'number' && v > 0,
            }, {
                path: 'connection.thresholds.average',
                expected: 'number > 0 (Mbps)',
                get: () => connection.thresholds.average,
                validate: (v) => typeof v === 'number' && v > 0,
            }, {
                path: 'connection.thresholds.bad',
                expected: `number < connection.thresholds.average (${connection.thresholds.average})`,
                get: () => connection.thresholds.bad,
                validate: (v) => v < connection.thresholds.average,
            });
        }
        this.runRules(rules);
    }
    validateVoiceReceive() {
        const voiceReceive = this.options.voiceReceive;
        if (!voiceReceive)
            return;
        const rules = [
            this.booleanRule('voiceReceive.enabled', () => voiceReceive.enabled),
            this.enumRule('voiceReceive.format', () => voiceReceive.format, VALID_VOICE_FORMATS),
        ];
        this.runRules(rules);
    }
    validateMix() {
        const mix = this.options.mix;
        if (!mix)
            return;
        const rules = [
            this.booleanRule('mix.enabled', () => mix.enabled),
            this.positiveIntRule('mix.maxLayersMix', () => mix.maxLayersMix),
            this.booleanRule('mix.autoCleanup', () => mix.autoCleanup),
            {
                path: 'mix.defaultVolume',
                expected: 'number between 0 and 1 (inclusive)',
                get: () => mix.defaultVolume,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
            },
        ];
        this.runRules(rules);
    }
    validateMetrics() {
        const metrics = this.options.metrics;
        if (!metrics)
            return;
        const rules = [
            this.booleanRule('metrics.enabled', () => metrics.enabled),
        ];
        if (metrics.authorization) {
            rules.push(this.enumRule('metrics.authorization.type', () => metrics.authorization.type, VALID_METRICS_AUTH_TYPES));
        }
        this.runRules(rules);
    }
    runRules(rules) {
        const errors = [];
        for (const rule of rules) {
            try {
                validateProperty(rule.get(), rule.path, rule.expected, rule.validate);
            }
            catch (err) {
                errors.push(err.message);
            }
        }
        if (errors.length > 0) {
            throw new Error('Configuration errors:\n\n' + errors.join('\n\n'));
        }
    }
    warnIfPlaceholder(path, value) {
        if (typeof value === 'string' && KNOWN_PLACEHOLDERS.has(value)) {
            this.warnings.push({
                path,
                message: `Value "${value}" looks like an unfilled placeholder. The source may fail to authenticate at runtime.`,
            });
        }
    }
    nonNegativeIntRule(path, get) {
        return {
            path,
            expected: 'integer >= 0',
            get,
            validate: (v) => Number.isInteger(v) && v >= 0,
        };
    }
    positiveIntRule(path, get) {
        return {
            path,
            expected: 'integer > 0',
            get,
            validate: (v) => Number.isInteger(v) && v > 0,
        };
    }
    intRangeRule(path, get, min, max) {
        return {
            path,
            expected: `integer between ${min} and ${max}`,
            get,
            validate: (v) => Number.isInteger(v) && v >= min && v <= max,
        };
    }
    booleanRule(path, get) {
        return {
            path,
            expected: 'boolean',
            get,
            validate: (v) => typeof v === 'boolean',
        };
    }
    nonEmptyStringRule(path, get) {
        return {
            path,
            expected: 'non-empty string',
            get,
            validate: (v) => typeof v === 'string' && v.trim().length > 0,
        };
    }
    enumRule(path, get, allowed) {
        const label = [...allowed].join(', ');
        return {
            path,
            expected: `one of [${label}]`,
            get,
            validate: (v) => allowed.has(v),
        };
    }
    urlRule(path, get) {
        return {
            path,
            expected: 'valid http or https URL (e.g. https://example.com)',
            get,
            validate: (v) => {
                if (typeof v !== 'string' || v.trim().length === 0)
                    return false;
                try {
                    const url = new URL(v);
                    return url.protocol === 'http:' || url.protocol === 'https:';
                }
                catch {
                    return false;
                }
            },
        };
    }
}
