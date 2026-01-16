import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.js'

let sourceRegistry
try {
  const mod = await import('../registry.js')
  sourceRegistry = mod.sourceRegistry
} catch {}

export default class SourcesManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.sources = new Map()
    this.sourceMap = new Map()
    this.searchAliasMap = new Map()
    this.patternMap = []
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const sourcesDir = path.join(__dirname, '../sources')

    this.sources.clear()
    this.sourceMap.clear()
    this.searchAliasMap.clear()
    this.patternMap = []

    const processSource = async (name, mod) => {
      const isYouTube = name === 'youtube' || name.includes('YouTube.js')
      const sourceKey = isYouTube ? 'youtube' : name

      const enabled = isYouTube
        ? this.nodelink.options.sources.youtube?.enabled
        : !!this.nodelink.options.sources[sourceKey]?.enabled

      if (!enabled) return

      const Mod = mod.default || mod
      const instance = new Mod(this.nodelink)

      if (await instance.setup()) {
        this.sources.set(sourceKey, instance)
        this.sourceMap.set(sourceKey, instance)

        if (Array.isArray(instance.additionalsSourceName)) {
          for (const addName of instance.additionalsSourceName) {
            this.sourceMap.set(addName, instance)
          }
        }

        if (Array.isArray(instance.searchTerms)) {
          for (const term of instance.searchTerms) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.recommendationTerm)) {
          for (const term of instance.recommendationTerm) {
            this.searchAliasMap.set(term, instance)
          }
        }

        if (Array.isArray(instance.patterns)) {
          for (const regex of instance.patterns) {
            if (regex instanceof RegExp) {
              this.patternMap.push({
                regex,
                sourceName: sourceKey,
                priority: instance.priority || 0
              })
            }
          }
        }
        logger('info', 'Sources', `Loaded source: ${sourceKey}`)
      }
    }

    if (sourceRegistry && Object.keys(sourceRegistry).length > 0) {
      await Promise.all(
        Object.entries(sourceRegistry).map(([name, mod]) =>
          processSource(name, mod)
        )
      )
    } else {
      try {
        await fs.access(sourcesDir)
        const files = await fs.readdir(sourcesDir, { recursive: true })
        const jsFiles = files.filter(
          (f) => f.endsWith('.js') && !f.includes('clients/')
        )

        await Promise.all(
          jsFiles.map(async (file) => {
            const name = path.basename(file, '.js').toLowerCase()
            const filePath = path.join(sourcesDir, file)
            const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
            const mod = await import(fileUrl)
            await processSource(name, mod)
          })
        )
      } catch (e) {
        logger('error', 'Sources', `Error loading sources: ${e.message}`)
      }
    }

    this.patternMap.sort((a, b) => b.priority - a.priority)
  }

  async _instrumentedSourceCall(sourceName, method, ...args) {
    const instance = this.sourceMap.get(sourceName)
    if (!instance || typeof instance[method] !== 'function') {
      this.nodelink.statsManager.incrementSourceFailure(sourceName || 'unknown')
      throw new Error(
        `Source ${sourceName} not found or does not support ${method}`
      )
    }

    try {
      const result = await instance[method](...args)
      if (result.loadType === 'error') {
        this.nodelink.statsManager.incrementSourceFailure(sourceName)
      } else {
        this.nodelink.statsManager.incrementSourceSuccess(sourceName)
      }
      return result
    } catch (e) {
      this.nodelink.statsManager.incrementSourceFailure(sourceName)
      throw e
    }
  }

  async search(sourceTerm, query) {
    let instance = this.searchAliasMap.get(sourceTerm)
    const sourceName = sourceTerm

    if (!instance) {
      instance = this.sourceMap.get(sourceTerm)
    }

    if (!instance) {
      throw new Error(`Source or search alias not found for: ${sourceTerm}`)
    }

    let searchType = 'track'
    let searchQuery = query

    if (query.includes(':')) {
      const parts = query.split(':')
      const possibleType = parts[0].toLowerCase()
      const types = ['playlist', 'artist', 'album', 'channel', 'track']

      if (types.includes(possibleType)) {
        searchType = possibleType
        searchQuery = parts.slice(1).join(':')
      }
    }

    const name = instance.constructor.name.replace('Source', '').toLowerCase()
    logger(
      'debug',
      'Sources',
      `Searching on ${name} (${searchType}) for: "${searchQuery}"`
    )
    return this._instrumentedSourceCall(
      name,
      'search',
      searchQuery,
      sourceName,
      searchType
    )
  }

  async searchWithDefault(query) {
    const defaultSources = Array.isArray(
      this.nodelink.options.defaultSearchSource
    )
      ? this.nodelink.options.defaultSearchSource
      : [this.nodelink.options.defaultSearchSource]

    for (const source of defaultSources) {
      try {
        const result = await this.search(source, query)
        if (result.loadType === 'search' && result.data.length > 0) {
          return result
        }
      } catch (e) {
        logger(
          'warn',
          'Sources',
          `Default source search failed for ${source}: ${e.message}`
        )
      }
    }

    return { loadType: 'empty', data: {} }
  }

  async unifiedSearch(query) {
    const searchSources = this.nodelink.options.unifiedSearchSources || [
      'youtube'
    ]
    logger(
      'debug',
      'Sources',
      `Performing unified search for "${query}" on [${searchSources.join(', ')}]`
    )

    const searchPromises = searchSources.map((sourceName) =>
      this._instrumentedSourceCall(sourceName, 'search', query).catch((e) => {
        logger(
          'warn',
          'Sources',
          `A source (${sourceName}) failed during unified search: ${e.message}`
        )
        return { loadType: 'error', data: { message: e.message } }
      })
    )

    const results = await Promise.all(searchPromises)

    const allTracks = []
    results.forEach((result) => {
      if (result.loadType === 'search') {
        allTracks.push(...result.data)
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
    let sourceName = null

    for (let i = 0; i < this.patternMap.length; i++) {
      if (this.patternMap[i].regex.test(url)) {
        sourceName = this.patternMap[i].sourceName
        break
      }
    }

    if (
      !sourceName &&
      (url.startsWith('https://') || url.startsWith('http://'))
    ) {
      sourceName = 'http'
    }

    if (!sourceName || !this.sourceMap.has(sourceName)) {
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

    logger('debug', 'Sources', `Resolving with ${sourceName} for: ${url}`)
    return this._instrumentedSourceCall(sourceName, 'resolve', url)
  }

  async reload() {
    await this.loadFolder()
  }

  async getTrackUrl(track, itag) {
    const instance = this.sourceMap.get(track.sourceName)
    return await instance.getTrackUrl(track, itag)
  }

  async getTrackStream(track, url, protocol, additionalData) {
    const instance = this.sourceMap.get(track.sourceName)
    return await instance.loadStream(track, url, protocol, additionalData)
  }

  async getChapters(track) {
    const sourceName = track.info?.sourceName
    if (!sourceName) return []

    const instance = this.sourceMap.get(sourceName)
    if (!instance || typeof instance.getChapters !== 'function') {
      return []
    }
    return await instance.getChapters(track.info)
  }

  getAllSources() {
    return Array.from(this.sources.values())
  }

  getSource(name) {
    return this.sourceMap.get(name)
  }

  getEnabledSourceNames() {
    const enabledNames = []
    for (const sourceName in this.nodelink.options.sources) {
      if (this.nodelink.options.sources[sourceName]?.enabled) {
        enabledNames.push(sourceName)
      }
    }
    return enabledNames
  }
}
