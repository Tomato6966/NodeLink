export const SAMPLE_RATE = 48000
export const DISCORD_ID_REGEX = /^\d{18,19}$/
export const SEMVER_PATTERN =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
export const PATH_VERSION = 'v4'

export const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308]
export const DEFAULT_MAX_REDIRECTS = 5
export const HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT = 5

export const GatewayEvents = {
  WEBSOCKET_CLOSED: 'WebSocketClosedEvent',
  TRACK_END: 'TrackEndEvent',
  TRACK_START: 'TrackStartEvent',
  TRACK_STUCK: 'TrackStuckEvent',
  TRACK_EXCEPTION: 'TrackExceptionEvent',
  PLAYER_UPDATE: 'playerUpdate',
  CONNECTION_STATUS: 'ConnectionStatusEvent',
  VOLUME_CHANGED: 'VolumeChangedEvent',
  FILTERS_CHANGED: 'FiltersChangedEvent',
  SEEK: 'SeekEvent',
  PAUSE: 'PauseEvent',
  PLAYER_CREATED: 'PlayerCreatedEvent',
  PLAYER_DESTROYED: 'PlayerDestroyedEvent',
  PLAYER_RECONNECTING: 'PlayerReconnectingEvent',
  PLAYER_CONNECTED: 'PlayerConnectedEvent',
  MIX_STARTED: 'MixStartedEvent',
  MIX_ENDED: 'MixEndedEvent'
}
export const EndReasons = {
  STOPPED: 'stopped',
  FINISHED: 'finished',
  LOAD_FAILED: 'loadFailed',
  REPLACED: 'replaced',
  CLEANUP: 'cleanup'
}

export const SupportedFormats = {
  OPUS: 'opus',
  AAC: 'aac',
  MPEG: 'mpeg',
  FLAC: 'flac',
  OGG_VORBIS: 'ogg-vorbis',
  WAV: 'wav',
  FLV: 'flv',
  UNKNOWN: 'unknown'
}

export function normalizeFormat(type) {
  if (!type) return SupportedFormats.UNKNOWN
  const lowerType = type.toLowerCase()

  if (lowerType.includes('opus') || lowerType.includes('webm'))
    return SupportedFormats.OPUS
  if (
    lowerType.includes('aac') ||
    lowerType.includes('mp4') ||
    lowerType.includes('m4a') ||
    lowerType.includes('m4v') ||
    lowerType.includes('mov') ||
    lowerType.includes('hls') ||
    lowerType.includes('mpegurl') ||
    lowerType.includes('fmp4') ||
    lowerType.includes('mpegts')
  )
    return SupportedFormats.AAC
  if (lowerType.includes('mpeg') || lowerType.includes('mp3'))
    return SupportedFormats.MPEG
  if (lowerType.includes('flac')) return SupportedFormats.FLAC
  if (lowerType.includes('ogg') || lowerType.includes('vorbis'))
    return SupportedFormats.OGG_VORBIS
  if (lowerType.includes('wav')) return SupportedFormats.WAV
  if (lowerType.includes('flv')) return SupportedFormats.FLV

  return SupportedFormats.UNKNOWN
}
