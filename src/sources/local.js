import fs from 'node:fs'

import { debugLog, encodeTrack } from '../utils.js'

async function loadFrom(path) {
  debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'local', query: path })

  fs.open(path, (err) => {
    if (err) {
      debugLog('loadtracks', 4, { type: 2, loadType: 'error', sourceName: 'local', query: path, message: 'Failed to retrieve stream from source. (File not found or not accessible)' })

      return {
        loadType: 'error',
        exception: {
          message: 'Failed to retrieve stream from source. (File not found or not accessible)',
          severity: 'common',
          cause: 'No permission to access file or doesn\'t exist'
        }
      }
    }
  
    const track = {
      identifier: 'unknown',
      isSeekable: false,
      author: 'unknown',
      length: -1,
      isStream: false,
      position: 0,
      title: 'unknown',
      uri: path,
      artworkUrl: null,
      isrc: null,
      sourceName: 'local'
    }

    debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'local', track, query: path })

    return {
      loadType: 'track',
      data: {
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {}
      }
    }
  })
}

export default loadFrom