export default {
  server: {
    host: 'localhost',
    port: 3000,
    password: '123'
  },
  maxSearchResults: 10,
  maxAlbumPlaylistLength: 100,
  sources: {
    soundcloud: {
      enabled: true
    },
    local: {
      enabled: true
    }
  },
  audio: {
    encryption: 'aead_aes256_gcm_rtpsize'
  }
}
