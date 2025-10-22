import { logger } from '../utils.js'

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const sendError = (status, error, message) => {
    // biome-ignore format: off
    sendResponse(req, res, {
      timestamp: Date.now(),
      status,
      error,
      trace: new Error().stack,
      message,
      path: parsedUrl.pathname,
    }, status);
  }

  const identifier = parsedUrl.searchParams.get('identifier')
  logger('debug', 'Tracks', `Loading tracks with identifier: "${identifier}"`)

  if (!identifier) {
    logger('warn', 'Tracks', 'Missing identifier parameter')
    return sendError(
      400,
      'missing identifier parameter',
      'identifier parameter is required'
    )
  }

  try {
    let result;
    if (nodelink.workerManager) {
      const worker = nodelink.workerManager.getBestWorker();
      result = await nodelink.workerManager.execute(worker, 'loadTracks', { identifier });
    } else {
      const re =
        /^(?:(?<url>(?:https?|ftts):\/\/\S+)|(?<source>[A-Za-z0-9]+):(?<query>[^/\s].*))$/i
      const match = re.exec(identifier)
      if (!match) {
        logger('warn', 'Tracks', `Invalid identifier: "${identifier}"`)
        return sendError(
          400,
          'invalid identifier parameter',
          'identifier parameter is invalid'
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
    return sendError(
      500,
      'failed to load track',
      err.message || 'Failed to load track'
    )
  }
}

export default {
  handler
}
