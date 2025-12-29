import { pipeline } from 'node:stream'
import myzod from 'myzod'
import {
  decodeTrack,
  logger,
  sendErrorResponse
} from '../utils.js'
import { createPCMStream } from '../playback/streamProcessor.js'

const loadStreamSchema = myzod.object({
  encodedTrack: myzod.string(),
  volume: myzod.number().min(0).max(1000).optional(),
  position: myzod.number().min(0).optional(),
  filters: myzod.unknown().optional()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
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

  let result
  try {
    if (req.method === 'POST') {
      result = loadStreamSchema.try(req.body)
    } else {
      const filtersRaw = parsedUrl.searchParams.get('filters')
      let filters = undefined
      if (filtersRaw) {
        try {
          filters = JSON.parse(filtersRaw)
        } catch {
          filters = undefined
        }
      }

      result = loadStreamSchema.try({
        encodedTrack: parsedUrl.searchParams.get('encodedTrack'),
        volume: parsedUrl.searchParams.get('volume') ? Number(parsedUrl.searchParams.get('volume')) : undefined,
        position: (parsedUrl.searchParams.get('position') || parsedUrl.searchParams.get('t')) ? Number(parsedUrl.searchParams.get('position') || parsedUrl.searchParams.get('t')) : undefined,
        filters
      })
    }

    if (result instanceof myzod.ValidationError) {
      return sendErrorResponse(req, res, 400, 'Bad Request', result.message, parsedUrl.pathname)
    }

    const { encodedTrack, volume = 100, position = 0, filters = {} } = result
    const decodedTrack = decodeTrack(encodedTrack.replace(/ /g, '+'))

    if (!decodedTrack) {
      return sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid encoded track', parsedUrl.pathname)
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
      return sendErrorResponse(req, res, 500, 'Internal Server Error', urlResult.exception.message, parsedUrl.pathname)
    }

    const additionalData = { ...urlResult.additionalData, startTime: position }

    const fetched = await nodelink.sources.getTrackStream(
      urlResult.newTrack?.info || decodedTrack.info,
      urlResult.url,
      urlResult.protocol,
      additionalData
    )

    if (fetched.exception) {
      return sendErrorResponse(req, res, 500, 'Internal Server Error', fetched.exception.message, parsedUrl.pathname)
    }

        const pcmStream = createPCMStream(
          fetched.stream,
          fetched.type || urlResult.format,
          nodelink,
          volume / 100,
          filters
        )
    
        pcmStream.on('error', (err) => {
          logger('error', 'LoadStream', `Pipeline component error: ${err.message} (${err.code})`)
        })
    
        res.writeHead(200, {
          'Content-Type': 'audio/l16;rate=48000;channels=2',
          'Transfer-Encoding': 'chunked',
          'Connection': 'keep-alive'
        })
    
        pipeline(pcmStream, res, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            logger('error', 'LoadStream', `Pipeline output failed for ${decodedTrack.info.title}: ${err.message}`)
          }
    
          if (!pcmStream.destroyed) pcmStream.destroy()
          if (fetched.stream && !fetched.stream.destroyed) fetched.stream.destroy()
        })
    
        res.on('close', () => {
          if (!pcmStream.destroyed) pcmStream.destroy()
          if (fetched.stream && !fetched.stream.destroyed) fetched.stream.destroy()
        })  } catch (err) {
    logger('error', 'LoadStream', `Fatal handler error:`, err)
    if (!res.writableEnded) {
      sendErrorResponse(req, res, 500, 'Internal Server Error', err.message, parsedUrl.pathname)
    }
  }
}

export default {
  handler,
  methods: ['GET', 'POST']
}
