import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '../utils.js'

const require = createRequire(import.meta.url)

export default class PluginManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.config = nodelink.options.plugins || []
    this.pluginConfigs = nodelink.options.pluginConfig || {}
    this.pluginsDir = path.join(process.cwd(), 'plugins')
    this.loadedPlugins = new Map()
  }

  async load(contextType) {
    logger('info', 'PluginManager', `Initializing plugins in ${contextType} context...`)

    try {
      await fs.access(this.pluginsDir)
    } catch {
      await fs.mkdir(this.pluginsDir, { recursive: true })
    }

    if (Array.isArray(this.config)) {
      for (const pluginDef of this.config) {
        await this._loadPlugin(pluginDef, contextType)
      }
    }

    logger('info', 'PluginManager', `Plugins processed for ${contextType}.`)
  }

  async _findPackageJson(startPath) {
    let currentDir = path.dirname(startPath)
    
    while (currentDir !== path.parse(currentDir).root) {
      const pkgPath = path.join(currentDir, 'package.json')
      try {
        await fs.access(pkgPath)
        const data = await fs.readFile(pkgPath, 'utf-8')
        return JSON.parse(data)
      } catch {
        if (path.basename(currentDir) === 'node_modules') break
        currentDir = path.dirname(currentDir)
      }
    }
    return null
  }

  async _loadPlugin(def, contextType) {
    const { name, source, path: localPath, package: packageName } = def

    if (!name) return

    if (this.loadedPlugins.has(name)) {
      const cached = this.loadedPlugins.get(name)
      await this._executePlugin(cached.module, name, contextType, cached.meta)
      return
    }

    try {
      let entryPoint = null
      let pluginMeta = {
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
            const pkg = JSON.parse(pkgData)
            
            if (pkg.version) pluginMeta.version = pkg.version
            if (pkg.author) pluginMeta.author = typeof pkg.author === 'object' ? pkg.author.name : pkg.author
            if (pkg.homepage || (pkg.repository && pkg.repository.url)) {
              pluginMeta.topic = pkg.homepage || pkg.repository.url
            }

            if (pkg.main) {
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
            if (pkg.author) pluginMeta.author = typeof pkg.author === 'object' ? pkg.author.name : pkg.author
            if (pkg.homepage || (pkg.repository && pkg.repository.url)) {
              pluginMeta.topic = pkg.homepage || pkg.repository.url
            }
          }
        } catch (e) {
          logger('warn', 'PluginManager', `NPM package '${packageName || name}' not found.`)
          return
        }
      }

      if (!entryPoint) return

      const fileUrl = pathToFileURL(entryPoint).href
      const pluginModule = await import(fileUrl)

      if (typeof pluginModule.default !== 'function') {
        throw new Error(`Plugin '${name}' entry point must export a default function.`)
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
      const topic = pluginMeta.topic ? ` | \x1b[34mTopic:\x1b[0m ${pluginMeta.topic}` : ''

      const creditString = `[${author}] ${pluginName} ${version}${topic}`
      
      logger('info', 'PluginManager', `Loaded: ${creditString}`)

    } catch (error) {
      logger('error', 'PluginManager', `Failed to load plugin '${name}': ${error.message}`)
    }
  }

  async _executePlugin(pluginModule, name, contextType, meta) {
    const specificConfig = this.pluginConfigs[name] || {}
    const context = {
      type: contextType,
      workerId: process.pid,
      pluginName: name,
      meta
    }

    try {
      await pluginModule.default(this.nodelink, specificConfig, context)
    } catch (err) {
      logger('error', 'PluginManager', `Error executing plugin '${name}' in '${contextType}' context: ${err.message}`)
    }
  }
}