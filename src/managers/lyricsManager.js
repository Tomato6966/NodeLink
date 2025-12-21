import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.js'

let lyricRegistry
try {
  const mod = await import('../registry.js')
  lyricRegistry = mod.lyricRegistry
} catch {}

export default class LyricsManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.lyricsSources = new Map()
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const lyricsDir = path.join(__dirname, '../lyrics')

    this.lyricsSources.clear()

    if (lyricRegistry && Object.keys(lyricRegistry).length > 0) {
      await Promise.all(
        Object.entries(lyricRegistry).map(async ([name, mod]) => {
          if (!this.nodelink.options.lyrics?.[name]?.enabled) return

          const Mod = mod.default || mod
          const instance = new Mod(this.nodelink)

          if (await instance.setup()) {
            this.lyricsSources.set(name, instance)
            logger('info', 'Lyrics', `Loaded lyrics source: ${name}`)
          } else {
            logger(
              'error',
              'Lyrics',
              `Failed setup for lyrics source: ${name}; source not available.`
            )
          }
        })
      )
      return
    }

    try {
      await fs.access(lyricsDir)
      const files = await fs.readdir(lyricsDir)
      const jsFiles = files.filter((f) => f.endsWith('.js'))
      const toLoad = jsFiles.filter((f) => {
        const name = path.basename(f, '.js')
        return !!this.nodelink.options.lyrics?.[name]?.enabled
      })

      await Promise.all(
        toLoad.map(async (file) => {
          const name = path.basename(file, '.js')
          const filePath = path.join(lyricsDir, file)
          const fileUrl = new URL(`file://${filePath}`)
          const Mod = (await import(fileUrl)).default

          const instance = new Mod(this.nodelink)
          if (await instance.setup()) {
            this.lyricsSources.set(name, instance)
            logger('info', 'Lyrics', `Loaded lyrics source: ${name}`)
          } else {
            logger(
              'error',
              'Lyrics',
              `Failed setup for lyrics source: ${name}; source not available.`
            )
          }
        })
      )
    } catch {
      logger(
        'info',
        'Lyrics',
        `Lyrics directory not found, creating at: ${lyricsDir}`
      )
      await fs.mkdir(lyricsDir, { recursive: true })
    }
  }

  async loadLyrics(decodedTrack, language) {
    if (
      !decodedTrack ||
      !decodedTrack.info?.sourceName ||
      !decodedTrack.info?.uri
    ) {
      logger(
        'warn',
        'Lyrics',
        'Invalid track object provided to loadLyrics',
        decodedTrack
      )
      return {
        loadType: 'error',
        data: { message: 'Invalid track object provided.', severity: 'common' }
      }
    }

    logger(
      'debug',
      'Lyrics',
      `Loading lyrics for track: ${decodedTrack.info.title}`
    )

    const reliableTrackData = await this.nodelink.sources.resolve(
      decodedTrack.info.uri
    )

    if (reliableTrackData.loadType !== 'track') {
      logger(
        'warn',
        'Lyrics',
        `Could not re-fetch track information for ${decodedTrack.info.title}`
      )
      return {
        loadType: 'error',
        data: {
          message:
            'Could not re-fetch track information before loading lyrics.',
          severity: 'fault'
        }
      }
    }

    const sourceName = reliableTrackData.data.info.sourceName
    const lyricsSource = this.lyricsSources.get(sourceName)

    if (lyricsSource) {
      const lyrics = await lyricsSource.getLyrics(
        reliableTrackData.data.info,
        language
      )
      if (lyrics && lyrics.loadType !== 'empty') {
        return lyrics
      }
    }

    for (const [name, source] of this.lyricsSources) {
      if (name !== sourceName) {
        logger(
          'debug',
          'Lyrics',
          `Trying lyrics source ${name} for ${reliableTrackData.data.info.title}.`
        )
        const lyrics = await source.getLyrics(
          reliableTrackData.data.info,
          language
        )
        if (lyrics && lyrics.loadType !== 'empty') {
          return lyrics
        }
      }
    }

    logger(
      'debug',
      'Lyrics',
      `No lyrics found for ${reliableTrackData.data.info.title}`
    )
    return { loadType: 'empty', data: {} }
  }
}
