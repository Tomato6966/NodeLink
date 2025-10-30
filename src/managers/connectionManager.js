import { GatewayEvents } from '../constants.js'
import { http1makeRequest, logger } from '../utils.js'

const TEST_FILE_URL = 'http://cachefly.cachefly.net/10mb.test'

export default class ConnectionManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.connection || {}
    this.interval = null
    this.status = 'unknown'
    this.metrics = {}
    this.isChecking = false
  }

  start() {
    const checkInterval = Math.max(1, this.config.interval || 300000)
    if (checkInterval > 0) {
      logger(
        'info',
        'ConnectionManager',
        `Starting connection checks every ${checkInterval}ms.`
      )
      this.checkConnection()
      this.interval = setInterval(() => this.checkConnection(), checkInterval)
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  async checkConnection() {
    if (this.isChecking) {
      logger(
        'debug',
        'ConnectionManager',
        'Connection check already in progress.'
      )
      return
    }

    this.isChecking = true

    const startTime = Date.now()
    let downloadedBytes = 0

    try {
      const { stream, error, statusCode } = await http1makeRequest(
        TEST_FILE_URL,
        {
          method: 'GET',
          streamOnly: true,
          timeout: this.config.timeout || 10000
        },
        this.nodelink
      )

      if (error || statusCode !== 200) {
        throw new Error(
          `Failed to download test file: ${error?.message || `Status code ${statusCode}`}`
        )
      }

      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length
      })

      stream.on('end', () => {
        this.isChecking = false
        const endTime = Date.now()
        const durationSeconds = (endTime - startTime) / 1000

        if (durationSeconds === 0) return

        const speedBps = downloadedBytes / durationSeconds
        const speedKbps = (speedBps * 8) / 1024
        const speedMbps = speedKbps / 1024

        let newStatus = 'good'
        if (speedMbps < (this.config.thresholds?.bad ?? 1)) {
          newStatus = 'bad'
        } else if (speedMbps < (this.config.thresholds?.average ?? 5)) {
          newStatus = 'average'
        }

        this.metrics = {
          speed: {
            bps: speedBps,
            kbps: speedKbps,
            mbps: Number.parseFloat(speedMbps.toFixed(2))
          },
          downloadedBytes,
          durationSeconds: Number.parseFloat(durationSeconds.toFixed(2)),
          timestamp: Date.now()
        }

        const shouldLog = this.config.logAllChecks || newStatus !== this.status
        if (shouldLog) {
          if (newStatus === 'bad') {
            logger(
              'warn',
              'Network',
              `Your internet connection is very slow (${speedMbps.toFixed(2)} Mbps).`
            )
            logger(
              'warn',
              'Network',
              'This will cause performance issues and poor stream quality.'
            )
            logger(
              'warn',
              'Network',
              'Try switching to a different network or deploying the server to a cloud instance with high-speed internet.'
            )
          } else {
            logger(
              'network',
              'ConnectionManager',
              `Connection speed: ${this.metrics.speed.mbps} Mbps (${newStatus})`
            )
          }
        }

        if (newStatus !== this.status) {
          this.status = newStatus
          this.broadcastStatus()
        }
      })

      stream.on('error', (err) => {
        this.isChecking = false
        const errorMessage = `Stream error during download: ${err.message}`
        logger(
          'error',
          'ConnectionManager',
          `Connection check failed: ${errorMessage}`
        )
        if (this.status !== 'disconnected') {
          this.status = 'disconnected'
          this.metrics = { error: errorMessage, timestamp: Date.now() }
          this.broadcastStatus()
        }
      })
    } catch (e) {
      this.isChecking = false
      logger(
        'error',
        'ConnectionManager',
        `Connection check failed: ${e.message}`
      )
      if (this.status !== 'disconnected') {
        this.status = 'disconnected'
        this.metrics = { error: e.message, timestamp: Date.now() }
        this.broadcastStatus()
      }
    }
  }

  broadcastStatus() {
    const payload = {
      op: 'event',
      type: GatewayEvents.CONNECTION_STATUS,
      status: this.status,
      metrics: this.metrics
    }

    const payloadStr = JSON.stringify(payload)

    for (const session of this.nodelink.sessions.values()) {
      if (session.socket) {
        session.socket.send(payloadStr)
      }
    }
  }
}
