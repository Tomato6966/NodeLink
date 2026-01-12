import net from 'node:net'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import * as utils from './utils.js'

const __filename = fileURLToPath(import.meta.url)

if (isMainThread) {
  let config
  try {
    config = (await import('../config.js')).default
  } catch {
    config = (await import('../config.default.js')).default
  }

  const specConfig = config.cluster?.specializedSourceWorker || {}
  
  utils.initLogger(config)

  const nodelink = {
    options: config,
    logger: utils.logger
  }

  const threadCount = specConfig.microWorkers || Math.min(2, os.cpus().length)
  const TASKS_PER_WORKER = specConfig.tasksPerWorker || 32
  const workerPool = []
  const taskQueue = []

  nodelink.logger('info', 'SourceWorker', `Spawning ${threadCount} micro-workers for API tasks...`)

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(__filename, {
      workerData: { config, silentLogs: specConfig.silentLogs, threadId: i + 1 }
    })
    
    worker.ready = false
    worker.load = 0

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        worker.ready = true
        nodelink.logger('info', 'SourceWorker', `Micro-worker ${i + 1} is ready.`)
        processNextTask()
      } else if (msg.type === 'result') {
        const { socketPath, id, result, error } = msg
        finishTask(socketPath, id, result, error)
        
        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      }
    })

    workerPool.push(worker)
  }

  const sockets = new Map()

  async function getSocket(path) {
    if (sockets.has(path)) return sockets.get(path)
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path, () => {
        sockets.set(path, socket)
        resolve(socket)
      })
      socket.on('error', reject)
      socket.on('close', () => sockets.delete(path))
    })
  }

  function finishTask(socketPath, id, result, error) {
    getSocket(socketPath).then((socket) => {
      if (error) {
        sendFrame(socket, id, 2, Buffer.from(error, 'utf8'))
      } else {
        // result is already a string
        sendFrame(socket, id, 0, Buffer.from(result, 'utf8'))
        sendFrame(socket, id, 1, Buffer.alloc(0))
      }
    }).catch(e => {
      utils.logger('error', 'SourceWorker', `Failed to send result back: ${e.message}`)
    })
  }

  function sendFrame(socket, id, type, payloadBuf) {
    const idBuf = Buffer.from(id, 'utf8')
    
    const header = Buffer.alloc(6)
    header.writeUInt8(idBuf.length, 0)
    header.writeUInt8(type, 1)
    header.writeUInt32BE(payloadBuf.length, 2)
    
    socket.write(Buffer.concat([header, idBuf, payloadBuf]))
  }

  function processNextTask() {
    if (taskQueue.length === 0) return
    
    let bestWorker = null
    let minLoad = Infinity

    for (const worker of workerPool) {
      if (worker.ready && worker.load < TASKS_PER_WORKER && worker.load < minLoad) {
        bestWorker = worker
        minLoad = worker.load
      }
    }
    
    if (bestWorker) {
      const task = taskQueue.shift()
      bestWorker.load++
      bestWorker.postMessage(task)
      
      if (taskQueue.length > 0) setImmediate(processNextTask)
    }
  }

  process.on('message', (msg) => {
    if (msg.type !== 'sourceTask') return
    taskQueue.push(msg.payload)
    processNextTask()
  })

  process.send({ type: 'ready', pid: process.pid })

} else {
  const { config, silentLogs, threadId } = workerData
  
  if (silentLogs) {
    config.logging = { ...config.logging, level: 'warn' }
  }
  utils.initLogger(config)

  const nodelink = {
    options: config,
    logger: utils.logger
  }

  const [
    { default: SourceManager },
    { default: LyricsManager },
    { default: CredentialManager },
    { default: RoutePlannerManager },
    { default: StatsManager }
  ] = await Promise.all([
    import('./managers/sourceManager.js'),
    import('./managers/lyricsManager.js'),
    import('./managers/credentialManager.js'),
    import('./managers/routePlannerManager.js'),
    import('./managers/statsManager.js')
  ])

  nodelink.statsManager = new StatsManager(nodelink)
  nodelink.credentialManager = new CredentialManager(nodelink)
  nodelink.routePlanner = new RoutePlannerManager(nodelink)
  nodelink.sources = new SourceManager(nodelink)
  nodelink.lyrics = new LyricsManager(nodelink)

  await nodelink.credentialManager.load()
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()

  parentPort.postMessage({ type: 'ready' })

  parentPort.on('message', async (taskData) => {
    const { id, task, payload, socketPath } = taskData
    
    try {
      let result
      switch (task) {
        case 'resolve':
          result = await nodelink.sources.resolve(payload.url)
          break
        case 'search':
          result = await nodelink.sources.search(payload.source, payload.query)
          break
        case 'unifiedSearch':
          result = await nodelink.sources.unifiedSearch(payload.query)
          break
                  case 'loadLyrics':
                  result = await nodelink.lyrics.loadLyrics(payload.decodedTrack, payload.language)
                  break
              }
              parentPort.postMessage({ type: 'result', id, socketPath, result: JSON.stringify(result) })
        
    } catch (e) {
      parentPort.postMessage({ type: 'result', id, socketPath, error: e.message })
    }
  })
}