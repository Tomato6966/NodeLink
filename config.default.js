export default {
  server: {
    host: 'localhost',
    port: 3000,
    password: '123'
  },
  cluster: {
    enabled: false, // active cluster (or use env CLUSTER_ENABLED)
    workers: 0 // 0 => uses os.cpus().length, or specify a number (1 = 2 processes total: master + 1 worker)
  },
  logging: {
    level: 'debug',
    file: {
      enabled: false,
      path: 'logs'
    },
    debug: {
      all: true,
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
      getOAuthToken: false,
      hl: 'en',
      gl: 'US',
      clients: {
        search: ['Android'],
        playback: ['AndroidVR', 'TV', 'TVEmbedded', 'IOS'],
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
      clientSecret: ''
    },
    nicovideo: {
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
    spotify: {
      enabled: true
      // spDc: ''
    },
    deezer: {
      enabled: true
      // arl: ''
    },
    musixmatch: {
      enabled: true
      // signatureSecret: ''
    }
  },
  audio: {
    encryption: 'aead_aes256_gcm_rtpsize'
  },
  routePlanner: {
    strategy: 'RotateOnBan', // RotateOnBan, RoundRobin, LoadBalance
    bannedIpCooldown: 600000, // 10 minutes
    ipBlocks: []
  }
}
