import { AggregatorRegistry, collectDefaultMetrics, Registry, Counter } from 'prom-client'
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
        events: {} // { TrackStartEvent: 10, ... }
      }
    }
    this.promRegister = new Registry();
    this.promCollectedStats = collectDefaultMetrics({ register: this.promRegister });
    
    // API Request Counter - tracks total API requests by endpoint
    this.promApiRequests = new Counter({
      name: 'nodelink_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['endpoint'],
      registers: [this.promRegister]
    })

    // API Error Counter - tracks total API errors by endpoint
    this.promApiErrors = new Counter({
      name: 'nodelink_api_errors_total',
      help: 'Total number of API errors',
      labelNames: ['endpoint'],
      registers: [this.promRegister]
    })

    // Source Request Counter - tracks source requests by source and status
    this.promSourceRequests = new Counter({
      name: 'nodelink_source_requests_total',
      help: 'Total number of source requests',
      labelNames: ['source', 'status'],
      registers: [this.promRegister]
    })

    // Playback Event Counter - tracks playback events by event type
    this.promPlaybackEvents = new Counter({
      name: 'nodelink_playback_events_total',
      help: 'Total number of playback events',
      labelNames: ['event_type'],
      registers: [this.promRegister]
    })

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
    this.promApiRequests.inc({ endpoint })
  }

  incrementApiError(endpoint) {
    this.stats.api.errors[endpoint] = (this.stats.api.errors[endpoint] || 0) + 1
    this.promApiErrors.inc({ endpoint })
  }

  incrementSourceSuccess(source) {
    this._initSource(source)
    this.stats.sources[source].success++
    this.promSourceRequests.inc({ source, status: 'success' })
  }

  incrementSourceFailure(source) {
    this._initSource(source)
    this.stats.sources[source].failure++
    this.promSourceRequests.inc({ source, status: 'failure' })
  }

  incrementPlaybackEvent(eventType) {
    this.stats.playback.events[eventType] =
      (this.stats.playback.events[eventType] || 0) + 1
    this.promPlaybackEvents.inc({ event_type: eventType })
  }
}
