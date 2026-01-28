import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.js'

let meaningRegistry
try {
  const mod = await import('../registry.js')
  meaningRegistry = mod.meaningRegistry
} catch {}

export default class MeaningManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.meaningSources = new Map()
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const meaningsDir = path.join(__dirname, '../meanings')

    this.meaningSources.clear()

    if (meaningRegistry && Object.keys(meaningRegistry).length > 0) {
      await Promise.all(
        Object.entries(meaningRegistry).map(async ([name, mod]) => {
          if (!this.nodelink.options.meanings?.[name]?.enabled) return

          const Mod = mod.default || mod
          const instance = new Mod(this.nodelink)

          if (await instance.setup()) {
            this.meaningSources.set(name, instance)
            logger('info', 'Meaning', `Loaded meaning source: ${name}`)
          } else {
            logger(
              'error',
              'Meaning',
              `Failed setup for meaning source: ${name}; source not available.`
            )
          }
        })
      )
      return
    }

    try {
      await fs.access(meaningsDir)
      const files = await fs.readdir(meaningsDir)
      const jsFiles = files.filter((f) => f.endsWith('.js'))
      const toLoad = jsFiles.filter((f) => {
        const name = path.basename(f, '.js')
        return !!this.nodelink.options.meanings?.[name]?.enabled
      })

      await Promise.all(
        toLoad.map(async (file) => {
          const name = path.basename(file, '.js')
          const filePath = path.join(meaningsDir, file)
          const fileUrl = new URL(`file://${filePath}`)
          const Mod = (await import(fileUrl)).default

          const instance = new Mod(this.nodelink)
          if (await instance.setup()) {
            this.meaningSources.set(name, instance)
            logger('info', 'Meaning', `Loaded meaning source: ${name}`)
          } else {
            logger(
              'error',
              'Meaning',
              `Failed setup for meaning source: ${name}; source not available.`
            )
          }
        })
      )
    } catch {
      logger(
        'info',
        'Meaning',
        `Meanings directory not found, creating at: ${meaningsDir}`
      )
      await fs.mkdir(meaningsDir, { recursive: true })
    }
  }

  async loadMeaning(decodedTrack, language) {
    if (!decodedTrack || !decodedTrack.info?.sourceName) {
      logger('warn', 'Meaning', 'Invalid track object provided to loadMeaning')
      return {
        loadType: 'error',
        data: { message: 'Invalid track object provided.', severity: 'common' }
      }
    }

    const trackInfo = decodedTrack.info
    const sourceName = trackInfo.sourceName
    const meaningSource = this.meaningSources.get(sourceName)

    if (meaningSource) {
      const meaning = await meaningSource.getMeaning(trackInfo, language)
      if (meaning && meaning.loadType !== 'empty') {
        meaning.data.provider = sourceName
        return meaning
      }
    }

    const sortedSources = Array.from(this.meaningSources.entries()).sort(
      (a, b) => (b[1].priority || 0) - (a[1].priority || 0)
    )

    for (const [name, source] of sortedSources) {
      if (name !== sourceName) {
        const meaning = await source.getMeaning(trackInfo, language)
        if (meaning && meaning.loadType !== 'empty') {
          meaning.data.provider = name
          return meaning
        }
      }
    }

    return { loadType: 'empty', data: {} }
  }
}
