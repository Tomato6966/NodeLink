import type { MeaningLoadResult } from './meaning.types.ts'

/**
 * Wikipedia page payload returned by the MediaWiki API.
 * @public
 */
export interface WikipediaPage {
  title?: string
  description?: string
  extract?: string
}

/**
 * Shape of the MediaWiki query response.
 * @public
 */
export interface WikipediaApiResponse {
  query?: {
    pages?: Record<string, WikipediaPage | undefined>
  }
}

/**
 * Successful meaning result produced by Wikipedia provider.
 * @public
 */
export type WikipediaMeaningResult = Extract<
  MeaningLoadResult,
  { loadType: 'meaning' }
>

/**
 * Empty meaning result produced by Wikipedia provider.
 * @public
 */
export type WikipediaEmptyResult = Extract<
  MeaningLoadResult,
  { loadType: 'empty' }
>
