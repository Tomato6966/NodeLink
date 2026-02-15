import { validator } from '../validators.ts'
import { decodeTrack, logger, sendErrorResponse } from '../utils.ts'

const meaningSchema = validator.compile({
  encodedTrack: {
    type: 'string',
    empty: false,
    messages: {
      required: 'encodedTrack parameter is required.',
      string: 'encodedTrack parameter is required.',
      stringEmpty: 'encodedTrack parameter is required.'
    }
  },
  lang: { type: 'string', optional: true, default: 'en' }
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const data = {
    encodedTrack: parsedUrl.searchParams.get('encodedTrack') ?? undefined,
    lang: parsedUrl.searchParams.get('lang') || undefined
  }

  const validation = meaningSchema(data)

  if (validation !== true) {
    const errorMessage = validation?.[0]?.message || 'encodedTrack parameter is required.'
    logger('warn', 'Meaning', errorMessage)
    return sendErrorResponse(
      req,
      res,
      400,
      'missing encodedTrack parameter',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }

  let decodedTrack
  const targetLang = data.lang
  try {
    decodedTrack = decodeTrack(result.encodedTrack.replace(/ /g, '+'))
  } catch (err) {
    logger('warn', 'Meaning', `Invalid encoded track: ${err.message}`)
    return sendErrorResponse(
      req,
      res,
      400,
      'invalid encodedTrack',
      err.message,
      parsedUrl.pathname,
      true
    )
  }

  try {
    let delegated = false
    if (nodelink.sourceWorkerManager) {
      delegated = nodelink.sourceWorkerManager.delegate(
        req,
        res,
        'loadMeaning',
        {
          decodedTrackInfo: decodedTrack.info,
          language: targetLang
        }
      )
    }

    if (delegated) return

    let meaning
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      meaning = await nodelink.workerManager.execute(worker, 'loadMeaning', {
        decodedTrackInfo: decodedTrack.info,
        language: targetLang
      })
    } else if (nodelink.meanings?.loadMeaning) {
      meaning = await nodelink.meanings.loadMeaning(decodedTrack, targetLang)
    } else {
      logger('error', 'Meaning', 'Meaning sources are not available.')
      return sendErrorResponse(
        req,
        res,
        503,
        'meaning sources unavailable',
        'Meaning sources are not available.',
        parsedUrl.pathname,
        true
      )
    }

    if (meaning?.loadType === 'error') {
      return sendErrorResponse(
        req,
        res,
        500,
        'failed to load meaning',
        meaning.data?.message || 'Failed to load meaning',
        parsedUrl.pathname,
        true
      )
    }

    return sendResponse(req, res, meaning, 200)
  } catch (err) {
    logger('error', 'Meaning', `Failed to load meaning: ${err.message}`)
    return sendErrorResponse(
      req,
      res,
      500,
      'failed to load meaning',
      err.message || 'Failed to load meaning',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
