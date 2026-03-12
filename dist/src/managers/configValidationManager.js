const KNOWN_PLACEHOLDERS = new Set([
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
    'YOUR_CLIENT_SECRET'
]);
const VALID_AUDIO_QUALITIES = new Set(['high', 'medium', 'low', 'lowest']);
const VALID_RESAMPLING_QUALITIES = new Set([
    'best',
    'medium',
    'fastest',
    'zero',
    'linear'
]);
const VALID_FADING_CURVES = new Set([
    'linear',
    'exponential',
    'sinusoidal',
    'start',
    'wash',
    'stop',
    'random',
    'baby'
]);
const VALID_FADING_TYPES = new Set(['volume', 'tape', 'both', 'scratch']);
const VALID_CROSSFADE_CURVES = new Set(['linear', 'sine', 'sinusoidal']);
const VALID_CROSSFADE_MODES = new Set(['preload', 'stream']);
const VALID_VOICE_FORMATS = new Set(['opus', 'pcm_s16le']);
const VALID_ROUTE_STRATEGIES = new Set([
    'RotateOnBan',
    'RoundRobin',
    'LoadBalance'
]);
const VALID_METRICS_AUTH_TYPES = new Set(['Bearer', 'Basic']);
export default class ConfigValidationManager {
    options;
    warnings = [];
    constructor(options) {
        this.options = options;
    }
    validate() {
        this.warnings = [];
        const allRules = [
            ...this.validateServer(),
            ...this.validateCluster(),
            ...this.validateAudio(),
            ...this.validatePlayback(),
            ...this.validateSources(),
            ...this.validateSearch(),
            ...this.validateRoutePlanner(),
            ...this.validateRateLimit(),
            ...this.validateDosProtection(),
            ...this.validateLogging(),
            ...this.validateConnection(),
            ...this.validateVoiceReceive(),
            ...this.validateMix(),
            ...this.validateMetrics(),
            ...this.validateFilters()
        ];
        const errors = [];
        for (const rule of allRules) {
            if (!rule.validate(rule.value)) {
                errors.push(`Configuration error:\n` +
                    `- Property: ${rule.path}\n` +
                    `- Received: ${JSON.stringify(rule.value)}\n` +
                    `- Expected: ${rule.expected}`);
            }
        }
        if (this.warnings.length > 0) {
            const warningLines = this.warnings
                .map((w) => `  ⚠  ${w.path}: ${w.message}`)
                .join('\n');
            console.warn(`\n[NodeLink] Configuration warnings:\n${warningLines}\n`);
        }
        if (errors.length > 0) {
            throw new Error(`Configuration errors:\n\n${errors.join('\n\n')}`);
        }
    }
    validateServer() {
        const server = this.options.server;
        return [
            this.nonEmptyStringRule('server.host', server?.host),
            this.intRangeRule('server.port', server?.port, 1, 65535),
            this.nonEmptyStringRule('server.password', server?.password),
            this.booleanRule('server.useBunServer', server?.useBunServer)
        ];
    }
    validateCluster() {
        const cluster = this.options.cluster;
        if (!cluster)
            return [];
        const workers = cluster.workers;
        const rules = [
            this.booleanRule('cluster.enabled', cluster.enabled)
        ];
        if (typeof cluster.enabled !== 'boolean')
            return rules;
        if (cluster.enabled === false)
            return rules;
        rules.push(this.nonNegativeIntRule('cluster.workers', workers), this.nonNegativeIntRule('cluster.minWorkers', cluster.minWorkers), {
            path: 'cluster.minWorkers',
            expected: workers === 0
                ? 'integer (auto-scaled workers, any value allowed)'
                : `integer <= cluster.workers (${workers})`,
            value: cluster.minWorkers,
            validate: (v) => Number.isInteger(v) &&
                Number.isInteger(workers) &&
                (workers === 0 || v <= workers)
        }, this.positiveIntRule('cluster.commandTimeout', cluster.commandTimeout), this.positiveIntRule('cluster.fastCommandTimeout', cluster.fastCommandTimeout), this.nonNegativeIntRule('cluster.maxRetries', cluster.maxRetries));
        if (cluster.hibernation) {
            rules.push(this.booleanRule('cluster.hibernation.enabled', cluster.hibernation.enabled), this.positiveIntRule('cluster.hibernation.timeoutMs', cluster.hibernation.timeoutMs));
        }
        const ssw = cluster.specializedSourceWorker;
        if (ssw) {
            rules.push(this.booleanRule('cluster.specializedSourceWorker.enabled', ssw.enabled), this.positiveIntRule('cluster.specializedSourceWorker.count', ssw.count), this.positiveIntRule('cluster.specializedSourceWorker.microWorkers', ssw.microWorkers), this.positiveIntRule('cluster.specializedSourceWorker.tasksPerWorker', ssw.tasksPerWorker), this.booleanRule('cluster.specializedSourceWorker.silentLogs', ssw.silentLogs));
        }
        const runtime = cluster.runtime;
        if (runtime) {
            rules.push(this.nonNegativeIntRule('cluster.runtime.workerMaxOldSpaceMb', runtime.workerMaxOldSpaceMb), this.nonNegativeIntRule('cluster.runtime.sourceWorkerMaxOldSpaceMb', runtime.sourceWorkerMaxOldSpaceMb), this.booleanRule('cluster.runtime.workerExposeGc', runtime.workerExposeGc), this.booleanRule('cluster.runtime.sourceWorkerExposeGc', runtime.sourceWorkerExposeGc), this.stringArrayRule('cluster.runtime.workerExecArgv', runtime.workerExecArgv), this.stringArrayRule('cluster.runtime.sourceWorkerExecArgv', runtime.sourceWorkerExecArgv));
        }
        const scaling = cluster.scaling;
        if (scaling) {
            rules.push(this.positiveIntRule('cluster.scaling.maxPlayersPerWorker', scaling.maxPlayersPerWorker), this.positiveIntRule('cluster.scaling.checkIntervalMs', scaling.checkIntervalMs), this.positiveIntRule('cluster.scaling.idleWorkerTimeoutMs', scaling.idleWorkerTimeoutMs), this.positiveIntRule('cluster.scaling.queueLengthScaleUpFactor', scaling.queueLengthScaleUpFactor), this.positiveIntRule('cluster.scaling.lagPenaltyLimit', scaling.lagPenaltyLimit), {
                path: 'cluster.scaling.scaleUpThreshold',
                expected: 'number between 0 and 1 (exclusive)',
                value: scaling.scaleUpThreshold,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1
            }, {
                path: 'cluster.scaling.cpuPenaltyLimit',
                expected: 'number between 0 and 1 (exclusive)',
                value: scaling.cpuPenaltyLimit,
                validate: (v) => typeof v === 'number' && v > 0 && v < 1
            }, this.floatMustBeBelow('cluster.scaling.scaleDownThreshold', scaling.scaleDownThreshold, scaling.scaleUpThreshold, 'cluster.scaling.scaleUpThreshold'), {
                path: 'cluster.scaling.targetUtilization',
                expected: `number between scaleDownThreshold (${scaling.scaleDownThreshold}) and scaleUpThreshold (${scaling.scaleUpThreshold})`,
                value: scaling.targetUtilization,
                validate: (v) => typeof scaling.scaleDownThreshold === 'number' &&
                    typeof scaling.scaleUpThreshold === 'number' &&
                    typeof v === 'number' &&
                    v >= scaling.scaleDownThreshold &&
                    v <= scaling.scaleUpThreshold
            });
        }
        const endpoint = cluster.endpoint;
        if (endpoint) {
            rules.push(this.booleanRule('cluster.endpoint.patchEnabled', endpoint.patchEnabled), this.booleanRule('cluster.endpoint.allowExternalPatch', endpoint.allowExternalPatch), this.nonEmptyStringRule('cluster.endpoint.code', endpoint.code));
        }
        return rules;
    }
    validateAudio() {
        const audio = this.options.audio;
        const rules = [
            this.booleanRule('audio.loudnessNormalizer', audio?.loudnessNormalizer),
            this.nonNegativeIntRule('audio.lookaheadMs', audio?.lookaheadMs),
            {
                path: 'audio.gateThresholdLUFS',
                expected: 'number <= 0',
                value: audio?.gateThresholdLUFS,
                validate: (v) => typeof v === 'number' && v <= 0
            },
            this.enumRule('audio.quality', audio?.quality, VALID_AUDIO_QUALITIES),
            this.enumRule('audio.resamplingQuality', audio?.resamplingQuality, VALID_RESAMPLING_QUALITIES)
        ];
        const fading = audio?.fading;
        if (fading) {
            rules.push(this.booleanRule('audio.fading.enabled', fading.enabled));
            const fadingEvents = [
                'trackStart',
                'trackEnd',
                'trackStop',
                'seek',
                'pause',
                'resume'
            ];
            for (const event of fadingEvents) {
                const ev = fading[event];
                if (!ev)
                    continue;
                rules.push(this.nonNegativeIntRule(`audio.fading.${event}.duration`, ev.duration), this.enumRule(`audio.fading.${event}.curve`, ev.curve, VALID_FADING_CURVES), this.enumRule(`audio.fading.${event}.type`, ev.type, VALID_FADING_TYPES));
            }
            const ducking = fading.ducking;
            if (ducking) {
                rules.push(this.booleanRule('audio.fading.ducking.enabled', ducking.enabled), this.nonNegativeIntRule('audio.fading.ducking.duration', ducking.duration), this.enumRule('audio.fading.ducking.curve', ducking.curve, VALID_FADING_CURVES), {
                    path: 'audio.fading.ducking.targetVolume',
                    expected: 'number between 0 and 1 (inclusive)',
                    value: ducking.targetVolume,
                    validate: (v) => typeof v === 'number' && v >= 0 && v <= 1
                });
            }
        }
        const crossfade = audio?.crossfade;
        if (crossfade) {
            rules.push(this.booleanRule('audio.crossfade.enabled', crossfade.enabled), this.nonNegativeIntRule('audio.crossfade.duration', crossfade.duration), this.enumRule('audio.crossfade.curve', crossfade.curve, VALID_CROSSFADE_CURVES), this.enumRule('audio.crossfade.mode', crossfade.mode, VALID_CROSSFADE_MODES), this.nonNegativeIntRule('audio.crossfade.minBufferMs', crossfade.minBufferMs), this.nonNegativeIntRule('audio.crossfade.bufferMs', crossfade.bufferMs));
            if (crossfade.bufferMs !== 0) {
                rules.push(this.intMustNotExceed('audio.crossfade.minBufferMs', crossfade.minBufferMs, crossfade.bufferMs, 'audio.crossfade.bufferMs'));
            }
            else if (crossfade.enabled && crossfade.duration > 0) {
                rules.push(this.intMustNotExceed('audio.crossfade.minBufferMs', crossfade.minBufferMs, crossfade.duration, 'audio.crossfade.duration'));
            }
        }
        return rules;
    }
    validatePlayback() {
        const trackStuck = this.options.trackStuckThresholdMs;
        return [
            this.intRangeRule('playerUpdateInterval', this.options.playerUpdateInterval, 250, 60000),
            this.positiveIntRule('statsUpdateInterval', this.options.statsUpdateInterval),
            this.positiveIntRule('eventTimeoutMs', this.options.eventTimeoutMs),
            this.booleanRule('enableHoloTracks', this.options.enableHoloTracks),
            this.booleanRule('enableTrackStreamEndpoint', this.options.enableTrackStreamEndpoint),
            this.booleanRule('enableLoadStreamEndpoint', this.options.enableLoadStreamEndpoint),
            this.booleanRule('resolveExternalLinks', this.options.resolveExternalLinks),
            this.booleanRule('fetchChannelInfo', this.options.fetchChannelInfo),
            {
                path: 'trackStuckThresholdMs',
                expected: 'integer >= 1000 (milliseconds)',
                value: trackStuck,
                validate: (v) => Number.isInteger(v) && v >= 1000
            },
            this.intMustExceed('zombieThresholdMs', this.options.zombieThresholdMs, trackStuck, 'trackStuckThresholdMs')
        ];
    }
    validateSources() {
        const sources = this.options.sources;
        if (!sources)
            return [];
        const rules = [];
        const allSources = [
            'youtube',
            'soundcloud',
            'spotify',
            'tidal',
            'applemusic',
            'audius',
            'jiosaavn',
            'eternalbox',
            'pipertts',
            'pandora',
            'yandexmusic',
            'gaana',
            'flowery',
            'lazypytts',
            'qobuz',
            'iheartradio',
            'vkmusic',
            'amazonmusic',
            'bluesky',
            'anghami',
            'rss',
            'songlink',
            'mixcloud',
            'audiomack',
            'deezer',
            'bandcamp',
            'local',
            'http',
            'vimeo',
            'telegram',
            'shazam',
            'bilibili',
            'genius',
            'pinterest',
            'google-tts',
            'instagram',
            'kwai',
            'twitch',
            'nicovideo',
            'reddit',
            'tumblr',
            'twitter',
            'lastfm',
            'letrasmus'
        ];
        for (const name of allSources) {
            if (sources[name] !== undefined) {
                rules.push(this.booleanRule(`sources.${name}.enabled`, sources[name].enabled));
            }
        }
        rules.push(...this.validateSourceSpotify(sources.spotify), ...this.validateSourceAppleMusic(sources.applemusic), ...this.validateSourceTidal(sources.tidal), ...this.validateSourceAudius(sources.audius), ...this.validateSourceJiosaavn(sources.jiosaavn), ...this.validateSourceEternalbox(sources.eternalbox), ...this.validateSourceYoutube(sources.youtube), ...this.validateSourcePipertts(sources.pipertts), ...this.validateSourcePandora(sources.pandora), ...this.validateSourceQobuz(sources.qobuz), ...this.validateSourceLastfm(sources.lastfm), ...this.validateSourceBilibili(sources.bilibili), ...this.validateSourceYandexMusic(sources.yandexmusic), ...this.validateSourceGaana(sources.gaana), ...this.validateSourceFlowery(sources.flowery), ...this.validateSourceLazypytts(sources.lazypytts));
        return rules;
    }
    validateSourceSpotify(spotify) {
        if (!spotify?.enabled)
            return [];
        const rules = [
            this.nonNegativeIntRule('sources.spotify.playlistLoadLimit', spotify.playlistLoadLimit),
            this.nonNegativeIntRule('sources.spotify.albumLoadLimit', spotify.albumLoadLimit),
            this.positiveIntRule('sources.spotify.playlistPageLoadConcurrency', spotify.playlistPageLoadConcurrency),
            this.positiveIntRule('sources.spotify.albumPageLoadConcurrency', spotify.albumPageLoadConcurrency),
            {
                path: 'sources.spotify.clientId',
                expected: 'non-empty string when sources.spotify.clientSecret is set',
                value: spotify.clientId,
                validate: (v) => !spotify.clientSecret ||
                    (typeof v === 'string' && v.trim().length > 0)
            },
            {
                path: 'sources.spotify.clientSecret',
                expected: 'non-empty string when sources.spotify.clientId is set',
                value: spotify.clientSecret,
                validate: (v) => !spotify.clientId || (typeof v === 'string' && v.trim().length > 0)
            },
            this.placeholderWarningRule('sources.spotify.clientId', spotify.clientId),
            this.placeholderWarningRule('sources.spotify.clientSecret', spotify.clientSecret)
        ];
        if (spotify.externalAuthUrl) {
            rules.push(this.urlRule('sources.spotify.externalAuthUrl', spotify.externalAuthUrl));
        }
        return rules;
    }
    validateSourceAppleMusic(applemusic) {
        if (!applemusic?.enabled)
            return [];
        return [
            this.nonNegativeIntRule('sources.applemusic.playlistLoadLimit', applemusic.playlistLoadLimit),
            this.nonNegativeIntRule('sources.applemusic.albumLoadLimit', applemusic.albumLoadLimit),
            this.positiveIntRule('sources.applemusic.playlistPageLoadConcurrency', applemusic.playlistPageLoadConcurrency),
            this.positiveIntRule('sources.applemusic.albumPageLoadConcurrency', applemusic.albumPageLoadConcurrency),
            this.placeholderWarningRule('sources.applemusic.mediaApiToken', applemusic.mediaApiToken, ['token_here'])
        ];
    }
    validateSourceTidal(tidal) {
        if (!tidal?.enabled)
            return [];
        const rules = [
            this.nonNegativeIntRule('sources.tidal.playlistLoadLimit', tidal.playlistLoadLimit),
            this.positiveIntRule('sources.tidal.playlistPageLoadConcurrency', tidal.playlistPageLoadConcurrency)
        ];
        if (tidal.token !== undefined) {
            rules.push({
                path: 'sources.tidal.token',
                expected: 'string (non-whitespace if provided)',
                value: tidal.token,
                validate: (v) => typeof v === 'string' && (v === '' || v.trim().length > 0)
            }, this.placeholderWarningRule('sources.tidal.token', tidal.token, [
                'token_here'
            ]));
        }
        return rules;
    }
    validateSourceAudius(audius) {
        if (!audius?.enabled)
            return [];
        return [
            {
                path: 'sources.audius.appName',
                expected: 'string',
                value: audius.appName,
                validate: (v) => v === undefined || typeof v === 'string'
            },
            {
                path: 'sources.audius.apiKey',
                expected: 'string',
                value: audius.apiKey,
                validate: (v) => v === undefined || typeof v === 'string'
            },
            {
                path: 'sources.audius.apiSecret',
                expected: 'string',
                value: audius.apiSecret,
                validate: (v) => v === undefined || typeof v === 'string'
            },
            this.nonNegativeIntRule('sources.audius.playlistLoadLimit', audius.playlistLoadLimit),
            this.nonNegativeIntRule('sources.audius.albumLoadLimit', audius.albumLoadLimit),
            this.placeholderWarningRule('sources.audius.apiKey', audius.apiKey),
            this.placeholderWarningRule('sources.audius.apiSecret', audius.apiSecret)
        ];
    }
    validateSourceJiosaavn(jiosaavn) {
        if (!jiosaavn?.enabled)
            return [];
        return [
            this.nonNegativeIntRule('sources.jiosaavn.playlistLoadLimit', jiosaavn.playlistLoadLimit),
            this.nonNegativeIntRule('sources.jiosaavn.artistLoadLimit', jiosaavn.artistLoadLimit)
        ];
    }
    validateSourceEternalbox(eternalbox) {
        if (!eternalbox?.enabled)
            return [];
        return [
            this.urlRule('sources.eternalbox.baseUrl', eternalbox.baseUrl),
            this.positiveIntRule('sources.eternalbox.searchResults', eternalbox.searchResults),
            this.positiveIntRule('sources.eternalbox.maxBranches', eternalbox.maxBranches),
            this.nonNegativeIntRule('sources.eternalbox.cacheMaxBytes', eternalbox.cacheMaxBytes),
            this.booleanRule('sources.eternalbox.enrichSpotify', eternalbox.enrichSpotify),
            this.booleanRule('sources.eternalbox.includeAnalysis', eternalbox.includeAnalysis),
            this.booleanRule('sources.eternalbox.eternalStream', eternalbox.eternalStream),
            this.booleanRule('sources.eternalbox.infiniteStream', eternalbox.infiniteStream),
            this.nonNegativeIntRule('sources.eternalbox.maxReconnects', eternalbox.maxReconnects),
            this.positiveIntRule('sources.eternalbox.reconnectDelayMs', eternalbox.reconnectDelayMs),
            {
                path: 'sources.eternalbox.minRandomBranchChance',
                expected: 'number between 0 and 1 (inclusive)',
                value: eternalbox.minRandomBranchChance,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1
            },
            {
                path: 'sources.eternalbox.maxRandomBranchChance',
                expected: 'number between 0 and 1 (inclusive)',
                value: eternalbox.maxRandomBranchChance,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1
            },
            this.floatMustNotExceed('sources.eternalbox.minRandomBranchChance', eternalbox.minRandomBranchChance, eternalbox.maxRandomBranchChance, 'sources.eternalbox.maxRandomBranchChance')
        ];
    }
    validateSourceYoutube(youtube) {
        if (!youtube?.enabled || youtube.cipher?.url === undefined)
            return [];
        return [this.urlRule('sources.youtube.cipher.url', youtube.cipher.url)];
    }
    validateSourcePipertts(pipertts) {
        if (!pipertts?.enabled)
            return [];
        return [this.urlRule('sources.pipertts.url', pipertts.url)];
    }
    validateSourcePandora(pandora) {
        if (!pandora?.enabled || !pandora.remoteTokenUrl)
            return [];
        return [
            this.urlRule('sources.pandora.remoteTokenUrl', pandora.remoteTokenUrl)
        ];
    }
    validateSourceQobuz(qobuz) {
        if (!qobuz?.enabled)
            return [];
        return [
            this.placeholderWarningRule('sources.qobuz.userToken', qobuz.userToken)
        ];
    }
    validateSourceLastfm(lastfm) {
        if (!lastfm?.enabled)
            return [];
        return [this.placeholderWarningRule('sources.lastfm.apiKey', lastfm.apiKey)];
    }
    validateSourceBilibili(bilibili) {
        if (!bilibili?.enabled)
            return [];
        return [
            this.placeholderWarningRule('sources.bilibili.sessdata', bilibili.sessdata)
        ];
    }
    validateSourceYandexMusic(yandexmusic) {
        if (!yandexmusic?.enabled)
            return [];
        return [
            this.nonNegativeIntRule('sources.yandexmusic.artistLoadLimit', yandexmusic.artistLoadLimit),
            this.nonNegativeIntRule('sources.yandexmusic.albumLoadLimit', yandexmusic.albumLoadLimit),
            this.nonNegativeIntRule('sources.yandexmusic.playlistLoadLimit', yandexmusic.playlistLoadLimit),
            this.placeholderWarningRule('sources.yandexmusic.accessToken', yandexmusic.accessToken)
        ];
    }
    validateSourceGaana(gaana) {
        if (!gaana?.enabled)
            return [];
        return [
            this.nonNegativeIntRule('sources.gaana.playlistLoadLimit', gaana.playlistLoadLimit),
            this.nonNegativeIntRule('sources.gaana.albumLoadLimit', gaana.albumLoadLimit),
            this.nonNegativeIntRule('sources.gaana.artistLoadLimit', gaana.artistLoadLimit)
        ];
    }
    validateSourceFlowery(flowery) {
        if (!flowery?.enabled)
            return [];
        return [
            this.positiveNumberRule('sources.flowery.speed', flowery.speed),
            this.nonNegativeIntRule('sources.flowery.silence', flowery.silence),
            this.booleanRule('sources.flowery.translate', flowery.translate),
            this.booleanRule('sources.flowery.enforceConfig', flowery.enforceConfig)
        ];
    }
    validateSourceLazypytts(lazypytts) {
        if (!lazypytts?.enabled)
            return [];
        return [
            this.positiveIntRule('sources.lazypytts.maxTextLength', lazypytts.maxTextLength),
            this.booleanRule('sources.lazypytts.enforceConfig', lazypytts.enforceConfig)
        ];
    }
    validateSearch() {
        const rules = [
            this.intRangeRule('maxSearchResults', this.options.maxSearchResults, 1, 100),
            this.intRangeRule('maxAlbumPlaylistLength', this.options.maxAlbumPlaylistLength, 1, 500),
            {
                path: 'defaultSearchSource',
                expected: 'string or non-empty string[] of enabled source names in config.sources',
                value: this.options.defaultSearchSource,
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
                }
            }
        ];
        const unified = this.options.unifiedSearchSources;
        if (unified !== undefined) {
            rules.push({
                path: 'unifiedSearchSources',
                expected: 'non-empty string[] of enabled source names in config.sources',
                value: unified,
                validate: (v) => {
                    const sources = this.options.sources;
                    if (!sources || !Array.isArray(v) || v.length === 0)
                        return false;
                    return v.every((name) => typeof name === 'string' && sources[name]?.enabled === true);
                }
            });
        }
        return rules;
    }
    validateRoutePlanner() {
        const routePlanner = this.options.routePlanner;
        if (!routePlanner)
            return [];
        const rules = [
            this.enumRule('routePlanner.strategy', routePlanner.strategy, VALID_ROUTE_STRATEGIES)
        ];
        if (routePlanner.bannedIpCooldown !== undefined) {
            rules.push(this.positiveIntRule('routePlanner.bannedIpCooldown', routePlanner.bannedIpCooldown));
        }
        return rules;
    }
    validateRateLimit() {
        const rateLimit = this.options.rateLimit;
        if (!rateLimit || rateLimit.enabled === false)
            return [];
        const rules = [
            this.booleanRule('rateLimit.enabled', rateLimit.enabled)
        ];
        const sections = ['global', 'perIp', 'perUserId', 'perGuildId'];
        let prevSection = null;
        let prevCfg = null;
        for (const section of sections) {
            const cfg = rateLimit[section];
            if (!cfg) {
                continue;
            }
            rules.push(this.positiveIntRule(`rateLimit.${section}.maxRequests`, cfg.maxRequests), this.positiveIntRule(`rateLimit.${section}.timeWindowMs`, cfg.timeWindowMs));
            if (prevSection !== null && prevCfg !== null) {
                const capturedPrevSection = prevSection;
                const capturedPrevCfg = prevCfg;
                rules.push(this.intMustNotExceed(`rateLimit.${section}.maxRequests`, cfg.maxRequests, capturedPrevCfg.maxRequests, `rateLimit.${capturedPrevSection}.maxRequests`), this.intMustNotExceed(`rateLimit.${section}.timeWindowMs`, cfg.timeWindowMs, capturedPrevCfg.timeWindowMs, `rateLimit.${capturedPrevSection}.timeWindowMs`));
            }
            prevSection = section;
            prevCfg = cfg;
        }
        return rules;
    }
    validateDosProtection() {
        const dos = this.options.dosProtection;
        if (!dos)
            return [];
        const rules = [
            this.booleanRule('dosProtection.enabled', dos.enabled)
        ];
        if (dos.thresholds) {
            rules.push(this.positiveIntRule('dosProtection.thresholds.burstRequests', dos.thresholds.burstRequests), this.positiveIntRule('dosProtection.thresholds.timeWindowMs', dos.thresholds.timeWindowMs));
        }
        if (dos.mitigation) {
            rules.push(this.nonNegativeIntRule('dosProtection.mitigation.delayMs', dos.mitigation.delayMs), this.positiveIntRule('dosProtection.mitigation.blockDurationMs', dos.mitigation.blockDurationMs));
        }
        return rules;
    }
    validateLogging() {
        const logging = this.options.logging;
        if (!logging)
            return [];
        const rules = [];
        if (logging.file) {
            rules.push(this.booleanRule('logging.file.enabled', logging.file.enabled), this.positiveIntRule('logging.file.ttlDays', logging.file.ttlDays));
            if (logging.file.enabled) {
                rules.push(this.nonEmptyStringRule('logging.file.path', logging.file.path));
            }
        }
        if (logging.debug) {
            const debugFields = [
                'all',
                'request',
                'session',
                'player',
                'filters',
                'sources',
                'lyrics',
                'youtube',
                'youtube-cipher',
                'sabr',
                'potoken'
            ];
            for (const field of debugFields) {
                if (logging.debug[field] !== undefined) {
                    rules.push(this.booleanRule(`logging.debug.${field}`, logging.debug[field]));
                }
            }
        }
        return rules;
    }
    validateConnection() {
        const connection = this.options.connection;
        if (!connection)
            return [];
        const rules = [
            this.booleanRule('connection.logAllChecks', connection.logAllChecks),
            this.positiveIntRule('connection.interval', connection.interval),
            this.positiveIntRule('connection.timeout', connection.timeout)
        ];
        if (connection.thresholds) {
            rules.push(this.positiveNumberRule('connection.thresholds.bad', connection.thresholds.bad), this.positiveNumberRule('connection.thresholds.average', connection.thresholds.average), this.floatMustBeBelow('connection.thresholds.bad', connection.thresholds.bad, connection.thresholds.average, 'connection.thresholds.average'));
        }
        return rules;
    }
    validateVoiceReceive() {
        const voiceReceive = this.options.voiceReceive;
        if (!voiceReceive)
            return [];
        return [
            this.booleanRule('voiceReceive.enabled', voiceReceive.enabled),
            this.enumRule('voiceReceive.format', voiceReceive.format, VALID_VOICE_FORMATS)
        ];
    }
    validateMix() {
        const mix = this.options.mix;
        if (!mix)
            return [];
        return [
            this.booleanRule('mix.enabled', mix.enabled),
            this.positiveIntRule('mix.maxLayersMix', mix.maxLayersMix),
            this.booleanRule('mix.autoCleanup', mix.autoCleanup),
            {
                path: 'mix.defaultVolume',
                expected: 'number between 0 and 1 (inclusive)',
                value: mix.defaultVolume,
                validate: (v) => typeof v === 'number' && v >= 0 && v <= 1
            }
        ];
    }
    validateMetrics() {
        const metrics = this.options.metrics;
        if (!metrics)
            return [];
        const rules = [
            this.booleanRule('metrics.enabled', metrics.enabled)
        ];
        if (metrics.authorization) {
            rules.push(this.enumRule('metrics.authorization.type', metrics.authorization.type, VALID_METRICS_AUTH_TYPES));
        }
        return rules;
    }
    validateFilters() {
        const filters = this.options.filters;
        if (filters === undefined)
            return [];
        if (filters === null || typeof filters !== 'object') {
            return [
                {
                    path: 'filters',
                    expected: 'object with an enabled key',
                    value: filters,
                    validate: () => false
                }
            ];
        }
        if (!('enabled' in filters)) {
            return [
                {
                    path: 'filters.enabled',
                    expected: 'object of filter flags',
                    value: undefined,
                    validate: () => false
                }
            ];
        }
        if (filters.enabled === null || typeof filters.enabled !== 'object') {
            return [
                {
                    path: 'filters.enabled',
                    expected: 'object of filter flags',
                    value: filters.enabled,
                    validate: () => false
                }
            ];
        }
        if (Object.keys(filters.enabled).length === 0)
            return [];
        const filterFields = [
            'tremolo',
            'vibrato',
            'lowpass',
            'highpass',
            'rotation',
            'karaoke',
            'distortion',
            'channelMix',
            'equalizer',
            'chorus',
            'compressor',
            'echo',
            'phaser',
            'timescale'
        ];
        return filterFields
            .filter((f) => filters.enabled[f] !== undefined)
            .map((f) => this.booleanRule(`filters.enabled.${f}`, filters.enabled[f]));
    }
    placeholderWarningRule(path, value, except = []) {
        return {
            path,
            expected: 'non-placeholder value',
            value,
            validate: (v) => {
                if (typeof v === 'string' &&
                    KNOWN_PLACEHOLDERS.has(v) &&
                    !except.includes(v)) {
                    this.warnings.push({
                        path,
                        message: `Value "${v}" looks like an unfilled placeholder. The source may fail to authenticate at runtime.`
                    });
                }
                return true;
            }
        };
    }
    nonNegativeIntRule(path, value) {
        return {
            path,
            expected: 'integer >= 0',
            value,
            validate: (v) => Number.isInteger(v) && v >= 0
        };
    }
    positiveIntRule(path, value) {
        return {
            path,
            expected: 'integer > 0',
            value,
            validate: (v) => Number.isInteger(v) && v > 0
        };
    }
    intRangeRule(path, value, min, max) {
        return {
            path,
            expected: `integer between ${min} and ${max}`,
            value,
            validate: (v) => Number.isInteger(v) && v >= min && v <= max
        };
    }
    booleanRule(path, value) {
        return {
            path,
            expected: 'boolean',
            value,
            validate: (v) => typeof v === 'boolean'
        };
    }
    nonEmptyStringRule(path, value) {
        return {
            path,
            expected: 'non-empty string',
            value,
            validate: (v) => typeof v === 'string' && v.trim().length > 0
        };
    }
    enumRule(path, value, allowed) {
        const label = [...allowed].join(', ');
        return {
            path,
            expected: `one of [${label}]`,
            value,
            validate: (v) => allowed.has(v)
        };
    }
    urlRule(path, value) {
        return {
            path,
            expected: 'valid http or https URL (e.g. https://example.com)',
            value,
            validate: (v) => {
                if (typeof v !== 'string' || v.trim().length === 0)
                    return false;
                if (v !== v.trim()) {
                    this.warnings.push({
                        path,
                        message: `URL value has leading or trailing whitespace. This may cause issues at runtime.`
                    });
                }
                try {
                    const url = new URL(v.trim());
                    return url.protocol === 'http:' || url.protocol === 'https:';
                }
                catch {
                    return false;
                }
            }
        };
    }
    intMustExceed(path, value, dependency, dependencyPath) {
        return {
            path,
            expected: `integer > ${dependencyPath} (${dependency})`,
            value,
            validate: (v) => Number.isInteger(v) && Number.isInteger(dependency) && v > dependency
        };
    }
    intMustNotExceed(path, value, dependency, dependencyPath) {
        return {
            path,
            expected: `integer <= ${dependencyPath} (${dependency})`,
            value,
            validate: (v) => Number.isInteger(v) && Number.isInteger(dependency) && v <= dependency
        };
    }
    floatMustNotExceed(path, value, dependency, dependencyPath) {
        return {
            path,
            expected: `number <= ${dependencyPath} (${dependency})`,
            value,
            validate: (v) => typeof v === 'number' &&
                typeof dependency === 'number' &&
                v <= dependency
        };
    }
    floatMustBeBelow(path, value, dependency, dependencyPath) {
        return {
            path,
            expected: `number < ${dependencyPath} (${dependency})`,
            value,
            validate: (v) => typeof v === 'number' &&
                typeof dependency === 'number' &&
                v < dependency
        };
    }
    positiveNumberRule(path, value) {
        return {
            path,
            expected: 'number > 0',
            value,
            validate: (v) => typeof v === 'number' && v > 0
        };
    }
    stringArrayRule(path, value) {
        return {
            path,
            expected: 'array of strings',
            value,
            validate: (v) => Array.isArray(v) && v.every((item) => typeof item === 'string')
        };
    }
}
