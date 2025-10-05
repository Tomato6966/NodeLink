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
  TRACK_EXCEPTION: 'TrackExceptionEvent',
  PLAYER_UPDATE: 'playerUpdate'
}
export const EndReasons = {
  STOPPED: 'stopped',
  FINISHED: 'finished',
  LOAD_FAILED: 'loadFailed',
  REPLACED: 'replaced',
  CLEANUP: 'cleanup'
}
