import { PassThrough } from 'node:stream'

import config from '../config.js'
import bandcamp from './sources/bandcamp.js'
import deezer from './sources/deezer.js'
import httpSource from './sources/http.js'
import local from './sources/local.js'
import pandora from './sources/pandora.js'
import soundcloud from './sources/soundcloud.js'
import spotify from './sources/spotify.js'
import youtube from './sources/youtube.js'
import genius from './sources/genius.js'
import musixmatch from './sources/musixmatch.js'
import searchWithDefault from './sources/default.js'

import { debugLog, http1makeRequest, makeRequest } from './utils.js'

async function getTrackURL(track, toDefault) {
  switch (track.sourceName === 'pandora' || toDefault ? config.search.defaultSearchSource : track.sourceName) {
    case 'spotify': {
      const result = await searchWithDefault(`${track.title} - ${track.author}`, false)

      if (result.loadType === 'error') {
        return {
          exception: result.data
        }
      }

      if (result.loadType === 'empty') {
        return {
          exception: {
            message: 'Failed to retrieve stream from source. (Spotify track not found)',
            severity: 'common',
            cause: 'Spotify track not found'
          }
        }
      }

      const trackInfo = result.data[0].info

      return getTrackURL(trackInfo, true)
    }
    case 'ytmusic':
    case 'youtube': {
      return youtube.retrieveStream(track.identifier, track.sourceName, track.title)
    }
    case 'local': {
      return { url: track.uri, protocol: 'file', format: 'arbitrary' }
    }

    case 'http':
    case 'https': {
      return { url: track.uri, protocol: track.sourceName, format: 'arbitrary' }
    }
    case 'soundcloud': {
      return soundcloud.retrieveStream(track.identifier, track.title)
    }
    case 'bandcamp': {
      return bandcamp.retrieveStream(track.uri, track.title)
    }
    case 'deezer': {
      return deezer.retrieveStream(track.identifier, track.title)
    }
    default: {
      return {
        exception: {
          message: 'Unknown source',
          severity: 'common',
          cause: 'Not supported source.'
        }
      }
    }
  }
}

function getTrackStream(decodedTrack, url, protocol, additionalData) {
  return new Promise(async (resolve) => {
    if (protocol === 'file') {
      const file = fs.createReadStream(url)

      file.on('error', () => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Failed to retrieve stream from source. (File not found or not accessible)' })

        return resolve({
          status: 1,
          exception: {
            message: 'Failed to retrieve stream from source. (File not found or not accessible)',
            severity: 'common',
            cause: 'No permission to access file or doesn\'t exist'
          }
        })
      })

      file.on('open', () => {
        resolve({
          stream: file,
          type: 'arbitrary'
        })
      })
    } else {
      let trueSource = [ 'pandora', 'spotify' ].includes(decodedTrack.sourceName) ? config.search.defaultSearchSource : decodedTrack.sourceName

      if (trueSource === 'deezer') {
        return resolve({
          stream: await deezer.loadTrack(decodedTrack.title, url, additionalData)
        })
      }

      if (trueSource === 'soundcloud') {
        if (additionalData !== true) {
          const stream = await soundcloud.loadStream(decodedTrack.title, url, protocol)

          return resolve({
            stream
          })
        } else {
          trueSource = config.search.fallbackSearchSource
        }
      }

      const res = await ((trueSource === 'youtube' || trueSource === 'ytmusic') ? http1makeRequest : makeRequest)(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
        },
        method: 'GET',
        streamOnly: true
      })

      if (res.statusCode !== 200) {
        res.stream.emit('end') /* (http1)makeRequest will handle this automatically */

        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: `Expected 200, received ${res.statusCode}.` })

        return resolve({
          status: 1,
          exception: {
            message: `Failed to retrieve stream from source. Expected 200, received ${res.statusCode}.`,
            severity: 'suspicious',
            cause: 'Wrong status code'
          }
        })
      }

      const stream = new PassThrough()

      res.stream.on('data', (chunk) => stream.write(chunk))
      res.stream.on('end', () => stream.end())
      res.stream.on('error', (error) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: error.message })

        resolve({
          status: 1,
          exception: {
            message: error.message,
            severity: 'fault',
            cause: 'Unknown'
          }
        })
      })

      resolve({
        stream
      })
    }
  })
}

async function loadTracks(identifier) {
  const ytSearch = config.search.sources.youtube ? identifier.startsWith('ytsearch:') : null
  const ytRegex = config.search.sources.youtube && !ytSearch ? /^(?:(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+))|(?:https?:\/\/)?(?:www\.)?youtu\.be\/[a-zA-Z0-9_-]{11})/.test(identifier) : null
  if (config.search.sources.youtube && (ytSearch || ytRegex))
    return ytSearch ? youtube.search(identifier.replace('ytsearch:', ''), 'youtube', true) : youtube.loadFrom(identifier, 'youtube')

  const ytMusicSearch = config.search.sources.youtube ? identifier.startsWith('ytmsearch:') : null
  const ytMusicRegex = config.search.sources.youtube && !ytMusicSearch ? /^(https?:\/\/)?(music\.)?youtube\.com\/(?:shorts\/(?:\?v=)?[a-zA-Z0-9_-]{11}|playlist\?list=[a-zA-Z0-9_-]+|watch\?(?=.*v=[a-zA-Z0-9_-]{11})[^\s]+)$/.test(identifier) : null
  if (config.search.sources.youtube && (ytMusicSearch || ytMusicRegex))
    return ytMusicSearch ? youtube.search(identifier.replace('ytmsearch:', ''), 'ytmusic', true) : youtube.loadFrom(identifier, 'ytmusic')

  const spSearch = config.search.sources.spotify.enabled ? identifier.startsWith('spsearch:') : null
  const spRegex = config.search.sources.spotify.enabled && !spSearch ? /^https?:\/\/(?:open\.spotify\.com\/|spotify:)(?:[^?]+)?(track|playlist|artist|episode|show|album)[/:]([A-Za-z0-9]+)/.exec(identifier) : null
  if (config.search.sources[config.search.defaultSearchSource] && (spSearch || spRegex))
    return spSearch ? spotify.search(identifier.replace('spsearch:', '')) : spotify.loadFrom(identifier, spRegex)

  const dzSearch = config.search.sources.deezer.enabled ? identifier.startsWith('dzsearch:') : null
  const dzRegex = config.search.sources.deezer.enabled && !dzSearch ? /^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(track|album|playlist)\/(\d+)$/.exec(identifier) : null
  if (config.search.sources.deezer.enabled && (dzSearch || dzRegex))
    return dzSearch ? deezer.search(identifier.replace('dzsearch:', ''), true) : deezer.loadFrom(identifier, dzRegex)

  const scSearch = config.search.sources.soundcloud.enabled ? identifier.startsWith('scsearch:') : null
  const scRegex = config.search.sources.soundcloud.enabled && !scSearch ? /^(https?:\/\/)?(www.)?(m\.)?soundcloud\.com\/[\w\-\.]+(\/)+[\w\-\.]+?$/.test(identifier) : null
  if (config.search.sources.soundcloud.enabled && (scSearch || scRegex))
    return scSearch ? soundcloud.search(identifier.replace('scsearch:', ''), true) : soundcloud.loadFrom(identifier)

  const bcSearch = config.search.sources.bandcamp ? identifier.startsWith('bcsearch:') : null
  const bcRegex = config.search.sources.bandcamp && !bcSearch ? /^https?:\/\/[\w-]+\.bandcamp\.com(\/(track|album)\/[\w-]+)?/.test(identifier) : null
  if (config.search.sources.bandcamp && (bcSearch || bcRegex))
    return bcSearch ? bandcamp.search(identifier.replace('bcsearch:', ''), true) : bandcamp.loadFrom(identifier)

  const pdSearch = config.search.sources.pandora ? identifier.startsWith('pdsearch:') : null
  const pdRegex = config.search.sources.pandora && !pdRegex ? /^https:\/\/www\.pandora\.com\/(?:playlist|station|podcast|artist)\/.+/.exec(identifier) : null
  if (config.search.sources.pandora && (pdSearch || pdRegex))
    return pdSearch ? pandora.search(identifier.replace('pdsearch:', '')) : pandora.loadFrom(identifier)

  if (config.search.sources.http && (identifier.startsWith('http://') || identifier.startsWith('https://')))
    return httpSource.loadFrom(identifier)

  if (config.search.sources.local && identifier.startsWith('local:'))
    return local.loadFrom(identifier.replace('local:', ''))

  return { loadType: 'empty', data: {} }
}

function loadLyrics(decodedTrack, language, fallback) {
  return new Promise(async (resolve) => {
    let captions = { loadType: 'empty', data: {} }

    switch (fallback ? config.search.lyricsFallbackSource : decodedTrack.sourceName) {
      case 'ytmusic':
      case 'youtube': {
        if (!config.search.sources[decodedTrack.sourceName]) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await youtube.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      case 'spotify': {
        if (!config.search.sources[config.search.defaultSearchSource] || !config.search.sources.spotify.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        if (config.search.sources.spotify.sp_dc === 'DISABLED')
          return resolve(loadLyrics(decodedTrack, language, true))

        captions = await spotify.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      case 'deezer': {
        if (!config.search.sources.deezer.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        if (config.search.sources.deezer.arl === 'DISABLED')
          return resolve(loadLyrics(decodedTrack, language, true))

        captions = await deezer.loadLyrics(decodedTrack, language) || captions

        if (captions.loadType === 'error')
          captions = await loadLyrics(decodedTrack, language, true)

        break
      }
      case 'genius': {
        if (!config.search.sources.genius.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await genius.loadLyrics(decodedTrack, language) || captions

        break
      }
      case 'musixmatch': {
        if (!config.search.sources.musixmatch.enabled) {
          debugLog('loadlyrics', 1, { params: parsedUrl.pathname, headers: req.headers, error: 'No possible search source found.' })

          break
        }

        captions = await musixmatch.loadLyrics(decodedTrack, language) || captions

        break
      }
      default: {
        captions = await loadLyrics(decodedTrack, language, true)
      }
    }

    resolve(captions)
  })
}

export default {
  getTrackURL,
  getTrackStream,
  loadTracks,
  loadLyrics,
  bandcamp,
  deezer,
  http: httpSource,
  local,
  pandora,
  soundcloud,
  spotify,
  youtube,
  genius,
  musixmatch
}
