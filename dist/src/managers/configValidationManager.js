import { validateProperty } from "../utils.js";
export default class ConfigValidationManager {
    options;
    constructor(options) {
        this.options = options;
    }
    validate() {
        const errors = [];
        const domains = [
            () => this.validateServer(),
            () => this.validateCluster(),
            () => this.validateAudio(),
            () => this.validateSources(),
            () => this.validatePlayback(),
            () => this.validateRoutePlanner(),
            () => this.validateSearch()
        ];
        for (const validateDomain of domains) {
            try {
                validateDomain();
            }
            catch (err) {
                errors.push(err.message);
            }
        }
        if (errors.length > 0) {
            throw new Error('Configuration errors:\n\n' + errors.join('\n\n'));
        }
    }
    // ===== DOMAINS =====
    validateServer() {
        const server = this.options.server;
        const rules = [
            this.nonEmptyStringRule('server.host', () => server?.host),
            this.intRangeRule('server.port', () => server?.port, 1, 65535),
            this.nonEmptyStringRule('server.password', () => server?.password),
            this.booleanRule('server.useBunServer', () => server?.useBunServer)
        ];
        this.runRules(rules);
    }
    validateCluster() {
        const workers = this.options.cluster?.workers;
        const rules = [
            this.nonNegativeIntRule('cluster.workers', () => workers),
            this.nonNegativeIntRule('cluster.minWorkers', () => this.options.cluster?.minWorkers),
            {
                path: 'cluster.minWorkers',
                expected: workers === 0
                    ? 'auto-scaled workers'
                    : `<= cluster.workers (${workers})`,
                get: () => this.options.cluster?.minWorkers,
                validate: (v) => Number.isInteger(v) &&
                    (workers === 0 || v <= workers)
            }
        ];
        this.runRules(rules);
    }
    validatePlayback() {
        const trackStuck = this.options.trackStuckThresholdMs;
        const rules = [
            this.intRangeRule('playerUpdateInterval', () => this.options.playerUpdateInterval, 250, 60000),
            {
                path: 'trackStuckThresholdMs',
                expected: 'integer >= 1000 (milliseconds)',
                get: () => trackStuck,
                validate: (v) => Number.isInteger(v) && v >= 1000
            },
            {
                path: 'zombieThresholdMs',
                expected: `integer > trackStuckThresholdMs (${trackStuck})`,
                get: () => this.options.zombieThresholdMs,
                validate: (v) => Number.isInteger(v) && v > trackStuck
            }
        ];
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
                validate: (v) => typeof v === 'number' && v <= 0
            },
            this.enumRule('audio.quality', () => audio?.quality, [
                'high',
                'medium',
                'low',
                'lowest'
            ]),
            this.enumRule('audio.resamplingQuality', () => audio?.resamplingQuality, [
                'best',
                'medium',
                'fastest',
                'zero',
                'linear'
            ])
        ];
        this.runRules(rules);
    }
    validateSources() {
        const sources = this.options.sources;
        if (!sources)
            return;
        const rules = [];
        const spotify = sources.spotify;
        const applemusic = sources.applemusic;
        const tidal = sources.tidal;
        const jiosaavn = sources.jiosaavn;
        const audius = sources.audius;
        if (spotify?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.spotify.playlistLoadLimit', () => spotify.playlistLoadLimit), this.nonNegativeIntRule('sources.spotify.albumLoadLimit', () => spotify.albumLoadLimit), this.positiveIntRule('sources.spotify.playlistPageLoadConcurrency', () => spotify.playlistPageLoadConcurrency), this.positiveIntRule('sources.spotify.albumPageLoadConcurrency', () => spotify.albumPageLoadConcurrency), {
                path: 'sources.spotify.credentials',
                expected: 'clientId and clientSecret must be set together',
                get: () => Boolean(spotify.clientId) === Boolean(spotify.clientSecret),
                validate: (v) => v === true
            });
        }
        if (applemusic?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.applemusic.playlistLoadLimit', () => applemusic.playlistLoadLimit), this.nonNegativeIntRule('sources.applemusic.albumLoadLimit', () => applemusic.albumLoadLimit), this.positiveIntRule('sources.applemusic.playlistPageLoadConcurrency', () => applemusic.playlistPageLoadConcurrency), this.positiveIntRule('sources.applemusic.albumPageLoadConcurrency', () => applemusic.albumPageLoadConcurrency));
        }
        if (tidal?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.tidal.playlistLoadLimit', () => tidal.playlistLoadLimit), this.positiveIntRule('sources.tidal.playlistPageLoadConcurrency', () => tidal.playlistPageLoadConcurrency));
            if (tidal.token !== undefined) {
                rules.push({
                    path: 'sources.tidal.token',
                    expected: 'string (non-whitespace if provided)',
                    get: () => tidal.token,
                    validate: (v) => typeof v === 'string' && (v === '' || v.trim().length > 0)
                });
            }
        }
        if (audius?.enabled) {
            rules.push({
                path: 'sources.audius.appName',
                expected: 'string',
                get: () => audius.appName,
                validate: (v) => v === undefined || typeof v === 'string'
            }, {
                path: 'sources.audius.apiKey',
                expected: 'string',
                get: () => audius.apiKey,
                validate: (v) => v === undefined || typeof v === 'string'
            }, {
                path: 'sources.audius.apiSecret',
                expected: 'string',
                get: () => audius.apiSecret,
                validate: (v) => v === undefined || typeof v === 'string'
            }, this.nonNegativeIntRule('sources.audius.playlistLoadLimit', () => audius.playlistLoadLimit), this.nonNegativeIntRule('sources.audius.albumLoadLimit', () => audius.albumLoadLimit));
        }
        if (jiosaavn?.enabled) {
            rules.push(this.nonNegativeIntRule('sources.jiosaavn.playlistLoadLimit', () => jiosaavn.playlistLoadLimit), this.nonNegativeIntRule('sources.jiosaavn.artistLoadLimit', () => jiosaavn.artistLoadLimit), {
                path: 'sources.jiosaavn.playlistLoadLimit',
                expected: `integer >= artistLoadLimit (${jiosaavn.artistLoadLimit})`,
                get: () => jiosaavn.playlistLoadLimit,
                validate: (v) => v >= jiosaavn.artistLoadLimit
            });
        }
        this.runRules(rules);
    }
    validateSearch() {
        const rules = [];
        rules.push(this.intRangeRule('maxSearchResults', () => this.options.maxSearchResults, 1, 100));
        rules.push(this.intRangeRule('maxAlbumPlaylistLength', () => this.options.maxAlbumPlaylistLength, 1, 500));
        rules.push({
            path: 'defaultSearchSource',
            expected: 'string or non-empty string[] of enabled source names in config.sources',
            get: () => this.options.defaultSearchSource,
            validate: (v) => {
                const sources = this.options.sources;
                if (!sources)
                    return false;
                if (typeof v === 'string') {
                    return sources[v]?.enabled === true;
                }
                if (Array.isArray(v)) {
                    if (v.length === 0)
                        return false;
                    return v.every((name) => typeof name === 'string' && sources[name]?.enabled === true);
                }
                return false;
            }
        });
        this.runRules(rules);
    }
    validateRoutePlanner() {
        const routePlanner = this.options.routePlanner;
        if (!routePlanner)
            return;
        const rules = [];
        rules.push(this.enumRule('routePlanner.strategy', () => routePlanner.strategy, [
            'RotateOnBan',
            'RoundRobin',
            'LoadBalance'
        ]));
        if (routePlanner.bannedIpCooldown !== undefined) {
            rules.push(this.positiveIntRule('routePlanner.bannedIpCooldown', () => routePlanner.bannedIpCooldown));
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
    nonNegativeIntRule(path, get) {
        return {
            path,
            expected: 'integer >= 0',
            get,
            validate: (v) => Number.isInteger(v) && v >= 0
        };
    }
    positiveIntRule(path, get) {
        return {
            path,
            expected: 'integer > 0',
            get,
            validate: (v) => Number.isInteger(v) && v > 0
        };
    }
    intRangeRule(path, get, min, max) {
        return {
            path,
            expected: `integer between ${min} and ${max}`,
            get,
            validate: (v) => Number.isInteger(v) && v >= min && v <= max
        };
    }
    booleanRule(path, get) {
        return {
            path,
            expected: 'boolean',
            get,
            validate: (v) => typeof v === 'boolean'
        };
    }
    nonEmptyStringRule(path, get) {
        return {
            path,
            expected: 'non-empty string',
            get,
            validate: (v) => typeof v === 'string' && v.trim().length > 0
        };
    }
    enumRule(path, get, allowed) {
        return {
            path,
            expected: `one of [${allowed.join(', ')}]`,
            get,
            validate: (v) => allowed.includes(v)
        };
    }
}
