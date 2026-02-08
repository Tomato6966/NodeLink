import type { Socket } from 'node:net'
import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { MessagePort } from 'node:worker_threads'
import {
  isMainThread,
  parentPort,
  workerData as rawWorkerData,
  Worker
} from 'node:worker_threads'
import type { NodeLink } from '../typings/player.types.ts'
import type {
  FrameType,
  LiveChatPayload,
  LiveChatPollResult,
  LoadStreamPayload,
  MicroWorker,
  SocketMap,
  SourceWorkerConfig,
  TaskData,
  TrackInfo,
  WorkerData,
  WorkerMessageType,
  WorkerNodeLink
} from '../typings/source.types.ts'
import * as utils from '../utils.js'

const __filename = fileURLToPath(import.meta.url)

/**
 * Main thread - Source Worker Manager
 * Spawns and manages a pool of micro-workers for handling source API tasks
 */
if (isMainThread) {
  /**
   * Loads NodeLink configuration
   * @returns Configuration object
   * @internal
   */
  async function loadConfig(): Promise<Record<string, unknown>> {
    try {
      return (await import('../../config.js')).default
    } catch {
      return (await import('../../config.default.js')).default
    }
  }

  const config = await loadConfig()
  const specConfig: SourceWorkerConfig =
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    (config['cluster'] as Record<string, SourceWorkerConfig> | undefined)?.[
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
      'specializedSourceWorker'
    ] || {}

  utils.initLogger(config)

  const nodelink: Pick<WorkerNodeLink, 'options' | 'logger'> = {
    options: config,
    logger: utils.logger
  }

  const threadCount = specConfig.microWorkers ?? Math.min(2, os.cpus().length)
  const TASKS_PER_WORKER = specConfig.tasksPerWorker ?? 32
  const workerPool: MicroWorker[] = []
  const taskQueue: TaskData[] = []

  nodelink.logger(
    'info',
    'SourceWorker',
    `Spawning ${threadCount} micro-workers for API tasks...`
  )

  /**
   * Spawns micro-workers and sets up message handling
   * @internal
   */
  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(__filename, {
      workerData: {
        config,
        silentLogs: specConfig.silentLogs ?? false,
        threadId: i + 1
      } satisfies WorkerData
    }) as MicroWorker

    worker.ready = false
    worker.load = 0

    worker.on('message', (msg: WorkerMessageType) => {
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

  const sockets: SocketMap = new Map()

  /**
   * Gets or creates a Unix socket connection to the specified path
   * @param path - Unix socket path
   * @returns Promise resolving to connected socket
   * @internal
   */
  async function getSocket(path: string): Promise<Socket> {
    const existing = sockets.get(path)
    if (existing) return existing

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path, () => {
        sockets.set(path, socket)
        resolve(socket)
      })
      socket.on('error', reject)
      socket.on('close', () => sockets.delete(path))
    })
  }

  /**
   * Executes handler with socket, creating connection if needed
   * @param path - Unix socket path
   * @param handler - Function to execute with socket
   * @internal
   */
  function withSocket(path: string, handler: (socket: Socket) => void): void {
    const socket = sockets.get(path)
    if (socket) {
      handler(socket)
      return
    }
    getSocket(path)
      .then(handler)
      .catch((e: Error) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send data back: ${e.message}`
        )
      })
  }

  /**
   * Sends task completion result or error back through socket
   * @param socketPath - Unix socket path
   * @param id - Task identifier
   * @param result - Result data (JSON string)
   * @param error - Error message if task failed
   * @internal
   */
  function finishTask(
    socketPath: string,
    id: string,
    result: string | undefined,
    error: string | undefined
  ): void {
    getSocket(socketPath)
      .then((socket) => {
        if (error) {
          sendFrame(socket, id, 2, Buffer.from(error, 'utf8'))
        } else if (result) {
          sendFrame(socket, id, 0, Buffer.from(result, 'utf8'))
          sendFrame(socket, id, 1, Buffer.alloc(0))
        }
      })
      .catch((e: Error) => {
        utils.logger(
          'error',
          'SourceWorker',
          `Failed to send result back: ${e.message}`
        )
      })
  }

  /**
   * Sends a stream data chunk through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @param chunk - Data chunk (Buffer or string)
   * @internal
   */
  function sendStreamChunk(
    socketPath: string,
    id: string,
    chunk: Buffer | string
  ): void {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    withSocket(socketPath, (socket) => sendFrame(socket, id, 0, payload))
  }

  /**
   * Sends live chat action data through socket
   * @param socketPath - Unix socket path
   * @param id - Chat session identifier
   * @param data - Chat action data
   * @internal
   */
  function sendChatAction(
    socketPath: string,
    id: string,
    data: { op: 'actions'; actions: Array<Record<string, unknown>> }
  ): void {
    const payload = Buffer.from(JSON.stringify(data), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 3, payload))
  }

  /**
   * Sends stream end signal through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @internal
   */
  function sendStreamEnd(socketPath: string, id: string): void {
    withSocket(socketPath, (socket) =>
      sendFrame(socket, id, 1, Buffer.alloc(0))
    )
  }

  /**
   * Sends stream error through socket
   * @param socketPath - Unix socket path
   * @param id - Stream identifier
   * @param error - Error message
   * @internal
   */
  function sendStreamError(
    socketPath: string,
    id: string,
    error: string
  ): void {
    const errorBuf = Buffer.from(String(error || 'Unknown error'), 'utf8')
    withSocket(socketPath, (socket) => sendFrame(socket, id, 2, errorBuf))
  }

  /**
   * Sends a framed message through socket
   *
   * Frame format:
   * - Byte 0: ID length (1 byte)
   * - Byte 1: Frame type (1 byte) - 0=data, 1=end, 2=error, 3=chat
   * - Bytes 2-5: Payload length (4 bytes, big-endian)
   * - Following bytes: ID string (variable length)
   * - Following bytes: Payload data (variable length)
   *
   * @param socket - Connected socket
   * @param id - Message/stream identifier
   * @param type - Frame type (0=data, 1=end, 2=error, 3=chat)
   * @param payloadBuf - Payload buffer
   * @internal
   */
  function sendFrame(
    socket: Socket,
    id: string,
    type: FrameType,
    payloadBuf: Buffer
  ): void {
    const idBuf = Buffer.from(id, 'utf8')

    const header = Buffer.alloc(6)
    header.writeUInt8(idBuf.length, 0)
    header.writeUInt8(type, 1)
    header.writeUInt32BE(payloadBuf.length, 2)

    socket.write(Buffer.concat([header, idBuf, payloadBuf]))
  }

  /**
   * Processes next task in queue by assigning to least-loaded worker
   * @internal
   */
  function processNextTask(): void {
    if (taskQueue.length === 0) return

    let bestWorker: MicroWorker | null = null
    let minLoad = Number.POSITIVE_INFINITY

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
      if (task) {
        bestWorker.load++
        bestWorker.postMessage(task)

        if (taskQueue.length > 0) setImmediate(processNextTask)
      }
    }
  }

  /**
   * Handles incoming IPC messages from parent process
   */
  process.on('message', (msg: { type: string; payload?: TaskData }) => {
    if (msg.type !== 'sourceTask') return
    if (msg.payload) {
      taskQueue.push(msg.payload)
      processNextTask()
    }
  })

  /**
   * Notify parent that worker is ready
   */
  try {
    process.send?.({ type: 'ready', pid: process.pid })
  } catch {
    // Ignore send failures (e.g., when not forked)
  }
} else {
  /**
   * Worker thread - Micro-worker for executing source API tasks
   * Each micro-worker initializes its own source managers and processes tasks
   */

  const workerData = rawWorkerData as WorkerData
  const { config, silentLogs } = workerData

  if (silentLogs) {
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
    config['logging'] = {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires index signature access
      ...(config['logging'] as Record<string, unknown>),
      level: 'warn'
    }
  }
  utils.initLogger(config)

  const nodelink: WorkerNodeLink = {
    options: config,
    logger: utils.logger
  }

  /**
   * Dynamically imports and initializes all required managers
   * @internal
   */
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
    import('../playback/processing/streamProcessor.ts'),
    import('../managers/sourceManager.js'),
    import('../managers/lyricsManager.js'),
    import('../managers/meaningManager.js'),
    import('../managers/credentialManager.ts'),
    import('../managers/trackCacheManager.ts'),
    import('../managers/routePlannerManager.js'),
    import('../managers/statsManager.ts')
  ])

  nodelink.statsManager = new StatsManager(
    nodelink
  ) as unknown as WorkerNodeLink['statsManager']
  nodelink.credentialManager = new CredentialManager(nodelink)
  nodelink.trackCacheManager = new TrackCacheManager(nodelink)
  nodelink.routePlanner = new RoutePlannerManager(
    nodelink
  ) as unknown as WorkerNodeLink['routePlanner']
  nodelink.sources = new SourceManager(nodelink)
  nodelink.lyrics = new LyricsManager(nodelink)
  nodelink.meanings = new MeaningManager(nodelink)

  await nodelink.credentialManager.load()
  await nodelink.trackCacheManager.load()
  await nodelink.sources.loadFolder()
  await nodelink.lyrics.loadFolder()
  await nodelink.meanings.loadFolder()

  /**
   * Active live chat sessions (session ID -> active flag)
   * @internal
   */
  const activeChats = new Map<string, boolean>()

  // Notify parent that worker is ready
  ;(parentPort as MessagePort).postMessage({ type: 'ready' })

  /**
   * Sends stream data chunk to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @param chunk - Data chunk
   * @internal
   */
  const sendStreamChunkFromWorker = (
    id: string,
    socketPath: string,
    chunk: Buffer
  ): void => {
    ;(parentPort as MessagePort).postMessage({
      type: 'stream',
      id,
      socketPath,
      chunk
    })
  }

  /**
   * Sends stream end signal to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @internal
   */
  const sendStreamEndFromWorker = (id: string, socketPath: string): void => {
    ;(parentPort as MessagePort).postMessage({
      type: 'end',
      id,
      socketPath
    })
  }

  /**
   * Sends stream error to parent thread
   * @param id - Stream identifier
   * @param socketPath - Unix socket path
   * @param error - Error message or object
   * @internal
   */
  const sendStreamErrorFromWorker = (
    id: string,
    socketPath: string,
    error: string | Error
  ): void => {
    ;(parentPort as MessagePort).postMessage({
      type: 'error',
      id,
      socketPath,
      error: String(error || 'Unknown error')
    })
  }

  /**
   * Handles YouTube live chat streaming task
   *
   * Continuously polls for new chat messages and sends them back
   * to the parent thread until the chat is cancelled or an error occurs.
   *
   * @param id - Chat session identifier
   * @param socketPath - Unix socket path for responses
   * @param payload - Live chat task payload
   * @internal
   */
  const handleLiveChat = async (
    id: string,
    socketPath: string,
    payload: LiveChatPayload
  ): Promise<void> => {
    const videoId = payload.videoId
    const yt = nodelink.sources?.getSource('youtube')
    if (!yt) throw new Error('YouTube source not available in worker')

    activeChats.set(id, true)

    try {
      const chat = await yt.liveChat.getLiveChat(videoId)
      if (!chat) throw new Error('Could not initialize live chat')

      const pollLoop = async (): Promise<void> => {
        while (activeChats.has(id)) {
          try {
            const result: LiveChatPollResult | null = await chat.poll()
            if (!result) break

            const { actions, timeoutMs } = result

            if (actions.length > 0 && activeChats.has(id)) {
              utils.logger(
                'debug',
                'SourceWorker',
                `[${id}] Sending ${actions.length} actions for ${videoId}`
              )
              ;(parentPort as MessagePort).postMessage({
                type: 'chatAction',
                id,
                socketPath,
                data: { op: 'actions', actions }
              })
            }

            await new Promise((resolve) =>
              setTimeout(resolve, timeoutMs || 5000)
            )
          } catch (e) {
            const err = e as Error
            utils.logger(
              'error',
              'SourceWorker',
              `[${id}] Polling exception for ${videoId}: ${err.message}`
            )
            break
          }
        }
      }

      await pollLoop()
      ;(parentPort as MessagePort).postMessage({ type: 'end', id, socketPath })
    } catch (e) {
      const err = e as Error
      sendStreamErrorFromWorker(id, socketPath, err.message)
    } finally {
      activeChats.delete(id)
    }
  }

  /**
   * Handles track stream loading and PCM conversion
   *
   * Resolves track URL, fetches the stream, converts to PCM audio,
   * and streams chunks back to the parent thread.
   *
   * @param id - Stream identifier
   * @param socketPath - Unix socket path for streaming
   * @param payload - Load stream task payload
   * @internal
   */
  const handleLoadStream = async (
    id: string,
    socketPath: string,
    payload: LoadStreamPayload
  ): Promise<void> => {
    let fetched: Awaited<
      ReturnType<typeof nodelink.sources.getTrackStream>
    > | null = null
    let pcmStream: ReturnType<typeof createPCMStream> | null = null
    let finished = false

    const cleanup = (): void => {
      if (pcmStream && !pcmStream.destroyed) pcmStream.destroy()
      if (fetched?.stream && !fetched.stream.destroyed) fetched.stream.destroy()
    }

    const finish = (err?: Error | string | null): void => {
      if (finished) return
      finished = true
      if (err) {
        const errMsg = typeof err === 'string' ? err : err.message
        sendStreamErrorFromWorker(id, socketPath, errMsg)
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

      const urlResult = await nodelink.sources?.getTrackUrl(trackInfo)
      if (!urlResult || urlResult.exception) {
        throw new Error(
          urlResult?.exception?.message || 'Failed to get track URL'
        )
      }

      const additionalData = {
        ...(urlResult.additionalData || {}),
        startTime: payload?.position || 0
      }

      fetched =
        (await nodelink.sources?.getTrackStream(
          urlResult.newTrack?.info || trackInfo,
          urlResult.url,
          urlResult.protocol,
          additionalData
        )) || null

      if (!fetched || fetched.exception) {
        throw new Error(fetched?.exception?.message || 'Failed to load stream')
      }

      pcmStream = createPCMStream(
        fetched.stream,
        fetched.type || (urlResult.format as string) || 'unknown',
        nodelink as unknown as NodeLink,
        (payload?.volume ?? 100) / 100,
        payload?.filters || {}
      )

      pcmStream.on('data', (chunk: Buffer) => {
        if (!finished) sendStreamChunkFromWorker(id, socketPath, chunk)
      })

      pcmStream.once('end', () => finish())
      pcmStream.once('error', (err: Error) => finish(err))
      pcmStream.once('close', () => finish())
    } catch (err) {
      finish(err as Error)
    }
  }

  /**
   * Handles incoming task messages from parent thread
   */
  ;(parentPort as MessagePort).on('message', async (taskData: TaskData) => {
    const { id, task, payload, socketPath } = taskData

    if (task === 'loadStream') {
      try {
        await handleLoadStream(id, socketPath, payload as LoadStreamPayload)
      } catch (e) {
        const err = e as Error
        sendStreamErrorFromWorker(id, socketPath, err.message || err)
      }
      return
    }

    if (task === 'loadLiveChat') {
      try {
        await handleLiveChat(id, socketPath, payload as LiveChatPayload)
      } catch (e) {
        const err = e as Error
        sendStreamErrorFromWorker(id, socketPath, err.message || err)
      }
      return
    }

    if (task === 'cancelLiveChat') {
      activeChats.delete((payload as { id: string }).id)
      return
    }

    try {
      let result: unknown
      switch (task) {
        case 'resolve':
          result = await nodelink.sources?.resolve(
            (payload as { url: string }).url
          )
          break
        case 'search':
          result = await nodelink.sources?.search(
            (payload as { source: string; query: string }).source,
            (payload as { source: string; query: string }).query
          )
          break
        case 'unifiedSearch':
          result = await nodelink.sources?.unifiedSearch(
            (payload as { query: string }).query
          )
          break
        case 'loadLyrics':
          result = await nodelink.lyrics?.loadLyrics(
            {
              info: (payload as { decodedTrackInfo: TrackInfo })
                .decodedTrackInfo
            },
            (payload as { language?: string }).language
          )
          break
        case 'loadMeaning':
          result = await nodelink.meanings?.loadMeaning(
            {
              info: (payload as { decodedTrackInfo: TrackInfo })
                .decodedTrackInfo
            },
            (payload as { language?: string }).language
          )
          break
        case 'loadChapters':
          result = await nodelink.sources?.getChapters({
            info: (payload as { decodedTrackInfo: TrackInfo }).decodedTrackInfo
          })
          break
      }
      ;(parentPort as MessagePort).postMessage({
        type: 'result',
        id,
        socketPath,
        result: JSON.stringify(result)
      })
    } catch (e) {
      const err = e as Error
      ;(parentPort as MessagePort).postMessage({
        type: 'result',
        id,
        socketPath,
        error: err.message
      })
    }
  })
}
