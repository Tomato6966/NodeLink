import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from 'node:worker_threads'
import * as utils from '../utils.js'

const __filename = fileURLToPath(import.meta.url)

if (isMainThread) {
  let config
  try {
    config = (await import('../../config.js')).default
  } catch {
    config = (await import('../../config.default.js')).default
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

  nodelink.logger(
    'info',
    'SourceWorker',
    `Spawning ${threadCount} micro-workers for API tasks...`
  )

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(__filename, {
      workerData: { config, silentLogs: specConfig.silentLogs, threadId: i + 1 }
    })

    worker.ready = false
    worker.load = 0

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        worker.ready = true
        nodelink.logger(
          'info',
          'SourceWorker',
          `Micro-worker ${i + 1} is ready.`
        )
        processNextTask()
      } else if (msg.type === 'result') {
        const { socketPath, id, result, error } = msg
        finishTask(socketPath, id, result, error)

        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      } else if (msg.type === 'stream') {
        sendStreamChunk(msg.socketPath, msg.id, msg.chunk)
      } else if (msg.type === 'chatAction') {
        sendChatAction(msg.socketPath, msg.id, msg.data)
      } else if (msg.type === 'end') {
        sendStreamEnd(msg.socketPath, msg.id)
        worker.load = Math.max(0, worker.load - 1)
        processNextTask()
      } else if (msg.type === 'error') {
        sendStreamError(msg.socketPath, msg.id, msg.error)
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

  function withSocket(path, handler) {
    const socket = sockets.get(path)
    if (socket) {
      handler(socket)
      return
    }
    getSocket(path)
      .then(handler)
      .catch((e) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send data back: ${e.message}`
        )
      })
  }

  function finishTask(socketPath, id, result, error) {
    getSocket(socketPath)
      .then((socket) => {
        if (error) {
          sendFrame(socket, id, 2, Buffer.from(error, 'utf8'))
        } else {
          // result is already a string
          sendFrame(socket, id, 0, Buffer.from(result, 'utf8'))
          sendFrame(socket, id, 1, Buffer.alloc(0))
        }
      })
      .catch((e) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send result back: ${e.message}`
        )
      })
  }

  function sendStreamChunk(socketPath, id, chunk) {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    withSocket(socketPath, (socket) => sendFrame(socket, id, 0, payload))
  }

  function sendChatAction(socketPath, id, data) {
    const payload = Buffer.from(JSON.stringify(data), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 3, payload))
  }

  function sendStreamEnd(socketPath, id) {
    withSocket(socketPath, (socket) =>
      sendFrame(socket, id, 1, Buffer.alloc(0))
    )
  }

  function sendStreamError(socketPath, id, error) {
    const errorBuf = Buffer.from(String(error || 'Unknown error'), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 2, errorBuf))
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
      if (
        worker.ready &&
        worker.load < TASKS_PER_WORKER &&
        worker.load < minLoad
      ) {
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
    { createPCMStream },
    { default: SourceManager },
    { default: LyricsManager },
    { default: MeaningManager },
    { default: CredentialManager },
    { default: TrackCacheManager },
    { default: RoutePlannerManager },
    { default: StatsManager }
  ] = await Promise.all([
    import('../playback/processing/streamProcessor.js'),
    import('../managers/sourceManager.js'),
    import('../managers/lyricsManager.js'),
    import('../managers/meaningManager.js'),
    import('../managers/credentialManager.js'),
    import('../managers/trackCacheManager.js'),
    import('../managers/routePlannerManager.js'),
    import('../managers/statsManager.js')
  ])

  nodelink.statsManager = new StatsManager(nodelink)
  nodelink.credentialManager = new CredentialManager(nodelink)
  nodelink.trackCacheManager = new TrackCacheManager(nodelink)
  nodelink.routePlanner = new RoutePlannerManager(nodelink)
  nodelink.sources = new SourceManager(nodelink)
  nodelink.lyrics = new LyricsManager(nodelink)
  nodelink.meanings = new MeaningManager(nodelink)

  await nodelink.credentialManager.load()
  await nodelink.trackCacheManager.load()
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()
  await nodelink.meanings.loadFolder()

  const activeChats = new Map()

  parentPort.postMessage({ type: 'ready' })

  const sendStreamChunkFromWorker = (id, socketPath, chunk) => {
    parentPort.postMessage({ type: 'stream', id, socketPath, chunk })
  }

  const sendStreamEndFromWorker = (id, socketPath) => {
    parentPort.postMessage({ type: 'end', id, socketPath })
  }

  const sendStreamErrorFromWorker = (id, socketPath, error) => {
    parentPort.postMessage({
      type: 'error',
      id,
      socketPath,
      error: String(error || 'Unknown error')
    })
  }

  const handleLiveChat = async (id, socketPath, payload) => {
    const videoId = payload.videoId
    const yt = nodelink.sources.getSource('youtube')
    if (!yt) throw new Error('YouTube source not available in worker')

    activeChats.set(id, true)

    try {
      const chat = await yt.liveChat.getLiveChat(videoId)
      if (!chat) throw new Error('Could not initialize live chat')

      const pollLoop = async () => {
        while (activeChats.has(id)) {
          try {
            const result = await chat.poll()
            if (!result) break

            const { actions, timeoutMs } = result

            if (actions.length > 0 && activeChats.has(id)) {
              utils.logger('debug', 'SourceWorker', `[${id}] Sending ${actions.length} actions for ${videoId}`)
              parentPort.postMessage({ type: 'chatAction', id, socketPath, data: { op: 'actions', actions } })
            }

            await new Promise(resolve => setTimeout(resolve, timeoutMs || 5000))
          } catch (e) {
            utils.logger('error', 'SourceWorker', `[${id}] Polling exception for ${videoId}: ${e.message}`)
            break
          }
        }
      }

      await pollLoop()

      parentPort.postMessage({ type: 'end', id, socketPath })
    } catch (e) {
      sendStreamErrorFromWorker(id, socketPath, e.message)
    } finally {
      activeChats.delete(id)
    }
  }

  const handleLoadStream = async (id, socketPath, payload) => {
    let fetched = null
    let pcmStream = null
    let finished = false

    const cleanup = () => {
      if (pcmStream && !pcmStream.destroyed) pcmStream.destroy()
      if (fetched?.stream && !fetched.stream.destroyed) fetched.stream.destroy()
    }

    const finish = (err) => {
      if (finished) return
      finished = true
      if (err) {
        sendStreamErrorFromWorker(id, socketPath, err.message || err)
      } else {
        sendStreamEndFromWorker(id, socketPath)
      }
      cleanup()
    }

    try {
      const trackInfo = payload?.decodedTrackInfo
      if (!trackInfo) {
        throw new Error('Invalid encoded track')
      }

      const urlResult = await nodelink.sources.getTrackUrl(trackInfo)
      if (urlResult.exception) {
        throw new Error(
          urlResult.exception.message || 'Failed to get track URL'
        )
      }

      const additionalData = {
        ...(urlResult.additionalData || {}),
        startTime: payload?.position || 0
      }

      fetched = await nodelink.sources.getTrackStream(
        urlResult.newTrack?.info || trackInfo,
        urlResult.url,
        urlResult.protocol,
        additionalData
      )

      if (fetched.exception) {
        throw new Error(fetched.exception.message || 'Failed to load stream')
      }

      pcmStream = createPCMStream(
        fetched.stream,
        fetched.type || urlResult.format,
        nodelink,
        (payload?.volume ?? 100) / 100,
        payload?.filters || {}
      )

      pcmStream.on('data', (chunk) => {
        if (!finished) sendStreamChunkFromWorker(id, socketPath, chunk)
      })

      pcmStream.once('end', () => finish())
      pcmStream.once('error', (err) => finish(err))
      pcmStream.once('close', () => finish())
    } catch (err) {
      finish(err)
    }
  }

  parentPort.on('message', async (taskData) => {
    const { id, task, payload, socketPath } = taskData

    if (task === 'loadStream') {
      try {
        await handleLoadStream(id, socketPath, payload)
      } catch (e) {
        sendStreamErrorFromWorker(id, socketPath, e.message || e)
      }
      return
    }

    if (task === 'loadLiveChat') {
      try {
        await handleLiveChat(id, socketPath, payload)
      } catch (e) {
        sendStreamErrorFromWorker(id, socketPath, e.message || e)
      }
      return
    }

    if (task === 'cancelLiveChat') {
      activeChats.delete(payload.id)
      return
    }

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
          result = await nodelink.lyrics.loadLyrics(
            { info: payload.decodedTrackInfo },
            payload.language
          )
          break
        case 'loadMeaning':
          result = await nodelink.meanings.loadMeaning(
            { info: payload.decodedTrackInfo },
            payload.language
          )
          break
        case 'loadChapters':
          result = await nodelink.sources.getChapters({
            info: payload.decodedTrackInfo
          })
          break
      }
      parentPort.postMessage({
        type: 'result',
        id,
        socketPath,
        result: JSON.stringify(result)
      })
    } catch (e) {
      parentPort.postMessage({
        type: 'result',
        id,
        socketPath,
        error: e.message
      })
    }
  })
}
