import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { logger } from '../utils.js'

export default class PluginManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.plugins = []
    this.routes = {
      static: new Map(),
      dynamic: []
    }
    this.streamInterceptors = []
    this.beforePlayHooks = []
  }

  /**
   * Register an HTTP route exposed by a plugin.
   * - Static routes use an exact string path (e.g., `/v4/my-plugin/health`).
   * - Dynamic routes can be registered with a RegExp to match multiple paths.
   * The handler receives `(nodelink, req, res, sendResponse, parsedUrl)`.
   * @param {string|RegExp} pathnameOrRegex
   * @param {Function} handler
   * @param {string[]} [methods=['GET']]
   */
  addRoute(pathnameOrRegex, handler, methods = ['GET']) {
    const routeData = { handler, methods }
    if (pathnameOrRegex instanceof RegExp) {
      this.routes.dynamic.push([pathnameOrRegex, routeData])
    } else if (typeof pathnameOrRegex === 'string') {
      this.routes.static.set(pathnameOrRegex, routeData)
    } else {
      throw new Error('addRoute requires a string path or RegExp')
    }
  }

  /**
   * Return the full route registry for plugins.
   * - `static`: Map<string, {handler, methods}>
   * - `dynamic`: Array<[RegExp, {handler, methods}]>
   */
  getRoutes() {
    return this.routes
  }

  /**
   * Return the list of loaded plugin names.
   * If a plugin does not declare metadata, a fallback name is used.
   * @returns {string[]}
   */
  getPluginList() {
    return this.plugins.map((p) => p.name)
  }

  /**
   * Return shallow copies of loaded plugin descriptors.
   * Each entry contains at least `{ name, description, version }`.
   */
  getPlugins() {
    return this.plugins.slice()
  }

  registerStreamInterceptor(interceptor) {
    if (typeof interceptor !== 'function')
      throw new Error('Stream interceptor must be a function')
    this.streamInterceptors.push(interceptor)
  }

  registerBeforePlay(hook) {
    if (typeof hook !== 'function')
      throw new Error('Before-play hook must be a function')
    this.beforePlayHooks.push(hook)
  }

  async runStreamPipeline(track, url, protocol, additionalData, finalHandler) {
    let currentIndex = -1
    const dispatch = async (index) => {
      if (index <= currentIndex) throw new Error('next() called multiple times')
      currentIndex = index
      const interceptor = this.streamInterceptors[index]
      if (interceptor) {
        return interceptor(
          this.nodelink,
          track,
          url,
          protocol,
          additionalData,
          () => dispatch(index + 1)
        )
      }
      return finalHandler()
    }
    return dispatch(0)
  }

  async runBeforePlay(player, context) {
    for (const hook of this.beforePlayHooks) {
      try {
        await hook(this.nodelink, player, context)
      } catch (error) {
        logger('warn', 'Plugin', `beforePlay hook error: ${error.message}`)
      }
    }
  }

  async loadAll() {
    await this.#loadLocalPlugins()
    await this.#loadPackagePlugins()
  }

  async #loadLocalPlugins() {
    try {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = path.dirname(__filename)
      const pluginsDir = path.join(__dirname)
      const pluginsSrcDir = path.join(pluginsDir, 'src')

      const pluginFiles = []
      try {
        const files = await fs.readdir(pluginsSrcDir)
        const jsFiles = files.filter(
          (f) => f.endsWith('.js') && f !== 'pluginManager.js'
        )
        for (const f of jsFiles) {
          pluginFiles.push(path.join(pluginsSrcDir, f))
        }
      } catch (err) {
        logger(
          'debug',
          'Plugin',
          `Skipping plugin dir '${pluginsSrcDir}': ${err.message}`
        )
      }

      for (const filePath of pluginFiles) {
        await this.#loadPluginModule(filePath)
      }
    } catch (e) {
      logger('warn', 'Plugin', `Failed to load local plugins: ${e.message}`)
    }
  }

  async #loadPackagePlugins() {
    // Discover installed packages that look like nodelink plugins
    let packageJson
    try {
      const packageUrl = pathToFileURL(
        path.resolve(process.cwd(), 'package.json')
      )
      packageJson = (await import(packageUrl)).default
    } catch (error) {
      logger('debug', 'Plugin', 'No package.json found for plugin discovery')
      return
    }

    const dependencies = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {})
    }

    const pluginNames = Object.keys(dependencies).filter((name) =>
      name.toLowerCase().startsWith('nodelink-plugin-')
    )

    for (const name of pluginNames) {
      try {
        const moduleData = await import(name)
        await this.#initializePluginModule(moduleData, name)
      } catch (error) {
        logger(
          'error',
          'Plugin',
          `Failed to load package plugin '${name}': ${error.message}`
        )
      }
    }
  }

  async #loadPluginModule(filePath) {
    try {
      const fileUrl = pathToFileURL(filePath)
      const moduleData = await import(fileUrl)
      const name = path.basename(filePath)
      await this.#initializePluginModule(moduleData, name)
    } catch (error) {
      logger(
        'error',
        'Plugin',
        `Failed to load plugin '${filePath}': ${error.message}`
      )
    }
  }

  async #initializePluginModule(moduleData, name = 'unknown') {
    const plugin = moduleData?.default || moduleData
    if (!plugin) {
      logger('warn', 'Plugin', `Plugin '${name}' has no default export`)
      return
    }

    const pluginApi = this.#buildPluginApi()
    try {
      if (typeof plugin === 'function') {
        await plugin(this.nodelink, pluginApi)
      } else if (plugin && typeof plugin.register === 'function') {
        await plugin.register(this.nodelink, pluginApi)
      } else if (plugin && typeof plugin.init === 'function') {
        await plugin.init(this.nodelink, pluginApi)
      } else {
        logger(
          'warn',
          'Plugin',
          `Plugin '${name}' does not export a function or {register|init}`
        )
        return
      }
      const meta = this.#extractMetadata(moduleData, plugin, name)
      this.plugins.push(meta)
      logger('info', 'Plugin', `Loaded plugin: ${name}`)
    } catch (error) {
      logger(
        'error',
        'Plugin',
        `Plugin '${name}' initialization failed: ${error.message}`
      )
    }
  }

  #extractMetadata(moduleData, plugin, fallbackName) {
    const tryMetadata = (obj) => {
      if (!obj || typeof obj !== 'object') return null
      const { name, description, version } = obj
      if (!(name || description || version)) return null
      return {
        name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
        description:
          typeof description === 'string' && description.trim()
            ? description.trim()
            : undefined,
        version:
          typeof version === 'string' && version.trim()
            ? version.trim()
            : undefined
      }
    }

    let metadata = null
    if (typeof plugin === 'function') {
      metadata =
        tryMetadata(plugin.pluginInfo) || tryMetadata(plugin.meta) || null
    }
    metadata =
      metadata ||
      tryMetadata(moduleData?.pluginInfo) ||
      tryMetadata(moduleData?.meta) ||
      null
    if (
      !metadata &&
      plugin &&
      typeof plugin === 'object' &&
      (plugin.name || plugin.description || plugin.version)
    ) {
      metadata = tryMetadata(plugin)
    }

    return {
      name: metadata?.name || String(fallbackName),
      description: metadata?.description || 'unknown',
      version: metadata?.version || 'unknown'
    }
  }

  async initialize(moduleData, name = 'unknown') {
    return this.#initializePluginModule(moduleData, name)
  }

  #buildPluginApi() {
    return {
      // HTTP routes
      addRoute: (pathnameOrRegex, handler, methods) =>
        this.addRoute(pathnameOrRegex, handler, methods),
      // Sources/Lyrics registration helpers
      registerSource: (name, instance) =>
        this.nodelink?.sources?.addSource?.(name, instance),
      registerLyricsSource: (name, instance) =>
        this.nodelink?.lyrics?.addLyricsSource?.(name, instance),
      registerStreamInterceptor: (interceptor) =>
        this.registerStreamInterceptor(interceptor),
      registerBeforePlay: (hook) => this.registerBeforePlay(hook),
      // Utilities
      logger,
      config: this.nodelink?.options,
      version: this.nodelink?.version
    }
  }
}
