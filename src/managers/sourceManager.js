import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.js'

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
    const jsFiles = files.filter((f) => f.endsWith('.js'))
    const toLoad = jsFiles.filter((f) => {
      const name = path.basename(f, '.js')
      return (
        name !== 'youtube' && !!this.nodelink.options.sources[name]?.enabled
      )
    })

    this.sources.clear()
    this.searchTermMap.clear()
    this.patternMap = []

    if (this.nodelink.options.sources.youtube?.enabled) {
      const name = 'youtube'
      const filePath = path.join(sourcesDir, 'youtube', 'YouTube.js')
      const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
      const Mod = (await import(fileUrl)).default

      const instance = new Mod(this.nodelink)
      if (await instance.setup()) {
        this.sources.set(name, instance)

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
          'info',
          'Sources',
          `Loaded source: ${name} ${instance.searchTerms?.length ? `(terms: ${instance.searchTerms.join(', ')})` : ''}`
        )
      } else {
        logger(
          'error',
          'Sources',
          `Failed setup source: ${name}; source not available for use`
        )
      }
    }

    await Promise.all(
      toLoad.map(async (file) => {
        const name = path.basename(file, '.js')
        const filePath = path.join(sourcesDir, file)
        const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
        const Mod = (await import(fileUrl)).default

        const instance = new Mod(this.nodelink)
        if (await instance.setup()) {
          this.sources.set(name, instance)
        } else {
          logger(
            'error',
            'Sources',
            `Failed setup source: ${name}; source not available for use`
          )
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
          'info',
          'Sources',
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
    logger('debug', 'Sources', `Searching on ${sourceName} for: "${query}"`)
    return instance.search(query)
  }

  async searchWithDefault(query) {
    const defaultSource = this.nodelink.options.defaultSearchSource
    const sourceName = this.searchTermMap.get(defaultSource) || defaultSource
    const instance = this.sources.get(sourceName)
    logger(
      'debug',
      'Sources',
      `Searching on default source "${sourceName}" for: "${query}"`
    )
    return instance.search(query)
  }

  async unifiedSearch(query) {
    const searchSources = this.nodelink.options.unifiedSearchSources || ['youtube']
    logger('debug', 'Sources', `Performing unified search for "${query}" on [${searchSources.join(', ')}]`)

    const searchPromises = searchSources.map(sourceName => {
      const instance = this.sources.get(sourceName)
      if (!instance || typeof instance.search !== 'function') {
        logger('warn', 'Sources', `Unified search configured for unknown or non-searchable source: ${sourceName}`)
        return Promise.resolve({ loadType: 'empty', data: {} })
      }
      return instance.search(query)
    })

    const results = await Promise.allSettled(searchPromises)
    
    const allTracks = []
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value.loadType === 'search') {
        allTracks.push(...result.value.data)
      } else if (result.status === 'rejected') {
        logger('warn', 'Sources', `A source failed during unified search: ${result.reason}`)
      }
    })

    if (allTracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: `Search results for: ${query}`,
          selectedTrack: -1
        },
        pluginInfo: {},
        tracks: allTracks
      }
    }
  }

  async resolve(url) {
    const sourceName = this.patternMap.find(({ regex }) =>
      regex.test(url)
    )?.sourceName
    if (
      !sourceName &&
      (url.startsWith('https://') || url.includes('http://'))
    ) {
      const instance = this.sources.get('http')
      logger('debug', 'Sources', `Resolving with http source for: ${url}`)
      const result = await instance.resolve(url)
      return result
    } else if (!sourceName) {
      logger('warn', 'Sources', `No source found for URL: ${url}`)
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
    logger('debug', 'Sources', `Resolving with ${sourceName} for: ${url}`)
    return instance.resolve(url)
  }

  async reload() {
    await this.loadFolder()
  }

  async getTrackUrl(track) {
    const instance = this.sources.get(track.sourceName)
    return await instance.getTrackUrl(track)
  }

  async getTrackStream(track, url, protocol, additionalData) {
    const instance = this.sources.get(track.sourceName)
    return await instance.loadStream(track, url, protocol, additionalData)
  }

  getAllSources() {
    return Array.from(this.sources.values())
  }
}
