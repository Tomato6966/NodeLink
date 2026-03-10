import type { ApiRequest, ApiResponse } from './api.types.ts'

/**
 * Named capture groups returned by the load-tracks identifier parser.
 *
 * @remarks
 * - `source` and `query` are populated for `source:query` identifiers.
 * - `local` is populated for local file paths.
 */
export interface LoadTracksIdentifierGroups {
  /** Source name extracted from `source:query` inputs. */
  source?: string
  /** Search query extracted from `source:query` inputs. */
  query?: string
  /** Local file path when a local identifier is detected. */
  local?: string
}

/**
 * Normalized identifier target resolved by the load-tracks route.
 *
 * @example
 * ```ts
 * const target: LoadTracksTarget = {
 *   kind: 'search',
 *   source: 'youtube',
 *   query: 'lofi hip hop'
 * }
 * ```
 */
export type LoadTracksTarget =
  | { kind: 'url'; url: string }
  | { kind: 'unifiedSearch'; query: string }
  | { kind: 'search'; source?: string; query: string }

/**
 * Worker task names accepted by the source worker manager.
 */
export type LoadTracksWorkerTask = 'resolve' | 'search' | 'unifiedSearch'

/**
 * Payloads passed to worker tasks for track loading.
 */
export type LoadTracksWorkerPayload =
  | { url: string }
  | { query: string }
  | { source?: string; query: string }

/**
 * Combined task and payload used when delegating to a source worker.
 */
export interface LoadTracksWorkerRequest {
  /** Worker task identifier. */
  task: LoadTracksWorkerTask
  /** Payload expected by the task. */
  payload: LoadTracksWorkerPayload
}

/**
 * API wrapper for the specialized source worker manager.
 */
export interface ApiSourceWorkerManager {
  /**
   * Delegates the request to a specialized worker.
   *
   * @param req - Incoming API request.
   * @param res - Response object to write to.
   * @param task - Worker task name.
   * @param payload - Worker task payload.
   * @returns True when the worker handled the response.
   */
  delegate: (
    req: ApiRequest,
    res: ApiResponse,
    task: LoadTracksWorkerTask,
    payload: LoadTracksWorkerPayload
  ) => boolean
}

/**
 * API wrapper for the general worker manager used by loadTracks.
 */
export interface ApiTrackWorkerManager {
  /**
   * Returns the most suitable worker for the task.
   */
  getBestWorker: () => { id: number }

  /**
   * Executes a worker job and resolves its result.
   *
   * @param worker - Worker metadata returned by {@link getBestWorker}.
   * @param type - Task name (always "loadTracks").
   * @param payload - Job payload.
   */
  execute: (
    worker: { id: number },
    type: 'loadTracks',
    payload: { identifier: string }
  ) => Promise<unknown>
}

/**
 * Minimal source provider surface used by the loadTracks route.
 */
export interface ApiTrackSources {
  /**
   * Resolves a track from a URL.
   */
  resolve: (url: string) => Promise<unknown>

  /**
   * Performs a unified search across all sources.
   */
  unifiedSearch: (query: string) => Promise<unknown>

  /**
   * Performs a search against a specific source.
   */
  search: (source: string | undefined, query: string) => Promise<unknown>
}

/**
 * Runtime extensions required by the loadTracks handler.
 */
export interface ApiTrackLoaderContext {
  /**
   * General worker manager for track loading.
   */
  workerManager?: ApiTrackWorkerManager

  /**
   * Specialized source worker manager (optional).
   */
  sourceWorkerManager?: ApiSourceWorkerManager

  /**
   * Source registry used when no worker manager is available.
   */
  sources?: ApiTrackSources
}
