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
    this.searchTermMap = new Map()
    this.patternMap = []
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const sourcesDir = path.join(__dirname, '../sources')

    this.sources.clear()
    this.searchTermMap.clear()
    this.patternMap = []

    if (sourceRegistry && Object.keys(sourceRegistry).length > 0) {
      await Promise.all(
        Object.entries(sourceRegistry).map(async ([name, mod]) => {
          const isYouTube = name === 'youtube' || name.includes('YouTube.js')
          const enabled = isYouTube
            ? this.nodelink.options.sources.youtube?.enabled
            : !!this.nodelink.options.sources[name]?.enabled

          if (!enabled) return

          const Mod = mod.default || mod
          const instance = new Mod(this.nodelink)

          if (await instance.setup()) {
            const sourceKey = isYouTube ? 'youtube' : name
            this.sources.set(sourceKey, instance)

            if (isYouTube) this.sources.set('ytmusic', instance)

            if (Array.isArray(instance.searchTerms)) {
              for (const term of instance.searchTerms) {
                this.searchTermMap.set(term, sourceKey)
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
        })
      )
      this.patternMap.sort((a, b) => b.priority - a.priority)
      return
    }

    try {
      await fs.access(sourcesDir)
      const files = await fs.readdir(sourcesDir)
      const jsFiles = files.filter((f) => f.endsWith('.js'))
      const toLoad = jsFiles.filter((f) => {
        const name = path.basename(f, '.js')
        return (
          name !== 'youtube' && !!this.nodelink.options.sources[name]?.enabled
        )
      })

      if (this.nodelink.options.sources.youtube?.enabled) {
        const name = 'youtube'
        const filePath = path.join(sourcesDir, 'youtube', 'YouTube.js')
        const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
        const Mod = (await import(fileUrl)).default

        const instance = new Mod(this.nodelink)
        if (await instance.setup()) {
          this.sources.set(name, instance)

          this.sources.set('ytmusic', instance)

          if (Array.isArray(instance.searchTerms)) {
            for (const term of instance.searchTerms) {
              this.searchTermMap.set(term, name)
            }
          }

          if (Array.isArray(instance.patterns)) {
            for (const regex of instance.patterns) {
              if (regex instanceof RegExp) {
                this.patternMap.push({
                  regex,
                  sourceName: name,
                  priority: instance.priority || 0
                })
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
                this.patternMap.push({
                  regex,
                  sourceName: name,
                  priority: instance.priority || 0
                })
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
    } catch (e) {
      logger('error', 'Sources', `Sources directory not found or error loading sources: ${sourcesDir} - ${e.message}`)
    }
    this.patternMap.sort((a, b) => b.priority - a.priority)
  }

  async _instrumentedSourceCall(sourceName, method, ...args) {
    const instance = this.sources.get(sourceName)
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
    const sourceName = this.searchTermMap.get(sourceTerm)
    if (!sourceName) {
      throw new Error(`Source not found for term: ${sourceTerm}`)
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

    logger('debug', 'Sources', `Searching on ${sourceName} (${searchType}) for: "${searchQuery}"`)
    return this._instrumentedSourceCall(sourceName, 'search', searchQuery, sourceTerm, searchType)
  }

  async searchWithDefault(query) {
    const defaultSource = this.nodelink.options.defaultSearchSource
    const sourceName = this.searchTermMap.get(defaultSource) || defaultSource
    logger(
      'debug',
      'Sources',
      `Searching on default source "${sourceName}" for: "${query}"`
    )
    return this._instrumentedSourceCall(sourceName, 'search', query)
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
        return { loadType: 'error', data: { message: e.message } } // Return an error object to not break allSettled
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
    let sourceName = this.patternMap.find(({ regex }) =>
      regex.test(url)
    )?.sourceName

    if (
      !sourceName &&
      (url.startsWith('https://') || url.startsWith('http://'))
    ) {
      sourceName = 'http'
    }

    if (!sourceName) {
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
    const instance = this.sources.get(track.sourceName)
    return await instance.getTrackUrl(track, itag)
  }

  async getTrackStream(track, url, protocol, additionalData) {
    const instance = this.sources.get(track.sourceName)
    return await instance.loadStream(track, url, protocol, additionalData)
  }

  async getChapters(track) {
    const instance = this.sources.get(track.info.sourceName)
    if (!instance || typeof instance.getChapters !== 'function') {
      return []
    }
    return await instance.getChapters(track.info)
  }

  getAllSources() {
    return Array.from(this.sources.values())
  }

  getSource(name) {
    return this.sources.get(name)
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
