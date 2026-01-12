import cluster from 'node:cluster'
import net from 'node:net'
import os from 'node:os'
import crypto from 'node:crypto'
import { logger } from '../utils.js'

class SourceWorkerManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.workers = []
    this.requests = new Map()
    this.workerLoads = new Map() // worker.id -> pending count
    this.socketPath = os.platform() === 'win32'
      ? `\\\\.\\pipe\\nodelink-source-${crypto.randomBytes(8).toString('hex')}`
      : `/tmp/nodelink-source-${crypto.randomBytes(8).toString('hex')}.sock`
    this.server = null
  }

  async start() {
    this.server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0)

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])

        while (buffer.length >= 6) {
          const idSize = buffer.readUInt8(0)
          const type = buffer.readUInt8(1)
          const payloadSize = buffer.readUInt32BE(2)
          const totalSize = 6 + idSize + payloadSize

          if (buffer.length < totalSize) break

          const id = buffer.toString('utf8', 6, 6 + idSize)
          const payload = buffer.subarray(6 + idSize, totalSize)
          buffer = buffer.subarray(totalSize)

          const request = this.requests.get(id)
          if (request) {
            if (type === 0) {
              if (!request.res.headersSent) {
                request.res.setHeader('Content-Type', 'application/json')
                request.res.writeHead(200)
              }
              request.res.write(payload)
            } else if (type === 1) { 
              request.res.end()
              this._decrementLoad(request.workerId)
              this.requests.delete(id)
              clearTimeout(request.timeout)
            } else if (type === 2) { 
              const errorMsg = payload.toString('utf8')
              request.res.writeHead(500, { 'Content-Type': 'application/json' })
              request.res.end(JSON.stringify({
                timestamp: Date.now(),
                status: 500,
                error: 'Worker Error',
                message: errorMsg,
                path: request.req.url
              }))
              this._decrementLoad(request.workerId)
              this.requests.delete(id)
              clearTimeout(request.timeout)
            }
          }
        }
      })
    })

    await new Promise((resolve, reject) => {
      this.server.on('error', (err) => {
        logger('error', 'SourceCluster', `Server error: ${err.message}`)
        reject(err)
      })
      this.server.listen(this.socketPath, () => {
        logger('info', 'SourceCluster', `Source server listening at ${this.socketPath}`)
        resolve()
      })
    })

    const processCount = this.nodelink.options.cluster?.specializedSourceWorker?.count || 1
    cluster.setupPrimary({ exec: './src/sourceWorker.js' })
    
    for (let i = 0; i < processCount; i++) {
      this._forkWorker()
    }

    cluster.setupPrimary({ exec: './src/index.js' })

    cluster.on('exit', (worker, code, signal) => {
      if (worker.workerType !== 'source') return
      
      logger('warn', 'SourceCluster', `Source worker manager ${worker.process.pid} exited. Respawning...`)
      const index = this.workers.indexOf(worker)
      if (index !== -1) this.workers.splice(index, 1)
      this.workerLoads.delete(worker.id)
      
      cluster.setupPrimary({ exec: './src/sourceWorker.js' })
      this._forkWorker()
      cluster.setupPrimary({ exec: './src/index.js' })
    })
  }

  _forkWorker() {
    const worker = cluster.fork()
    worker.workerType = 'source'
    worker.on('message', (msg) => {
      if (msg.type === 'ready') logger('info', 'SourceCluster', `Source worker manager ${msg.pid} ready`)
    })
    this.workers.push(worker)
    this.workerLoads.set(worker.id, 0)
  }

  _decrementLoad(workerId) {
    const load = this.workerLoads.get(workerId) || 0
    this.workerLoads.set(workerId, Math.max(0, load - 1))
  }

  delegate(req, res, task, payload) {
    const id = crypto.randomBytes(16).toString('hex')
    
    let bestWorker = null
    let minLoad = Number.POSITIVE_INFINITY

    for (const worker of this.workers) {
      const load = this.workerLoads.get(worker.id) || 0
      if (load < minLoad) {
        minLoad = load
        bestWorker = worker
      }
    }

    if (!bestWorker) return false

    const timeout = setTimeout(() => {
      if (this.requests.has(id)) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Gateway Timeout', message: 'Source worker timed out' }))
        this._decrementLoad(bestWorker.id)
        this.requests.delete(id)
      }
    }, 60000)

    this.requests.set(id, { req, res, timeout, workerId: bestWorker.id })
    this.workerLoads.set(bestWorker.id, minLoad + 1)

    bestWorker.send({
      type: 'sourceTask',
      payload: {
        id,
        task,
        payload,
        socketPath: this.socketPath
      }
    })

    return true
  }
}

export default SourceWorkerManager
