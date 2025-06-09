export default {
  server: {
    host: 'localhost',
    port: 3000,
    password: '123'
  },
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  playerUpdateInterval: 2000,
  sources: {
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
    }
  },
  audio: {
    encryption: 'aead_aes256_gcm_rtpsize'
  }
}
