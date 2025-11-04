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

  getRoutes() {
    return this.routes
  }

  getPluginList() {
    return this.plugins.map((p) => p.name)
  }

  registerStreamInterceptor(fn) {
    if (typeof fn !== 'function') throw new Error('Stream interceptor must be a function')
    this.streamInterceptors.push(fn)
  }

  registerBeforePlay(fn) {
    if (typeof fn !== 'function') throw new Error('Before-play hook must be a function')
    this.beforePlayHooks.push(fn)
  }

  async runStreamPipeline(track, url, protocol, additionalData, finalHandler) {
    let idx = -1
    const dispatch = async (i) => {
      if (i <= idx) throw new Error('next() called multiple times')
      idx = i
      const interceptor = this.streamInterceptors[i]
      if (interceptor) {
        return interceptor(
          this.nodelink,
          track,
          url,
          protocol,
          additionalData,
          () => dispatch(i + 1)
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
      } catch (e) {
        logger('warn', 'Plugin', `beforePlay hook error: ${e.message}`)
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
      const pluginsDir = path.join(__dirname) // src/plugins
      const pluginsSrcDir = path.join(pluginsDir, 'src') // src/plugins/src

      // Only search for plugin files in src/plugins/src/ as requested.
      const pluginFiles = []
      try {
        const files = await fs.readdir(pluginsSrcDir)
        const jsFiles = files.filter((f) => f.endsWith('.js') && f !== 'pluginManager.js')
        for (const f of jsFiles) {
          pluginFiles.push(path.join(pluginsSrcDir, f))
        }
      } catch (err) {
        logger('debug', 'Plugin', `Skipping plugin dir '${pluginsSrcDir}': ${err.message}`)
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
    let pkgJson
    try {
      const pkgUrl = pathToFileURL(path.resolve(process.cwd(), 'package.json'))
      pkgJson = (await import(pkgUrl)).default
    } catch (e) {
      logger('debug', 'Plugin', 'No package.json found for plugin discovery')
      return
    }

    const deps = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.devDependencies || {})
    }

    const pluginNames = Object.keys(deps).filter((name) =>
      name.toLowerCase().startsWith('nodelink-plugin-')
    )

    for (const name of pluginNames) {
      try {
        const mod = await import(name)
        await this.#initializePluginModule(mod, name)
      } catch (e) {
        logger(
          'error',
          'Plugin',
          `Failed to load package plugin '${name}': ${e.message}`
        )
      }
    }
  }

  async #loadPluginModule(filePath) {
    try {
      const fileUrl = pathToFileURL(filePath)
      const mod = await import(fileUrl)
      const name = path.basename(filePath)
      await this.#initializePluginModule(mod, name)
    } catch (e) {
      logger('error', 'Plugin', `Failed to load plugin '${filePath}': ${e.message}`)
    }
  }

  async #initializePluginModule(mod, name = 'unknown') {
    const plugin = mod?.default || mod
    if (!plugin) {
      logger('warn', 'Plugin', `Plugin '${name}' has no default export`)
      return
    }

    const api = this.#buildApi()
    try {
      if (typeof plugin === 'function') {
        await plugin(this.nodelink, api)
      } else if (plugin && typeof plugin.register === 'function') {
        await plugin.register(this.nodelink, api)
      } else if (plugin && typeof plugin.init === 'function') {
        await plugin.init(this.nodelink, api)
      } else {
        logger(
          'warn',
          'Plugin',
          `Plugin '${name}' does not export a function or {register|init}`
        )
        return
      }
      this.plugins.push({ name })
      logger('info', 'Plugin', `Loaded plugin: ${name}`)
    } catch (e) {
      logger('error', 'Plugin', `Plugin '${name}' initialization failed: ${e.message}`)
    }
  }

  #buildApi() {
    return {
      // HTTP routes
      addRoute: (pathnameOrRegex, handler, methods) =>
        this.addRoute(pathnameOrRegex, handler, methods),
      // Sources/Lyrics registration helpers
      registerSource: (name, instance) =>
        this.nodelink?.sources?.addSource?.(name, instance),
      registerLyricsSource: (name, instance) =>
        this.nodelink?.lyrics?.addLyricsSource?.(name, instance),
      registerStreamInterceptor: (fn) => this.registerStreamInterceptor(fn),
      registerBeforePlay: (fn) => this.registerBeforePlay(fn),
      // Utilities
      logger,
      config: this.nodelink?.options,
      version: this.nodelink?.version
    }
  }
}
