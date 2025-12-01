import myzod from 'myzod'
import {
  decodeTrack,
  logger,
  sendErrorResponse,
  sendResponse
} from '../utils.js'

const trackStreamSchema = myzod.object({
  encodedTrack: myzod.string()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  if (!nodelink.options.enableTrackStreamEndpoint) {
    return sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'The requested route was not found.',
      parsedUrl.pathname
    )
  }

  const result = trackStreamSchema.try({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack')
  })

  const itag = parsedUrl.searchParams.get('itag')
    ? Number(parsedUrl.searchParams.get('itag'))
    : null

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

    if (!decodedTrack) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'The provided track is invalid.',
        parsedUrl.pathname
      )
    }

    let urlResult
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      urlResult = await nodelink.workerManager.execute(worker, 'getTrackUrl', {
        decodedTrackInfo: decodedTrack.info,
        itag
      })
    } else {
      urlResult = await nodelink.sources.getTrackUrl(decodedTrack.info, itag)
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

    sendResponse(req, res, urlResult, 200)
  } catch (err) {
    logger(
      'error',
      'TrackStream',
      `Failed to get track stream for ${encodedTrack}:`,
      err
    )
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      err.message || 'Failed to get track stream',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
