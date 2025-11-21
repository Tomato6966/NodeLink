export default {
  server: {
    host: '0.0.0.0',
    port: 3000,
    password: 'youshallnotpass'
  },
  cluster: {
    enabled: true, // active cluster (or use env CLUSTER_ENABLED)
    workers: 0, // 0 => uses os.cpus().length, or specify a number (1 = 2 processes total: master + 1 worker)
    minWorkers: 1, // Minimum workers to keep alive (improves availability during bursts)
    commandTimeout: 6000, // Timeout for heavy operations like loadTracks (6s)
    fastCommandTimeout: 4000, // Timeout for player commands like play/pause (4s)
    maxRetries: 2, // Number of retry attempts on timeout or worker failure
    scaling: {
      // New object to group scaling configurations
      maxPlayersPerWorker: 20, // Reference capacity for utilization calculation
      targetUtilization: 0.7, // Target utilization for scaling up/down
      scaleUpThreshold: 0.75, // Utilization threshold to scale up
      scaleDownThreshold: 0.3, // Utilization threshold to scale down
      checkIntervalMs: 5000, // Interval to check for scaling needs
      idleWorkerTimeoutMs: 60000, // Time in ms an idle worker should wait before being removed
      queueLengthScaleUpFactor: 5 // How many commands in queue per active worker trigger scale up
    }
  },
  logging: {
    level: 'debug',
    file: {
      enabled: false,
      path: 'logs'
    },
    debug: {
      all: false,
      request: true,
      session: true,
      player: true,
      filters: true,
      sources: true,
      lyrics: true,
      youtube: true,
      'youtube-cipher': true
    }
  },
  connection: {
    logAllChecks: false,
    interval: 300000, // 5 minutes
    timeout: 10000, // 10 seconds
    thresholds: {
      bad: 1, // Mbps
      average: 5 // Mbps
    }
  },
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  playerUpdateInterval: 2000,
  trackStuckThresholdMs: 10000,
  zombieThresholdMs: 60000,
  enableHoloTracks: false,
  resolveExternalLinks: false,
  fetchChannelInfo: false,
  filters: {
    enabled: {
      tremolo: true,
      vibrato: true,
      lowpass: true,
      highpass: true,
      rotation: true,
      karaoke: true,
      distortion: true,
      channelMix: true,
      equalizer: true,
      chorus: true,
      compressor: true,
      echo: true,
      phaser: true,
      timescale: true
    }
  },
  defaultSearchSource: 'youtube',
  unifiedSearchSources: ['youtube', 'soundcloud'],
  sources: {
    deezer: {
      // arl: '',
      // decryptionKey: '',
      enabled: true
    },
    bandcamp: {
      enabled: true
    },
    soundcloud: {
      enabled: true
    },
    local: {
      enabled: true,
      basePath: './local-music/'
    },
    http: {
      enabled: true
    },
    youtube: {
      enabled: true,
      allowItag: [], // additional itags for audio streams, e.g., [140, 141]
      targetItag: null, // force a specific itag for audio streams, overriding the quality option
      getOAuthToken: false,
      hl: 'en',
      gl: 'US',
      clients: {
        search: ['Android'], // Clients used for searching tracks
        playback: ['AndroidVR', 'TV', 'TVEmbedded', 'IOS'], // Clients used for playback/streaming
        resolve: ['AndroidVR', 'TV', 'TVEmbedded', 'IOS', 'Web'], // Clients used for resolving detailed track information (channel, external links, etc.)
        settings: {
          TV: {
            refreshToken: ''
          }
        }
      },
      cipher: {
        url: 'http://127.0.0.1:8001',
        token: 'KEY'
      }
    },
    instagram: {
      enabled: true
    },
    kwai: {
      enabled: true
    },
    twitch: {
      enabled: true
    },
    spotify: {
      enabled: true,
      clientId: '',
      clientSecret: '',
      market: 'US',
      playlistLoadLimit: 1, // 0 means no limit (loads all tracks), 1 = 100 tracks, 2 = 100 and so on!
      playlistPageLoadConcurrency: 10, // How many pages to load simultaneously
      albumLoadLimit: 1, // 0 means no limit (loads all tracks), 1 = 50 tracks, 2 = 100 tracks, etc.
      albumPageLoadConcurrency: 5, // How many pages to load simultaneously
      allowExplicit: true // If true plays the explicit version of the song, If false plays the Non-Explicit version of the song. Normal songs are not affected.
    },
    applemusic: {
      enabled: true,
      mediaApiToken: 'token_here', //manually | or "token_here" to get a token automatically
      market: 'US',
      playlistLoadLimit: 0,
      albumLoadLimit: 0,
      playlistPageLoadConcurrency: 5,
      albumPageLoadConcurrency: 5,
      allowExplicit: true
    },
    tidal: {
      enabled: true,
      token: '', //get from tidal web player devtools; using login google account
      countryCode: 'US',
      playlistLoadLimit: 2, // 0 = no limit, 1 = 50 tracks, 2 = 100 tracks, etc.
      playlistPageLoadConcurrency: 5 // How many pages to load simultaneously
    },
    nicovideo: {
      enabled: true
    },
    reddit: {
      enabled: true
    },
    lastfm: {
      enabled: true
    }
  },
  lyrics: {
    fallbackSource: 'genius',
    youtube: {
      enabled: true
    },
    genius: {
      enabled: true
    },
    musixmatch: {
      enabled: true
      // signatureSecret: ''
    },
    lrclib: {
      enabled: true
    },
    applemusic: {
      enabled: true,
      advanceSearch: true // Uses YTMusic to fetch the correct title and artists instead of relying on messy YouTube video titles, improving lyrics accuracy
    }
  },
  audio: {
    quality: 'high', // high, medium, low, lowest
    encryption: 'aead_aes256_gcm_rtpsize',
    resamplingQuality: 'best' // best, medium, fastest, zero order holder, linear
  },
  routePlanner: {
    strategy: 'RotateOnBan', // RotateOnBan, RoundRobin, LoadBalance
    bannedIpCooldown: 600000, // 10 minutes
    ipBlocks: []
  },
  rateLimit: {
    enabled: true,
    global: {
      maxRequests: 1000,
      timeWindowMs: 60000 // 1 minute
    },
    perIp: {
      maxRequests: 100,
      timeWindowMs: 10000 // 10 seconds
    },
    perUserId: {
      maxRequests: 50,
      timeWindowMs: 5000 // 5 seconds
    },
    perGuildId: {
      maxRequests: 20,
      timeWindowMs: 5000 // 5 seconds
    },
    ignorePaths: []
  },
  dosProtection: {
    enabled: true,
    thresholds: {
      burstRequests: 50,
      timeWindowMs: 10000 // 10 seconds
    },
    mitigation: {
      delayMs: 500,
      blockDurationMs: 300000 // 5 minutes
    }
  }
}
