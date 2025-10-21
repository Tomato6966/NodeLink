import { logger } from '../utils.js'

export default class StatsManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.stats = {
      api: {
        requests: {}, // { '/v4/loadtracks': 10, ... }
        errors: {}
      },
      sources: {}, // { youtube: { success: 10, failure: 1 }, ... }
      playback: {
        events: {}, // { TrackStartEvent: 10, ... }
        recovery: {
          attempts: 0,
          successes: 0,
          failures: 0
        }
      }
    }
    logger('info', 'StatsManager', 'Initialized.')
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.stats))
  }

  _initSource(source) {
    if (!this.stats.sources[source]) {
      this.stats.sources[source] = { success: 0, failure: 0 }
    }
  }

  incrementApiRequest(endpoint) {
    this.stats.api.requests[endpoint] =
      (this.stats.api.requests[endpoint] || 0) + 1
  }

  incrementApiError(endpoint) {
    this.stats.api.errors[endpoint] = (this.stats.api.errors[endpoint] || 0) + 1
  }

  incrementSourceSuccess(source) {
    this._initSource(source)
    this.stats.sources[source].success++
  }

  incrementSourceFailure(source) {
    this._initSource(source)
    this.stats.sources[source].failure++
  }

  incrementPlaybackEvent(eventType) {
    this.stats.playback.events[eventType] =
      (this.stats.playback.events[eventType] || 0) + 1
  }

  incrementRecoveryAttempt() {
    this.stats.playback.recovery.attempts++
  }

  incrementRecoverySuccess() {
    this.stats.playback.recovery.successes++
  }

  incrementRecoveryFailure() {
    this.stats.playback.recovery.failures++
  }
}
