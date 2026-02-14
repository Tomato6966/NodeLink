import { pipeline } from 'node:stream'
import Validator from 'fastest-validator'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

const v = new Validator({ haltOnFirstError: true })

const loadStreamSchema = v.compile({
  encodedTrack: { type: 'string', empty: false },
  volume: { type: 'number', min: 0, max: 1000, optional: true },
  position: { type: 'number', min: 0, optional: true },
  filters: { type: 'any', optional: true }
})

let createPCMStreamPromise = null

const getCreatePCMStream = async () => {
  if (!createPCMStreamPromise) {
    createPCMStreamPromise = import(
      '../playback/processing/streamProcessor.ts'
    ).then((module) => module.createPCMStream)
  }
  return createPCMStreamPromise
}

async function handler(nodelink, req, res, _sendResponse, parsedUrl) {
  if (!nodelink.options.enableLoadStreamEndpoint) {
    return sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'The requested route was not found.',
      parsedUrl.pathname
    )
  }

  let data
  try {
    if (req.method === 'POST') {
      data = req.body
    } else {
      const filtersRaw = parsedUrl.searchParams.get('filters')
      let filters
      if (filtersRaw) {
        try {
          filters = JSON.parse(filtersRaw)
        } catch {
          filters = undefined
        }
      }

      data = {
        encodedTrack: parsedUrl.searchParams.get('encodedTrack') ?? undefined,
        volume: parsedUrl.searchParams.get('volume')
          ? Number(parsedUrl.searchParams.get('volume'))
          : undefined,
        position:
          parsedUrl.searchParams.get('position') ||
          parsedUrl.searchParams.get('t')
            ? Number(
                parsedUrl.searchParams.get('position') ||
                  parsedUrl.searchParams.get('t')
              )
            : undefined,
        filters
      }
    }

    const validation = loadStreamSchema(data)

    if (validation !== true) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        validation?.[0]?.message || 'Invalid parameters',
        parsedUrl.pathname
      )
    }

    const { encodedTrack, volume = 100, position = 0, filters = {} } = data
    const decodedTrack = decodeTrack(encodedTrack.replace(/ /g, '+'))

    if (!decodedTrack) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'Invalid encoded track',
        parsedUrl.pathname
      )
    }

    if (nodelink.sourceWorkerManager) {
      const delegated = nodelink.sourceWorkerManager.delegate(
        req,
        res,
        'loadStream',
        {
          decodedTrackInfo: decodedTrack.info,
          volume,
          position,
          filters
        },
        {
          headers: {
            'Content-Type': 'audio/l16;rate=48000;channels=2',
            'Transfer-Encoding': 'chunked',
            Connection: 'keep-alive'
          }
        }
      )
      if (delegated) return
    }

    if (!nodelink.sources && nodelink.workerManager) {
      const delegated = nodelink.workerManager.delegateStream(
        req,
        res,
        {
          decodedTrackInfo: decodedTrack.info,
          volume,
          position,
          filters
        },
        {
          headers: {
            'Content-Type': 'audio/l16;rate=48000;channels=2',
            'Transfer-Encoding': 'chunked',
            Connection: 'keep-alive'
          }
        }
      )
      if (delegated) return
      return sendErrorResponse(
        req,
        res,
        503,
        'Service Unavailable',
        'No available workers to stream audio.',
        parsedUrl.pathname
      )
    }

    if (!nodelink.sources && !nodelink.workerManager) {
      return sendErrorResponse(
        req,
        res,
        503,
        'Service Unavailable',
        'Sources manager is not available for loadStream.',
        parsedUrl.pathname
      )
    }

    let urlResult
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      urlResult = await nodelink.workerManager.execute(worker, 'getTrackUrl', {
        decodedTrackInfo: decodedTrack.info
      })
    } else {
      urlResult = await nodelink.sources.getTrackUrl(decodedTrack.info)
    }

    if (urlResult.exception) {
      return sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        urlResult.exception.message,
        parsedUrl.pathname
      )
    }

    const additionalData = { ...urlResult.additionalData, startTime: position }

    const fetched = await nodelink.sources.getTrackStream(
      urlResult.newTrack?.info || decodedTrack.info,
      urlResult.url,
      urlResult.protocol,
      additionalData
    )

    if (fetched.exception) {
      return sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        fetched.exception.message,
        parsedUrl.pathname
      )
    }

    const createPCMStream = await getCreatePCMStream()
    const pcmStream = createPCMStream(
      fetched.stream,
      fetched.type || urlResult.format,
      nodelink,
      volume / 100,
      filters
    )

    pcmStream.on('error', (err) => {
      logger(
        'error',
        'LoadStream',
        `Pipeline component error: ${err.message} (${err.code})`
      )
    })

    res.writeHead(200, {
      'Content-Type': 'audio/l16;rate=48000;channels=2',
      'Transfer-Encoding': 'chunked',
      Connection: 'keep-alive'
    })

    pipeline(pcmStream, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger(
          'error',
          'LoadStream',
          `Pipeline output failed for ${decodedTrack.info.title}: ${err.message}`
        )
      }

      if (!pcmStream.destroyed) pcmStream.destroy()
      if (fetched.stream && !fetched.stream.destroyed) fetched.stream.destroy()
    })

    res.on('close', () => {
      if (!pcmStream.destroyed) pcmStream.destroy()
      if (fetched.stream && !fetched.stream.destroyed) fetched.stream.destroy()
    })
  } catch (err) {
    logger('error', 'LoadStream', `Fatal handler error:`, err)
    if (!res.writableEnded) {
      sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        err.message,
        parsedUrl.pathname
      )
    }
  }
}

export default {
  handler,
  methods: ['GET', 'POST']
}
