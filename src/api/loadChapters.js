import myzod from 'myzod'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const loadChaptersSchema = myzod.object({
  encodedTrack: myzod.string()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = loadChaptersSchema.try({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack')
  })

  if (result instanceof myzod.ValidationError) {
    const errorMessage = result.message || 'Missing encodedTrack parameter.'
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      errorMessage,
      parsedUrl.pathname
    )
  }

  const encodedTrack = result.encodedTrack.replace(/ /g, '+')

  try {
    const decodedTrack = decodeTrack(encodedTrack)

    if (!decodedTrack || !decodedTrack.info) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'The provided track is invalid.',
        parsedUrl.pathname
      )
    }

    if (decodedTrack.info.sourceName !== 'youtube' && decodedTrack.info.sourceName !== 'ytmusic') {
      return sendResponse(req, res, [], 200)
    }

    logger(
      'debug',
      'Chapters',
      `Request to load chapters for: ${decodedTrack.info.title}`
    )

    let chaptersData
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      chaptersData = await nodelink.workerManager.execute(worker, 'loadChapters', {
        decodedTrack
      })
    } else {
      chaptersData = await nodelink.sources.getChapters(decodedTrack)
    }

    sendResponse(req, res, chaptersData, 200)
  } catch (err) {
    logger('error', 'Chapters', 'Failed to load chapters:', err)
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      err.message || 'Failed to load chapters.',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
