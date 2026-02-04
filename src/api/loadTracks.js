import Validator from 'fastest-validator'
import { logger, sendErrorResponse } from '../utils.js'

const v = new Validator({ haltOnFirstError: true })

const loadTracksSchema = v.compile({
  identifier: {
    type: 'string',
    empty: false,
    messages: {
      required: 'identifier parameter is required.',
      string: 'identifier parameter is required.',
      stringEmpty: 'identifier parameter is required.'
    }
  }
})

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const data = {
    identifier: parsedUrl.searchParams.get('identifier') ?? undefined
  }

  const validation = loadTracksSchema(data)

  if (validation !== true) {
    const errorMessage = validation?.[0]?.message || 'identifier parameter is required.'
    logger('warn', 'Tracks', errorMessage)
    return sendErrorResponse(
      req,
      res,
      400,
      'missing identifier parameter',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }

  const identifier = data.identifier.trim()
  logger('debug', 'Tracks', `Loading tracks with identifier: "${identifier}"`)

  let url, source, query

  if (/^(?:https?|ftts):\/\//i.test(identifier)) {
    url = identifier
  } else {
    const re =
      /^(?:(?<source>(?![A-Z]:\\)[A-Za-z0-9]+):(?<query>(?!\/\/).+)|(?<local>(?:\/|[A-Z]:\\|\\).+))$/i
    const match = re.exec(identifier)

    if (match) {
      source = match.groups.source
      query = match.groups.query

      if (match.groups.local) {
        source = 'local'
        query = match.groups.local
      }
    } else {
      source = Array.isArray(nodelink.options.defaultSearchSource)
        ? nodelink.options.defaultSearchSource[0]
        : nodelink.options.defaultSearchSource
      query = identifier
    }
  }

  try {
    if (nodelink.sourceWorkerManager) {
      let task = ''
      let payload = {}

      if (url) {
        task = 'resolve'
        payload = { url }
      } else if (source === 'search') {
        task = 'unifiedSearch'
        payload = { query }
      } else {
        task = 'search'
        payload = { source, query }
      }

      const delegated = nodelink.sourceWorkerManager.delegate(
        req,
        res,
        task,
        payload
      )
      if (delegated) return
    }

    let result
    if (nodelink.workerManager && !nodelink.sourceWorkerManager) {
      const worker = nodelink.workerManager.getBestWorker()
      result = await nodelink.workerManager.execute(worker, 'loadTracks', {
        identifier
      })
    } else {
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
