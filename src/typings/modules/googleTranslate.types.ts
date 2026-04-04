/**
 * Raw payload returned by Google Translate endpoint.
 * @public
 */
export interface GoogleTranslateResponseBody {
  /**
   * Translated text returned by the API.
   */
  translation?: string

  /**
   * Detected source language from the API.
   */
  sourceLanguage?: string
}

/**
 * Normalized translation result returned by module helpers.
 * @public
 */
export interface GoogleTranslationResult {
  /**
   * Translated output text.
   */
  translation: string

  /**
   * Source language used/detected for translation.
   */
  sourceLanguage: string
}
