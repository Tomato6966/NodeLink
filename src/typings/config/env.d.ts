/**
 * Global type declarations and environment extensions
 * @module env
 */

declare namespace NodeJS {
  /**
   * Extended Process interface with custom properties
   * @public
   */
  interface Process {
    /**
     * Embedder identifier for Bun runtime
     * @remarks
     * This property is set by Bun to identify the runtime environment
     */
    embedder?: string
  }

  /**
   * Process environment variables
   * @public
   * @remarks
   * Accepts any string key with string or undefined values
   */
  interface ProcessEnv {
    [key: string]: string | undefined
  }
}

/**
 * Global NodeLink server instance
 * @public
 * @remarks
 * Available globally when server is running
 */
declare const nodelink: import('../index.types.ts').NodelinkServer | undefined
