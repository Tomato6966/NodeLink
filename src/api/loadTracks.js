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

  try {
    if (url) {
      const track = await nodelink.sources.resolve(url)
      return sendResponse(req, res, track, 200)
    }

    if (source === 'search') {
      const tracks = await nodelink.sources.unifiedSearch(query)
      return sendResponse(req, res, tracks, 200)
    }

    const tracks = await nodelink.sources.search(source, query)
    return sendResponse(req, res, tracks, 200)
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
