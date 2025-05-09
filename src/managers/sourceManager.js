import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../utils.js'
import { fileURLToPath } from 'node:url'

export default class SourcesManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.sources = new Map()
    this.searchTermMap = new Map()
    this.patternMap = []
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const sourcesDir = path.join(__dirname, '../sources')

    try {
      await fs.access(sourcesDir)
    } catch {
      throw new Error(`Sources directory not found: ${sourcesDir}`)
    }

    const files = await fs.readdir(sourcesDir)
    const jsFiles = files.filter(f => f.endsWith('.js'))
    const toLoad = jsFiles.filter(f => {
      const name = path.basename(f, '.js')
      return !!this.nodelink.options.sources[name]?.enabled
    })

    this.sources.clear()
    this.searchTermMap.clear()

    await Promise.all(
      toLoad.map(async file => {
        const name = path.basename(file, '.js')
        const filePath = path.join(sourcesDir, file)
        const fileUrl = new URL(`file://${filePath}`)
        const Mod = (await import(fileUrl)).default

        const instance = new Mod(this.nodelink)
        if (await instance.setup()) {
          this.sources.set(name, instance)
        } else {
          logger('sources', 'error', `Failed setup source: ${name}; source not available for use`)
          return
        }

        if (Array.isArray(instance.searchTerms)) {
          for (const term of instance.searchTerms) {
            this.searchTermMap.set(term, name)
          }
        }

        if (Array.isArray(instance.patterns)) {
          for (const regex of instance.patterns) {
            if (regex instanceof RegExp) {
              this.patternMap.push({ regex, sourceName: name })
            }
          }
        }
        logger(
          'sources',
          'info',
          `Loaded source: ${name} ${instance.searchTerms?.length ? `(terms: ${instance.searchTerms.join(', ')})` : ''}`
        )
      })
    )
  }

  async search(sourceTerm, query) {
    const sourceName = this.searchTermMap.get(sourceTerm)
    if (!sourceName) {
      throw new Error(`Source not found for term: ${sourceTerm}`)
    }
    const instance = this.sources.get(sourceName)
    logger('info', 'Search', `Searching ${sourceName} for ${query}`)
    return instance.search(query)
  }

  async resolve(url) {
    const sourceName = this.patternMap.find(({ regex }) => regex.test(url))?.sourceName
    if (!sourceName) {
      return {
        loadType: 'error',
        data: {
          message: 'No source found for URL',
          severity: 'fault',
          cause: 'Unknown'
        }
      }
    }
    const instance = this.sources.get(sourceName)
    logger('info', 'Resolve', `Resolving ${sourceName} for ${url}`)
    return instance.resolve(url)
  }

  async reload() {
    await this.loadFolder()
  }

  getAllSources() {
    return Array.from(this.sources.values())
  }
}
