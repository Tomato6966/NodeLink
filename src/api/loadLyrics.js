import Validator from 'fastest-validator'
import { decodeTrack, logger, sendErrorResponse } from '../utils.js'

const v = new Validator({ haltOnFirstError: true })

const loadLyricsSchema = v.compile({
  encodedTrack: { type: 'string', empty: false, messages: { required: 'Missing encodedTrack parameter.', stringEmpty: 'Missing encodedTrack parameter.' } },
  lang: { type: 'string', optional: true }
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const data = {
    encodedTrack: parsedUrl.searchParams.get('encodedTrack') ?? undefined,
    lang: parsedUrl.searchParams.get('lang') || undefined
  }

  const validation = loadLyricsSchema(data)

  if (validation !== true) {
    const errorMessage = validation?.[0]?.message || 'Missing encodedTrack parameter.'
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

  const encodedTrack = data.encodedTrack.replace(/ /g, '+')
  const language = data.lang

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
      `Request to load lyrics for: ${decodedTrack.info.title}${language ? ` (Lang: ${language})` : ''}`
    )

    let delegated = false
    if (nodelink.sourceWorkerManager) {
      delegated = nodelink.sourceWorkerManager.delegate(
        req,
        res,
        'loadLyrics',
        {
          decodedTrackInfo: decodedTrack.info,
          language
        }
      )
    }

    if (delegated) return

    let lyricsData
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      lyricsData = await nodelink.workerManager.execute(worker, 'loadLyrics', {
        decodedTrackInfo: decodedTrack.info,
        language
      })
    } else {
      lyricsData = await nodelink.lyrics.loadLyrics(decodedTrack, language)
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
