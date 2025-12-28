import { GatewayEvents } from '../constants.js'
import { http1makeRequest, logger } from '../utils.js'

const TEST_URLS = [
  'http://cachefly.cachefly.net/10mb.test',
  'http://speedtest.tele2.net/10MB.zip',
  'http://ping.online.net/10Mo.dat',
  'http://proof.ovh.net/files/10Mb.dat'
]

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
      return
    }

    this.isChecking = true

    for (const url of TEST_URLS) {
      const startTime = Date.now()
      let downloadedBytes = 0

      try {
        const { stream, error, statusCode } = await http1makeRequest(
          url,
          {
            method: 'GET',
            streamOnly: true,
            timeout: this.config.timeout || 10000
          },
          this.nodelink
        )

        if (error || statusCode !== 200) {
          continue
        }

        await new Promise((resolve, reject) => {
          stream.on('data', (chunk) => {
            downloadedBytes += chunk.length
          })

          stream.on('end', () => {
            const endTime = Date.now()
            const durationSeconds = (endTime - startTime) / 1000

            if (durationSeconds === 0) {
              resolve()
              return
            }

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
            resolve()
          })

          stream.on('error', reject)
        })

        this.isChecking = false
        return
      } catch (e) {
        continue
      }
    }

    this.isChecking = false
    if (this.status !== 'disconnected') {
      this.status = 'disconnected'
      this.metrics = { error: 'All connection tests failed', timestamp: Date.now() }
      this.broadcastStatus()
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

    if (this.nodelink.sessions?.values) {
      for (const session of this.nodelink.sessions.values()) {
        if (session.socket) {
          session.socket.send(payloadStr)
        }
      }
    }
  }
}
