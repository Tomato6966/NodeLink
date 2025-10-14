export default {
  server: {
    host: 'localhost',
    port: 3000,
    password: '123'
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
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  playerUpdateInterval: 2000,
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
      enabled: true
      // clientId: '',
      // clientSecret: '',
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
  }
}
