import fs from 'node:fs'
import path from 'node:path'
import { encodeTrack, logger } from '../utils.js'

export default class {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.searchTerms = ['local', 'file']
  }

  async setup() {
    return true
  }

  async search(query) {
    try {
      const absolutePath = path.resolve(query)
      logger('sources', 'info', `Searching local track: ${absolutePath}`)
      await fs.promises.access(absolutePath, fs.constants.R_OK)
      const stats = await fs.promises.stat(absolutePath)
      const track = this.buildTrack(absolutePath, stats)
      logger('sources', 'info', `Local track found: ${track.info.title}`)
      return {
        loadType: 'search',
        data: [track]
      }
    } catch (err) {
      logger('sources', 'error', `Failed to search local track: ${err.message}`)
      return {
        loadType: 'empty',
        data: {}
      }
    }
  }

  async resolve(filePath) {
    try {
      const absolutePath = path.resolve(filePath)
      logger('sources', 'info', `Resolving local track: ${absolutePath}`)
      await fs.promises.access(absolutePath, fs.constants.R_OK)
      const stats = await fs.promises.stat(absolutePath)
      const track = this.buildTrack(absolutePath, stats)
      logger('sources', 'info', `Local track resolved: ${track.info.title}`)
      return {
        loadType: 'track',
        data: track
      }
    } catch (err) {
      logger('sources', 'error', `Failed to resolve local track: ${err.message}`)
      return {
        loadType: 'error',
        data: {
          message: `Failed to load track. (${err.message})`,
          severity: 'common',
          cause: 'No permission to access file or it does not exist'
        }
      }
    }
  }

  buildTrack(filePath, stats) {
    const track = {
      identifier: filePath,
      isSeekable: true,
      author: 'unknown',
      length: stats.size > 0 ? stats.size : -1,
      isStream: false,
      position: 0,
      title: path.basename(filePath),
      uri: filePath,
      artworkUrl: null,
      isrc: null,
      sourceName: 'local'
    }
    return {
      encoded: encodeTrack(track),
      info: track,
      pluginInfo: {}
    }
  }
  getTrackUrl(track) {
    const filePath = track.uri
    logger('sources', 'info', `Getting URL for local track: ${filePath}`)
    return {
      url: filePath,
      protocol: 'local',
      format: null,
      additionalData: null
    }
  }
  async loadStream(decodedTrack, url, protocol, additionalData) {
    try {
      const filePath = decodedTrack.uri
      logger('sources', 'info', `Loading stream for local track: ${filePath}`)
      await fs.promises.access(filePath, fs.constants.R_OK)
      const fileStream = fs.createReadStream(filePath, { autoClose: true })
      fileStream.on('error', err => {
        logger('sources', 'error', `Failed to create stream for local track: ${err.message}`)
        fileStream.destroy()
      })
      fileStream.once('close', () => fileStream.emit('finishBuffering'))
      logger('sources', 'info', `Stream loaded for local track: ${filePath}`)
      return {
        stream: fileStream,
        type: 'arbitrary'
      }
    } catch (err) {
      logger('sources', 'error', `Failed to load stream for local track: ${err.message}`)
      return {
        status: 1,
        exception: {
          message: `Failed to load stream. (${err.message})`,
          severity: 'common',
          cause: 'No permission to access file or it does not exist'
        }
      }
    }
  }
}
