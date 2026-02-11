import Validator from 'fastest-validator'
import type {
  ApiNodelinkServer,
  ApiRequest,
  ApiResponse,
  ApiSendResponse
} from '../typings/api/api.types.ts'
import { logger, sendErrorResponse } from '../utils.ts'

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

async function handler(
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
): Promise<void> {
  const data = {
    identifier: parsedUrl.searchParams.get('identifier') ?? undefined
  }

  const validation = loadTracksSchema(data)

  if (validation !== true) {
    const errorMessage =
      (validation as Array<{ message: string }>)?.[0]?.message ||
      'identifier parameter is required.'
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

  const identifier = (data.identifier as string).trim()
  logger('debug', 'Tracks', `Loading tracks with identifier: "${identifier}"`)

  let url: string | undefined,
    source: string | undefined,
    query: string | undefined

  if (/^(?:https?|ftts):\/\//i.test(identifier)) {
    url = identifier
  } else {
    const re =
      /^(?:(?<source>(?![A-Z]:\\)[A-Za-z0-9]+):(?<query>(?!\/\/).+)|(?<local>(?:\/|[A-Z]:\\|\\).+))$/i
    const match = re.exec(identifier)

    if (match?.groups) {
      // biome-ignore lint: TypeScript requires bracket notation for index signature properties
      source = match.groups['source']
      // biome-ignore lint: TypeScript requires bracket notation for index signature properties
      query = match.groups['query']

      // biome-ignore lint: TypeScript requires bracket notation for index signature properties
      if (match.groups['local']) {
        source = 'local'
        // biome-ignore lint: TypeScript requires bracket notation for index signature properties
        query = match.groups['local']
      }
    } else {
      const defaultSearchSource = (
        nodelink.options as { defaultSearchSource?: string | string[] }
      ).defaultSearchSource
      source = Array.isArray(defaultSearchSource)
        ? defaultSearchSource[0]
        : defaultSearchSource
      query = identifier
    }
  }

  try {
    if (
      (
        nodelink as unknown as {
          sourceWorkerManager?: { delegate: (...args: unknown[]) => boolean }
        }
      ).sourceWorkerManager
    ) {
      let task = ''
      let payload: Record<string, any> = {}

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

      const delegated = (
        nodelink as unknown as {
          sourceWorkerManager: { delegate: (...args: unknown[]) => boolean }
        }
      ).sourceWorkerManager.delegate(req, res, task, payload)
      if (delegated) return
    }

    let result: any
    const nodelinkWithWorkers = nodelink as unknown as {
      workerManager?: {
        getBestWorker: () => { id: number }
        execute: (
          worker: { id: number },
          type: string,
          payload: { identifier: string }
        ) => Promise<unknown>
      }
      sources?: {
        resolve: (url: string) => Promise<unknown>
        unifiedSearch: (query: string | undefined) => Promise<unknown>
        search: (
          source: string | undefined,
          query: string | undefined
        ) => Promise<unknown>
      }
    }

    if (
      nodelinkWithWorkers.workerManager &&
      !(nodelink as unknown as { sourceWorkerManager?: unknown })
        .sourceWorkerManager
    ) {
      const worker = nodelinkWithWorkers.workerManager.getBestWorker()
      result = await nodelinkWithWorkers.workerManager.execute(
        worker,
        'loadTracks',
        {
          identifier
        }
      )
    } else {
      if (url && nodelinkWithWorkers.sources) {
        result = await nodelinkWithWorkers.sources.resolve(url)
      } else if (source === 'search' && nodelinkWithWorkers.sources) {
        result = await nodelinkWithWorkers.sources.unifiedSearch(query)
      } else if (nodelinkWithWorkers.sources) {
        result = await nodelinkWithWorkers.sources.search(source, query)
      }
    }

    return sendResponse(req, res, result, 200)
  } catch (err: unknown) {
    const error = err as Error
    logger(
      'error',
      'Tracks',
      `Failed to load track with identifier "${identifier}":`,
      error
    )
    return sendErrorResponse(
      req,
      res,
      500,
      'failed to load track',
      error.message || 'Failed to load track',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
