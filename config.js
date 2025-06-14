export default {
  server: {
    host: 'localhost',
    port: 3000,
    password: '123'
  },
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  playerUpdateInterval: 2000,
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
      enabled: true
    },
    http: {
      enabled: true
    },
    youtube: {
      enabled: true
    },
    instagram: {
      enabled: true
    },
    spotify: {
      enabled: true
      // clientId: '',
      // clientSecret: '',
    }
  },
  audio: {
    encryption: 'aead_aes256_gcm_rtpsize'
  }
}
