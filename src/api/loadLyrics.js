import { decodeTrack, logger, sendResponse } from '../utils.js'

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const encodedTrack = parsedUrl.searchParams.get('encodedTrack')
  if (!encodedTrack) {
    logger('warn', 'Lyrics', 'Missing encodedTrack parameter')
    return sendResponse(
      req,
      res,
      {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        message: 'Missing encodedTrack parameter.',
        path: parsedUrl.pathname
      },
      400
    )
  }

  try {
    const decodedTrack = decodeTrack(encodedTrack)
    if (!decodedTrack) {
      logger(
        'warn',
        'Lyrics',
        `Invalid encoded track received: ${encodedTrack}`
      )
      return sendResponse(
        req,
        res,
        {
          timestamp: Date.now(),
          status: 400,
          error: 'Bad Request',
          message: 'The provided track is invalid.',
          path: parsedUrl.pathname
        },
        400
      )
    }

    logger(
      'debug',
      'Lyrics',
      `Request to load lyrics for: ${decodedTrack.info.title}`
    )
    const lyricsData = await nodelink.lyrics.loadLyrics(decodedTrack)

    sendResponse(req, res, lyricsData, 200)
  } catch (error) {
    logger('error', 'Lyrics', 'Failed to load lyrics:', error)
    sendResponse(
      req,
      res,
      {
        timestamp: Date.now(),
        status: 500,
        error: 'Internal Server Error',
        message: error.message || 'Failed to load lyrics.',
        trace: new Error().stack,
        path: parsedUrl.pathname
      },
      500
    )
  }
}

export default {
  handler
}
