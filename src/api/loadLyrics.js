import myzod from 'myzod'
import {
  decodeTrack,
  logger,
  sendResponse,
  sendErrorResponse
} from '../utils.js'

const loadLyricsSchema = myzod.object({
  encodedTrack: myzod.string()
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = loadLyricsSchema.try({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack')
  })

  if (result instanceof myzod.ValidationError) {
    const errorMessage = result.message || 'Missing encodedTrack parameter.'
    logger('warn', 'Lyrics', errorMessage)
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      errorMessage,
      parsedUrl.pathname
    )
  }

  const encodedTrack = result.encodedTrack

  try {
    const decodedTrack = decodeTrack(encodedTrack)
    if (!decodedTrack) {
      logger(
        'warn',
        'Lyrics',
        `Invalid encoded track received: ${encodedTrack}`
      )
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'The provided track is invalid.',
        parsedUrl.pathname
      )
    }

    logger(
      'debug',
      'Lyrics',
      `Request to load lyrics for: ${decodedTrack.info.title}`
    )

    let lyricsData
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      lyricsData = await nodelink.workerManager.execute(worker, 'loadLyrics', {
        decodedTrack
      })
    } else {
      lyricsData = await nodelink.lyrics.loadLyrics(decodedTrack)
    }

    sendResponse(req, res, lyricsData, 200)
  } catch (err) {
    logger('error', 'Lyrics', 'Failed to load lyrics:', err)
    sendErrorResponse(
      req,
      res,
      500,
      'Internal Server Error',
      err.message || 'Failed to load lyrics.',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}