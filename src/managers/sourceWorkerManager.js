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
        if (err.code === 'EACCES') {
          logger('error', 'SourceCluster', 'Permission denied when creating local socket. Try running as administrator or choosing a different pipe name.')
        }
        reject(err)
      })
      this.server.listen(this.socketPath, () => {
        logger('info', 'SourceCluster', `Source server listening at ${this.socketPath}`)
        resolve()
      })
    })

    cluster.setupPrimary({ exec: './src/sourceWorker.js' })
    const worker = cluster.fork()
    worker.workerType = 'source'
    worker.on('message', (msg) => {
      if (msg.type === 'ready') logger('info', 'SourceCluster', `Source worker manager ${msg.pid} ready`)
    })
    this.workers.push(worker)

    cluster.setupPrimary({ exec: './src/index.js' })

    cluster.on('exit', (worker, code, signal) => {
      if (worker.workerType !== 'source') return
      
      logger('warn', 'SourceCluster', `Source worker manager ${worker.process.pid} exited. Respawning...`)
      const index = this.workers.indexOf(worker)
      if (index !== -1) this.workers.splice(index, 1)
      
      cluster.setupPrimary({ exec: './src/sourceWorker.js' })
      const newWorker = cluster.fork()
      newWorker.workerType = 'source'
      this.workers.push(newWorker)
      cluster.setupPrimary({ exec: './src/index.js' })
    })
  }

  delegate(req, res, task, payload) {
    const id = crypto.randomBytes(16).toString('hex')
    const worker = this.workers[0]

    if (!worker) return false

    const timeout = setTimeout(() => {
      if (this.requests.has(id)) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Gateway Timeout', message: 'Source worker timed out' }))
        this.requests.delete(id)
      }
    }, 60000)

    this.requests.set(id, { req, res, timeout })

    worker.send({
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
