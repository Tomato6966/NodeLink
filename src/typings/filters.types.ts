import type { FiltersState } from './player.types.ts'

/**
 * Shape of filter settings accepted by filter instances.
 * @public
 */
export type FilterSettings =
  | NonNullable<FiltersState['filters']>
  | Record<string, unknown>

/**
 * Runtime audio filter instance used by the filter pipeline.
 * @remarks Filters can optionally expose update/flush hooks for stateful logic.
 * @example
 * ```ts
 * const filter: FilterInstance = {
 *   priority: 5,
 *   process: (chunk) => chunk,
 *   update: (settings) => console.log(settings)
 * }
 * ```
 * @public
 */
export interface FilterInstance {
  /**
   * Optional sort priority (lower runs first).
   */
  priority?: number

  /**
   * Processes PCM audio buffers.
   */
  process: (chunk: Buffer) => Buffer

  /**
   * Updates filter settings from the full filter payload.
   */
  update?: (settings: FilterSettings) => void

  /**
   * Flushes any pending buffered data.
   */
  flush?: () => Buffer
}

/**
 * Constructor signature for built-in filter classes.
 * @public
 */
export type FilterClass = new () => FilterInstance

/**
 * NodeLink context required by the FiltersManager.
 * @public
 */
export interface FiltersManagerContext {
  /**
   * Optional extension map for custom filters.
   */
  extensions?: {
    filters?: Map<string, FilterInstance>
  } & Record<string, unknown>
}
