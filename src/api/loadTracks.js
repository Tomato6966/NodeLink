import Joi from 'joi'
import { logger, sendResponse, sendErrorResponse } from '../utils.js'

const loadTracksSchema = Joi.object({
  identifier: Joi.string().required().messages({
    'string.empty': 'identifier parameter cannot be empty.',
    'any.required': 'identifier parameter is required.'
  })
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const { error, value } = loadTracksSchema.validate({
    identifier: parsedUrl.searchParams.get('identifier')
  })

  if (error) {
    logger('warn', 'Tracks', error.details[0].message)
    return sendErrorResponse(
      req,
      res,
      400,
      'missing identifier parameter',
      error.details[0].message,
      parsedUrl.pathname,
      true
    )
  }

  const identifier = value.identifier
  logger('debug', 'Tracks', `Loading tracks with identifier: "${identifier}"`)

  try {
    let result
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      result = await nodelink.workerManager.execute(worker, 'loadTracks', {
        identifier
      })
    } else {
      const re =
        /^(?:(?<url>(?:https?|ftts):\/\/\S+)|(?<source>[A-Za-z0-9]+):(?<query>[^/\s].*))$/i
      const match = re.exec(identifier)
      if (!match) {
        logger('warn', 'Tracks', `Invalid identifier: "${identifier}"`)
        return sendErrorResponse(
          req,
          res,
          400,
          'invalid identifier parameter',
          'identifier parameter is invalid',
          parsedUrl.pathname,
          true
        )
      }

      const { url, source, query } = match.groups

      if (url) {
        result = await nodelink.sources.resolve(url)
      } else if (source === 'search') {
        result = await nodelink.sources.unifiedSearch(query)
      } else {
        result = await nodelink.sources.search(source, query)
      }
    }
    return sendResponse(req, res, result, 200)
  } catch (err) {
    logger(
      'error',
      'Tracks',
      `Failed to load track with identifier "${identifier}":`,
      err
    )
    return sendErrorResponse(
      req,
      res,
      500,
      'failed to load track',
      err.message || 'Failed to load track',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
