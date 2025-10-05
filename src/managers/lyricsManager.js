import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../utils.js'

export default class LyricsManager {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.lyricsSources = new Map()
  }

  async loadFolder() {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const lyricsDir = path.join(__dirname, '../lyrics')

    try {
      await fs.access(lyricsDir)
    } catch {
      logger(
        'info',
        'Lyrics',
        `Lyrics directory not found, creating at: ${lyricsDir}`
      )
      await fs.mkdir(lyricsDir)
    }

    const files = await fs.readdir(lyricsDir)
    const jsFiles = files.filter((f) => f.endsWith('.js'))
    const toLoad = jsFiles.filter((f) => {
      const name = path.basename(f, '.js')
      return !!this.nodelink.options.lyrics?.[name]?.enabled
    })

    this.lyricsSources.clear()

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
  }

  async loadLyrics(decodedTrack) {
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
      const lyrics = await lyricsSource.getLyrics(reliableTrackData.data.info)
      if (lyrics && lyrics.loadType !== 'empty') {
        return lyrics
      }
    }

    const fallbackSourceName = this.nodelink.options.lyrics?.fallbackSource
    if (fallbackSourceName && fallbackSourceName !== sourceName) {
      const fallbackSource = this.lyricsSources.get(fallbackSourceName)
      if (fallbackSource) {
        logger(
          'debug',
          'Lyrics',
          `No lyrics found on ${sourceName}, trying fallback ${fallbackSourceName} for ${reliableTrackData.data.info.title}.`
        )
        return fallbackSource.getLyrics(reliableTrackData.data.info)
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
