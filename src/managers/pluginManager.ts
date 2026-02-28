import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '../utils.ts'

/**
 * CommonJS resolver used to resolve npm package entry points.
 * @internal
 */
const require = createRequire(import.meta.url)

/**
 * Execution context kind used by plugin bootstrap hooks.
 * @public
 */
type PluginContextType = 'master' | 'worker' | string

/**
 * Plugin definition as declared in NodeLink configuration.
 * @public
 */
interface PluginDefinition {
  name: string
  source?: 'local' | 'npm' | string
  path?: string
  package?: string
}

/**
 * Arbitrary plugin configuration object passed to plugin executors.
 * @public
 */
type PluginSpecificConfig = Record<string, unknown>

/**
 * Per-plugin configuration map keyed by plugin name.
 * @public
 */
type PluginConfigMap = Record<string, PluginSpecificConfig | undefined>

/**
 * Metadata resolved for a loaded plugin.
 * @public
 */
interface PluginMeta {
  name: string
  version: string
  author: string
  topic: string | null
}

/**
 * Runtime context object passed to plugin entrypoints.
 * @public
 */
interface PluginExecutionContext {
  type: PluginContextType
  workerId: number
  pluginName: string
  meta: PluginMeta
}

/**
 * Function signature expected from plugin default exports.
 * @public
 */
type PluginExecutor = (
  nodelink: PluginManagerContext,
  config: PluginSpecificConfig,
  context: PluginExecutionContext
) => Promise<void> | void

/**
 * Dynamically imported plugin module contract.
 * @public
 */
interface PluginModule {
  default: PluginExecutor
}

/**
 * In-memory cache entry for loaded plugins.
 * @internal
 */
interface LoadedPluginEntry {
  name: string
  path: string
  module: PluginModule
  meta: PluginMeta
}

/**
 * Minimal package.json metadata read by the plugin manager.
 * @internal
 */
interface PluginPackageJson {
  version?: string
  author?: string | { name?: string }
  homepage?: string
  repository?: string | { url?: string }
  main?: string
}

/**
 * Minimal NodeLink context required by the plugin manager.
 * @public
 */
type PluginManagerContext = {
  options: {
    plugins?: PluginDefinition[]
    pluginConfig?: PluginConfigMap
  }
} & Record<string, unknown>

/**
 * Loads and executes configured plugins from local paths and npm packages.
 * @example
 * ```ts
 * const plugins = new PluginManager(nodelink)
 * await plugins.load('master')
 * ```
 * @public
 */
export default class PluginManager {
  public readonly nodelink: PluginManagerContext
  private readonly config: PluginDefinition[]
  private readonly pluginConfigs: PluginConfigMap
  private readonly pluginsDir: string
  private readonly loadedPlugins: Map<string, LoadedPluginEntry>

  /**
   * Creates a new plugin manager instance.
   * @param nodelink - NodeLink runtime context.
   */
  constructor(nodelink: PluginManagerContext) {
    this.nodelink = nodelink
    this.config = Array.isArray(nodelink.options.plugins)
      ? nodelink.options.plugins
      : []
    this.pluginConfigs = nodelink.options.pluginConfig ?? {}
    this.pluginsDir = path.join(process.cwd(), 'plugins')
    this.loadedPlugins = new Map()
  }

  /**
   * Loads and executes all configured plugins for the current process context.
   * @param contextType - Runtime context identifier (e.g. master/worker).
   */
  public async load(contextType: PluginContextType): Promise<void> {
    logger(
      'info',
      'PluginManager',
      `Initializing plugins in ${contextType} context...`
    )

    try {
      await fs.access(this.pluginsDir)
    } catch {
      await fs.mkdir(this.pluginsDir, { recursive: true })
    }

    for (const pluginDef of this.config) {
      await this._loadPlugin(pluginDef, contextType)
    }

    logger('info', 'PluginManager', `Plugins processed for ${contextType}.`)
  }

  /**
   * Locates the nearest package.json for a resolved module path.
   * @param startPath - Resolved file path inside a package.
   * @internal
   */
  private async _findPackageJson(
    startPath: string
  ): Promise<PluginPackageJson | null> {
    let currentDir = path.dirname(startPath)

    while (currentDir !== path.parse(currentDir).root) {
      const pkgPath = path.join(currentDir, 'package.json')
      try {
        await fs.access(pkgPath)
        const data = await fs.readFile(pkgPath, 'utf-8')
        return this._parsePackageJson(data)
      } catch {
        if (path.basename(currentDir) === 'node_modules') break
        currentDir = path.dirname(currentDir)
      }
    }

    return null
  }

  /**
   * Safely parses package.json raw content.
   * @param raw - Raw JSON string.
   * @internal
   */
  private _parsePackageJson(raw: string): PluginPackageJson | null {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null

      const pkg = parsed as Record<string, unknown>
      const repository = pkg['repository']
      const author = pkg['author']

      return {
        version:
          typeof pkg['version'] === 'string' ? pkg['version'] : undefined,
        author:
          typeof author === 'string'
            ? author
            : author && typeof author === 'object'
              ? {
                  name:
                    typeof (author as Record<string, unknown>)['name'] ===
                    'string'
                      ? ((author as Record<string, unknown>)['name'] as string)
                      : undefined
                }
              : undefined,
        homepage:
          typeof pkg['homepage'] === 'string' ? pkg['homepage'] : undefined,
        repository:
          typeof repository === 'string'
            ? repository
            : repository && typeof repository === 'object'
              ? {
                  url:
                    typeof (repository as Record<string, unknown>)['url'] ===
                    'string'
                      ? ((repository as Record<string, unknown>)['url'] as string)
                      : undefined
                }
              : undefined,
        main: typeof pkg['main'] === 'string' ? pkg['main'] : undefined
      }
    } catch {
      return null
    }
  }

  /**
   * Extracts an author string from parsed package metadata.
   * @param pkg - Parsed package metadata.
   * @internal
   */
  private _extractAuthor(pkg: PluginPackageJson): string | null {
    if (typeof pkg.author === 'string' && pkg.author.length > 0) {
      return pkg.author
    }

    if (
      pkg.author &&
      typeof pkg.author === 'object' &&
      typeof pkg.author.name === 'string' &&
      pkg.author.name.length > 0
    ) {
      return pkg.author.name
    }

    return null
  }

  /**
   * Extracts a topic/homepage/repository URL from package metadata.
   * @param pkg - Parsed package metadata.
   * @internal
   */
  private _extractTopic(pkg: PluginPackageJson): string | null {
    if (typeof pkg.homepage === 'string' && pkg.homepage.length > 0) {
      return pkg.homepage
    }

    if (
      pkg.repository &&
      typeof pkg.repository === 'object' &&
      typeof pkg.repository.url === 'string' &&
      pkg.repository.url.length > 0
    ) {
      return pkg.repository.url
    }

    if (typeof pkg.repository === 'string' && pkg.repository.length > 0) {
      return pkg.repository
    }

    return null
  }

  /**
   * Validates and narrows a dynamic module into a plugin module contract.
   * @param moduleValue - Dynamically imported module value.
   * @internal
   */
  private _coercePluginModule(moduleValue: unknown): PluginModule | null {
    if (!moduleValue || typeof moduleValue !== 'object') return null

    const record = moduleValue as Record<string, unknown>
    if (typeof record['default'] !== 'function') return null

    return {
      default: record['default'] as PluginExecutor
    }
  }

  /**
   * Loads a single plugin definition and executes its entrypoint.
   * @param def - Plugin definition from config.
   * @param contextType - Current runtime context identifier.
   * @internal
   */
  private async _loadPlugin(
    def: PluginDefinition,
    contextType: PluginContextType
  ): Promise<void> {
    const { name, source, path: localPath, package: packageName } = def

    if (!name || name.trim().length === 0) return

    if (this.loadedPlugins.has(name)) {
      const cached = this.loadedPlugins.get(name)
      if (!cached) return

      await this._executePlugin(cached.module, name, contextType, cached.meta)
      return
    }

    try {
      let entryPoint: string | null = null
      const pluginMeta: PluginMeta = {
        name,
        version: '0.0.0',
        author: 'Unknown',
        topic: null
      }

      if (source === 'local') {
        const resolvedPath = path.resolve(this.pluginsDir, localPath || name)
        const stat = await fs.stat(resolvedPath)

        if (stat.isDirectory()) {
          const pkgPath = path.join(resolvedPath, 'package.json')
          try {
            const pkgData = await fs.readFile(pkgPath, 'utf-8')
            const pkg = this._parsePackageJson(pkgData)

            if (pkg?.version) pluginMeta.version = pkg.version

            const author = pkg ? this._extractAuthor(pkg) : null
            if (author) {
              pluginMeta.author = author
            }

            const topic = pkg ? this._extractTopic(pkg) : null
            if (topic) {
              pluginMeta.topic = topic
            }

            if (pkg?.main) {
              entryPoint = path.join(resolvedPath, pkg.main)
            } else {
              entryPoint = path.join(resolvedPath, 'index.js')
            }
          } catch {
            entryPoint = path.join(resolvedPath, 'index.js')
          }
        } else {
          entryPoint = resolvedPath
        }
      } else if (source === 'npm') {
        try {
          const pkgName = packageName || name
          entryPoint = require.resolve(pkgName)

          const pkg = await this._findPackageJson(entryPoint)
          if (pkg) {
            if (pkg.version) pluginMeta.version = pkg.version

            const author = this._extractAuthor(pkg)
            if (author) {
              pluginMeta.author = author
            }

            const topic = this._extractTopic(pkg)
            if (topic) {
              pluginMeta.topic = topic
            }
          }
        } catch (_e) {
          logger(
            'warn',
            'PluginManager',
            `NPM package '${packageName || name}' not found.`
          )
          return
        }
      }

      if (!entryPoint) return

      const fileUrl = pathToFileURL(entryPoint).href
      const importedModule: unknown = await import(fileUrl)
      const pluginModule = this._coercePluginModule(importedModule)

      if (!pluginModule) {
        throw new Error(
          `Plugin '${name}' entry point must export a default function.`
        )
      }

      this.loadedPlugins.set(name, {
        name,
        path: entryPoint,
        module: pluginModule,
        meta: pluginMeta
      })

      await this._executePlugin(pluginModule, name, contextType, pluginMeta)

      const author = `\x1b[36m${pluginMeta.author}\x1b[0m`
      const pluginName = `\x1b[1m\x1b[32m${name}\x1b[0m`
      const version = `\x1b[33mv${pluginMeta.version}\x1b[0m`
      const topic = pluginMeta.topic
        ? ` | \x1b[34mTopic:\x1b[0m ${pluginMeta.topic}`
        : ''

      const creditString = `[${author}] ${pluginName} ${version}${topic}`

      logger('info', 'PluginManager', `Loaded: ${creditString}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger(
        'error',
        'PluginManager',
        `Failed to load plugin '${name}': ${message}`
      )
    }
  }

  /**
   * Executes the plugin default export with resolved config and metadata.
   * @param pluginModule - Coerced plugin module.
   * @param name - Plugin display name.
   * @param contextType - Current runtime context identifier.
   * @param meta - Resolved plugin metadata.
   * @internal
   */
  private async _executePlugin(
    pluginModule: PluginModule,
    name: string,
    contextType: PluginContextType,
    meta: PluginMeta
  ): Promise<void> {
    const specificConfig = this.pluginConfigs[name] || {}
    const context: PluginExecutionContext = {
      type: contextType,
      workerId: process.pid,
      pluginName: name,
      meta
    }

    try {
      await pluginModule.default(this.nodelink, specificConfig, context)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger(
        'error',
        'PluginManager',
        `Error executing plugin '${name}' in '${contextType}' context: ${message}`
      )
    }
  }
}
