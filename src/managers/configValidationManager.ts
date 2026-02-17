import { validateProperty } from '../utils.ts'

type ValidationRule<T = any> = {
  path: string
  expected: string
  get: () => T
  validate: (value: T) => boolean
}

export default class ConfigValidationManager {
  constructor(private options: any) { }

  validate(): void {
    const errors: string[] = []

    const domains = [
      () => this.validateServer(),
      () => this.validateCluster(),
      () => this.validateAudio(),
      () => this.validateSources(),
      () => this.validatePlayback(),
      () => this.validateRoutePlanner(),
      () => this.validateSearch()
    ]

    for (const validateDomain of domains) {
      try {
        validateDomain()
      } catch (err: any) {
        errors.push(err.message)
      }
    }

    if (errors.length > 0) {
      throw new Error(
        'Configuration errors:\n\n' + errors.join('\n\n')
      )
    }
  }



  // ===== DOMAINS =====

  private validateServer(): void {
    const server = this.options.server

    const rules: ValidationRule[] = [
      this.nonEmptyStringRule('server.host', () => server?.host),

      this.intRangeRule('server.port', () => server?.port, 1, 65535),

      this.nonEmptyStringRule('server.password', () => server?.password),

      this.booleanRule('server.useBunServer', () => server?.useBunServer)
    ]

    this.runRules(rules)
  }

  private validateCluster(): void {
    const workers = this.options.cluster?.workers

    const rules: ValidationRule[] = [
      this.nonNegativeIntRule('cluster.workers', () => workers),

      this.nonNegativeIntRule(
        'cluster.minWorkers',
        () => this.options.cluster?.minWorkers
      ),

      {
        path: 'cluster.minWorkers',
        expected:
          workers === 0
            ? 'auto-scaled workers'
            : `<= cluster.workers (${workers})`,
        get: () => this.options.cluster?.minWorkers,
        validate: (v: number) =>
          Number.isInteger(v) &&
          (workers === 0 || v <= workers)

      }
    ]

    this.runRules(rules)
  }

  private validatePlayback(): void {
    const trackStuck = this.options.trackStuckThresholdMs

    const rules: ValidationRule[] = [
      this.intRangeRule(
        'playerUpdateInterval',
        () => this.options.playerUpdateInterval,
        250,
        60000
      ),

      {
        path: 'trackStuckThresholdMs',
        expected: 'integer >= 1000 (milliseconds)',
        get: () => trackStuck,
        validate: (v: number) => Number.isInteger(v) && v >= 1000
      },

      {
        path: 'zombieThresholdMs',
        expected: `integer > trackStuckThresholdMs (${trackStuck})`,
        get: () => this.options.zombieThresholdMs,
        validate: (v: number) => Number.isInteger(v) && v > trackStuck
      }
    ]

    this.runRules(rules)
  }

  private validateAudio(): void {
    const audio = this.options.audio
    const rules: ValidationRule[] = [
      this.booleanRule(
        'audio.loudnessNormalizer',
        () => audio?.loudnessNormalizer
      ),

      this.nonNegativeIntRule('audio.lookaheadMs', () => audio?.lookaheadMs),

      {
        path: 'audio.gateThresholdLUFS',
        expected: 'number <= 0',
        get: () => audio?.gateThresholdLUFS,
        validate: (v: number) => typeof v === 'number' && v <= 0
      },

      this.enumRule('audio.quality', () => audio?.quality, [
        'high',
        'medium',
        'low',
        'lowest'
      ] as const),

      this.enumRule('audio.resamplingQuality', () => audio?.resamplingQuality, [
        'best',
        'medium',
        'fastest',
        'zero',
        'linear'
      ] as const)
    ]

    this.runRules(rules)
  }

  private validateSources(): void {
    const sources = this.options.sources
    if (!sources) return

    const rules: ValidationRule[] = []

    const spotify = sources.spotify
    const applemusic = sources.applemusic
    const tidal = sources.tidal
    const jiosaavn = sources.jiosaavn
    const audius = sources.audius

    if (spotify?.enabled) {
      rules.push(
        this.nonNegativeIntRule(
          'sources.spotify.playlistLoadLimit',
          () => spotify.playlistLoadLimit
        ),
        this.nonNegativeIntRule(
          'sources.spotify.albumLoadLimit',
          () => spotify.albumLoadLimit
        ),
        this.positiveIntRule(
          'sources.spotify.playlistPageLoadConcurrency',
          () => spotify.playlistPageLoadConcurrency
        ),
        this.positiveIntRule(
          'sources.spotify.albumPageLoadConcurrency',
          () => spotify.albumPageLoadConcurrency
        ),
        {
          path: 'sources.spotify.credentials',
          expected: 'clientId and clientSecret must be set together',
          get: () =>
            Boolean(spotify.clientId) === Boolean(spotify.clientSecret),
          validate: (v: boolean) => v === true
        }
      )
    }

    if (applemusic?.enabled) {
      rules.push(
        this.nonNegativeIntRule(
          'sources.applemusic.playlistLoadLimit',
          () => applemusic.playlistLoadLimit
        ),
        this.nonNegativeIntRule(
          'sources.applemusic.albumLoadLimit',
          () => applemusic.albumLoadLimit
        ),
        this.positiveIntRule(
          'sources.applemusic.playlistPageLoadConcurrency',
          () => applemusic.playlistPageLoadConcurrency
        ),
        this.positiveIntRule(
          'sources.applemusic.albumPageLoadConcurrency',
          () => applemusic.albumPageLoadConcurrency
        )
      )
    }

    if (tidal?.enabled) {
      rules.push(
        this.nonNegativeIntRule(
          'sources.tidal.playlistLoadLimit',
          () => tidal.playlistLoadLimit
        ),
        this.positiveIntRule(
          'sources.tidal.playlistPageLoadConcurrency',
          () => tidal.playlistPageLoadConcurrency
        )
      )

      if (tidal.token !== undefined) {
        rules.push({
          path: 'sources.tidal.token',
          expected: 'string (non-whitespace if provided)',
          get: () => tidal.token,
          validate: (v: string) =>
            typeof v === 'string' && (v === '' || v.trim().length > 0)
        })
      }
    }

    if (audius?.enabled) {
      rules.push(
        {
          path: 'sources.audius.appName',
          expected: 'string',
          get: () => audius.appName,
          validate: (v: string) => v === undefined || typeof v === 'string'
        },
        {
          path: 'sources.audius.apiKey',
          expected: 'string',
          get: () => audius.apiKey,
          validate: (v: string) => v === undefined || typeof v === 'string'
        },
        {
          path: 'sources.audius.apiSecret',
          expected: 'string',
          get: () => audius.apiSecret,
          validate: (v: string) => v === undefined || typeof v === 'string'
        },
        this.nonNegativeIntRule(
          'sources.audius.playlistLoadLimit',
          () => audius.playlistLoadLimit
        ),
        this.nonNegativeIntRule(
          'sources.audius.albumLoadLimit',
          () => audius.albumLoadLimit
        )
      )
    }

    if (jiosaavn?.enabled) {
      rules.push(
        this.nonNegativeIntRule(
          'sources.jiosaavn.playlistLoadLimit',
          () => jiosaavn.playlistLoadLimit
        ),
        this.nonNegativeIntRule(
          'sources.jiosaavn.artistLoadLimit',
          () => jiosaavn.artistLoadLimit
        ),
        {
          path: 'sources.jiosaavn.playlistLoadLimit',
          expected: `integer >= artistLoadLimit (${jiosaavn.artistLoadLimit})`,
          get: () => jiosaavn.playlistLoadLimit,
          validate: (v: number) => v >= jiosaavn.artistLoadLimit
        }
      )
    }

    this.runRules(rules)
  }

  private validateSearch(): void {
    const rules: ValidationRule[] = []

    rules.push(
      this.intRangeRule(
        'maxSearchResults',
        () => this.options.maxSearchResults,
        1,
        100
      )
    )

    rules.push(
      this.intRangeRule(
        'maxAlbumPlaylistLength',
        () => this.options.maxAlbumPlaylistLength,
        1,
        500
      )
    )

    rules.push({
      path: 'defaultSearchSource',
      expected:
        'string or non-empty string[] of enabled source names in config.sources',
      get: () => this.options.defaultSearchSource,
      validate: (v: any) => {
        const sources = this.options.sources
        if (!sources) return false

        if (typeof v === 'string') {
          return sources[v]?.enabled === true
        }

        if (Array.isArray(v)) {
          if (v.length === 0) return false

          return v.every(
            (name: any) =>
              typeof name === 'string' && sources[name]?.enabled === true
          )
        }

        return false
      }
    })

    this.runRules(rules)
  }

  private validateRoutePlanner(): void {
    const routePlanner = this.options.routePlanner
    if (!routePlanner) return

    const rules: ValidationRule[] = []

    rules.push(
      this.enumRule('routePlanner.strategy', () => routePlanner.strategy, [
        'RotateOnBan',
        'RoundRobin',
        'LoadBalance'
      ] as const)
    )

    if (routePlanner.bannedIpCooldown !== undefined) {
      rules.push(
        this.positiveIntRule(
          'routePlanner.bannedIpCooldown',
          () => routePlanner.bannedIpCooldown
        )
      )
    }

    this.runRules(rules)
  }

  private runRules(rules: ValidationRule[]): void {
    const errors: string[] = []

    for (const rule of rules) {
      try {
        validateProperty(rule.get(), rule.path, rule.expected, rule.validate)
      } catch (err: any) {
        errors.push(err.message)
      }
    }

    if (errors.length > 0) {
      throw new Error('Configuration errors:\n\n' + errors.join('\n\n'))
    }
  }

  private nonNegativeIntRule(
    path: string,
    get: () => number
  ): ValidationRule<number> {
    return {
      path,
      expected: 'integer >= 0',
      get,
      validate: (v) => Number.isInteger(v) && v >= 0
    }
  }

  private positiveIntRule(
    path: string,
    get: () => number
  ): ValidationRule<number> {
    return {
      path,
      expected: 'integer > 0',
      get,
      validate: (v) => Number.isInteger(v) && v > 0
    }
  }

  private intRangeRule(
    path: string,
    get: () => number,
    min: number,
    max: number
  ): ValidationRule<number> {
    return {
      path,
      expected: `integer between ${min} and ${max}`,
      get,
      validate: (v) => Number.isInteger(v) && v >= min && v <= max
    }
  }

  private booleanRule(
    path: string,
    get: () => boolean
  ): ValidationRule<boolean> {
    return {
      path,
      expected: 'boolean',
      get,
      validate: (v) => typeof v === 'boolean'
    }
  }

  private nonEmptyStringRule(
    path: string,
    get: () => string
  ): ValidationRule<string> {
    return {
      path,
      expected: 'non-empty string',
      get,
      validate: (v) => typeof v === 'string' && v.trim().length > 0
    }
  }

  private enumRule<T>(
    path: string,
    get: () => T,
    allowed: readonly T[]
  ): ValidationRule<T> {
    return {
      path,
      expected: `one of [${allowed.join(', ')}]`,
      get,
      validate: (v) => allowed.includes(v)
    }
  }
}
