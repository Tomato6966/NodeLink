import config from '../../config.js'
import constants from '../../constants.js'
import { debugLog, makeRequest, encodeTrack, randomLetters } from '../utils.js'

const ytContext = {
  ...(config.options.bypassAgeRestriction ? {
    thirdParty: {
      embedUrl: 'https://www.youtube.com'
    },
  } : {}),
  client: {
    clientName: config.options.bypassAgeRestriction ? 'TVHTML5_SIMPLY_EMBEDDED_PLAYER' : 'ANDROID',
    clientVersion: config.options.bypassAgeRestriction ? '2.0' : '19.04.33',
    ...(!config.options.bypassAgeRestriction ? {
      androidSdkVersion: '34',
      userAgent: 'com.google.android.youtube/19.04.33 (Linux; U; Android 14 gzip)'
    } : {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/111.0'
    }),
    screenDensityFloat: 1,
    screenHeightPoints: 1080,
    screenPixelDensity: 1,
    screenWidthPoints: 1920,
  }
}

const sourceInfo = {
  innertubeInterval: null,
  signatureTimestamp: null,
  functions: []
}

function _getBaseHostRequest(type) {
  if (ytContext.client.clientName.startsWith('ANDROID'))
    return 'youtubei.googleapis.com'

  return `${type === 'ytmusic' ? 'music' : 'www'}.youtube.com`
}

function _getBaseHost(type) {
  return `${type === 'ytmusic' ? 'music' : 'www'}.youtube.com`
}

function _switchClient(newClient) {
  if (newClient === 'ANDROID') {
    ytContext.client.clientName = 'ANDROID'
    ytContext.client.clientVersion = '19.04.33'
    ytContext.client.userAgent = 'com.google.android.youtube/19.04.33 (Linux; U; Android 14 gzip)'
  } else if (newClient === 'ANDROID_MUSIC') {
    ytContext.client.clientName = 'ANDROID_MUSIC'
    ytContext.client.clientVersion = '6.37.50'
    ytContext.client.userAgent = 'com.google.android.apps.youtube.music/6.37.50 (Linux; U; Android 14 gzip)'
  }
}

function _getSourceName(type) {
  return type === 'ytmusic' ? 'YouTube Music' : 'YouTube'
}

async function _init() {
  debugLog('youtube', 5, { type: 1, message: 'Fetching deciphering functions...' })
 
  const { body: data } = await makeRequest('https://www.youtube.com/embed', { method: 'GET' }).catch((err) => {
    debugLog('youtube', 5, { type: 2, message: `Failed to access YouTube website: ${err.message}` })
  })

  const { body: player } = await makeRequest(`https://www.youtube.com${/(?<=jsUrl":")[^"]+/.exec(data)[0]}`, { method: 'GET' }).catch((err) => {
    debugLog('youtube', 5, { type: 2, message: `Failed to fetch player.js: ${err.message}` })
  })

  sourceInfo.signatureTimestamp = /(?<=signatureTimestamp:)[0-9]+/.exec(player)[0]

  let functionName = player.match(/a.set\("alr","yes"\);c&&\(c=(.*?)\(/)[1]
  const decipherFunctionName = functionName

  const sigFunction = player.match(new RegExp(`${functionName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}=function\\(a\\){(.*)\\)};`, 'g'))[0]

  functionName = player.match(/a=a\.split\(""\);(.*?)\./)[1]
  const sigWrapper = player.match(new RegExp(`var ${functionName}={(.*?)};`, 's'))[1]

  sourceInfo.functions[0] = `const ${functionName}={${sigWrapper}};const ${sigFunction}${decipherFunctionName}(sig);`

  functionName = player.match(/&&\(b=a\.get\("n"\)\)&&\(b=(.*?)\(/)[1]

  if (functionName && functionName.includes('['))
    functionName = player.match(new RegExp(`${functionName.match(/([^[]*)\[/)[1]}=\\[(.*?)]`))[1]
  
  const ncodeFunction = player.match(new RegExp(`${functionName}=function(.*?)};`, 's'))[1]
  sourceInfo.functions[1] = `const ${functionName} = function${ncodeFunction}};${functionName}(ncode)`

  debugLog('youtube', 5, { type: 1, message: 'Successfully fetched deciphering functions.' })
}

async function init() {
  debugLog('youtube', 5, { type: 1, message: 'Unrecommended option "bypass age-restricted" is enabled.' })

  await _init()

  sourceInfo.innertubeInterval = setInterval(async () => _init(), 3600000)
}

function free() {
  clearInterval(sourceInfo.innertubeInterval)
  sourceInfo.innertubeInterval = null

  sourceInfo.signatureTimestamp = null
  sourceInfo.functions = []
}

function checkURLType(url, type) {
  if (type === 'ytmusic') {
    const videoRegex = /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+/
    const playlistRegex = /^https?:\/\/music\.youtube\.com\/playlist\?list=[\w-]+/
    const selectedVideoRegex = /^https?:\/\/music\.youtube\.com\/watch\?v=[\w-]+&list=[\w-]+/
    
    if (selectedVideoRegex.test(url) || playlistRegex.test(url)) return constants.YouTube.playlist
    else if (videoRegex.test(url)) return constants.YouTube.video
    else return -1
  } else {
    const videoRegex = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=[\w-]+)|youtu\.be\/[\w-]+)/
    const playlistRegex = /^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=[\w-]+/
    const selectedVideoRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+&list=[\w-]+/
    const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/
  
    if (selectedVideoRegex.test(url) || playlistRegex.test(url)) return constants.YouTube.playlist
    else if (shortsRegex.test(url)) return constants.YouTube.shorts
    else if (videoRegex.test(url)) return constants.YouTube.video
    else return -1
  }
}

async function search(query, type, shouldLog) {
  if (shouldLog) debugLog('search', 4, { type: 1, sourceName: _getSourceName(type), query })

  if (!config.options.bypassAgeRestriction)
    _switchClient(type === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')

  const { body: search } = await makeRequest(`https://${_getBaseHostRequest(type)}/youtubei/v1/search`, {
    headers: {
      'User-Agent': ytContext.client.userAgent,
      ...(config.search.sources.youtube.authentication.enabled ? {
        Authorization: config.search.sources.youtube.authentication.authorization,
        Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
      } : {})
    },
    body: {
      context: ytContext,
      query,
      params: 'EgIQAQ%3D%3D'
    },
    method: 'POST',
    disableBodyCompression: true
  })

  if (typeof search !== 'object') {
    debugLog('search', 4, { type: 3, sourceName: _getSourceName(type), query, message: 'Failed to load results.' })

    return {
      loadType: 'error',
      data: {
        message: 'Failed to load results.',
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  if (search.error) {
    debugLog('search', 4, { type: 3, sourceName: _getSourceName(type), query, message: search.error.message })

    return {
      loadType: 'error',
      data: {
        message: search.error.message,
        severity: 'fault',
        cause: 'Unknown'
      }
    }
  }

  const tracks = []

  let videos = search.contents.sectionListRenderer.contents[search.contents.sectionListRenderer.contents.length - 1].itemSectionRenderer.contents

  if (videos.length > config.options.maxSearchResults)
    videos = videos.slice(0, config.options.maxSearchResults)

  videos.forEach((video) => {
    video = video.compactVideoRenderer

    if (video) {
      const track = {
        identifier: video.videoId,
        isSeekable: true,
        author: video.longBylineText.runs[0].text,
        length: video.lengthText ? (parseInt(video.lengthText.runs[0].text.split(':')[0]) * 60 + parseInt(video.lengthText.runs[0].text.split(':')[1])) * 1000 : 0,
        isStream: video.lengthText ? false : true,
        position: 0,
        title: video.title.runs[0].text,
        uri: `https://${_getBaseHost(type)}/watch?v=${video.videoId}`,
        artworkUrl: `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
        isrc: null,
        sourceName: type
      }

      tracks.push({
        encoded: encodeTrack(track),
        info: track,
        pluginInfo: {}
      })
    }
  })

  if (tracks.length === 0) {
    debugLog('search', 4, { type: 3, sourceName: _getSourceName(type), query, message: 'No matches found.' })

    return {
      loadType: 'empty',
      data: {}
    }
  }

  if (shouldLog)
    debugLog('search', 4, { type: 2, sourceName: _getSourceName(type), tracksLen: tracks.length, query })

  return {
    loadType: 'search',
    data: tracks
  }
}

async function loadFrom(query, type) {
  if (!config.options.bypassAgeRestriction)
    _switchClient(type === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')

  switch (checkURLType(query, type)) {
    case constants.YouTube.video: {
      debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: _getSourceName(type), query })
      
      const identifier = (/v=([^&]+)/.exec(query) || /youtu\.be\/([^?]+)/.exec(query))[1]

      const { body: video } = await makeRequest(`https://${_getBaseHostRequest(type)}/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
        headers: {
          'User-Agent': ytContext.client.userAgent,
          ...(config.search.sources.youtube.authentication.enabled ? {
            Authorization: config.search.sources.youtube.authentication.authorization,
            Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
          } : {})
        },
        body: {
          context: ytContext,
          videoId: identifier,
          contentCheckOk: true,
          racyCheckOk: true,
          params: 'CgIQBg'
        },
        method: 'POST'
      })

      if (video.playabilityStatus.status !== 'OK') {
        const errorMessage = video.playabilityStatus.reason || video.playabilityStatus.messages[0]

        debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: _getSourceName(type), query, message: errorMessage })
        
        return {
          loadType: 'error',
          data: {
            message: errorMessage,
            severity: 'common',
            cause: 'Unknown'
          }
        }
      }

      const track = {
        identifier: video.videoDetails.videoId,
        isSeekable: true,
        author: video.videoDetails.author,
        length: parseInt(video.videoDetails.lengthSeconds) * 1000,
        isStream: video.videoDetails.isLiveContent,
        position: 0,
        title: video.videoDetails.title,
        uri: `https://${_getBaseHost(type)}/watch?v=${video.videoDetails.videoId}`,
        artworkUrl: `https://i.ytimg.com/vi/${video.videoDetails.videoId}/maxresdefault.jpg`,
        isrc: null,
        sourceName: type
      }

      debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: _getSourceName(type), track, query })

      return {
        loadType: 'track',
        data: {
          encoded: encodeTrack(track),
          info: track,
          pluginInfo: {}
        }
      }
    }
    case constants.YouTube.playlist: {
      debugLog('loadtracks', 4, { type: 1, loadType: 'playlist', sourceName: _getSourceName(type), query })

      let identifier = /v=([^&]+)/.exec(query)
      if (identifier) identifier = identifier[1]

      const { body: playlist } = await makeRequest(`https://${_getBaseHostRequest(type)}/youtubei/v1/next?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
        headers: {
          'User-Agent': ytContext.client.userAgent,
          ...(config.search.sources.youtube.authentication.enabled ? {
            Authorization: config.search.sources.youtube.authentication.authorization,
            Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
          } : {})
        },
        body: {
          context: ytContext,
          playlistId: /(?<=list=)[\w-]+/.exec(query)[0],
          contentCheckOk: true,
          racyCheckOk: true,
          params: 'CgIQBg'
        },
        method: 'POST'
      })

      let contentsRoot = null
      
      if (config.options.bypassAgeRestriction) contentsRoot = playlist.contents.singleColumnWatchNextResults.playlist
      else contentsRoot = type === 'ytmusic' ? playlist.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer : playlist.contents.singleColumnWatchNextResults

      if (!(type === 'ytmusic' && !config.options.bypassAgeRestriction ? contentsRoot.content : contentsRoot)) {
        debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: _getSourceName(type), query, message: 'No matches found.' })
      
        return {
          loadType: 'empty',
          data: {}
        }
      }
    
      const tracks = []
      let selectedTrack = 0

      let playlistContent = null
      
      if (config.options.bypassAgeRestriction) playlistContent = contentsRoot.playlist.contents
      else playlistContent = type === 'ytmusic' ? contentsRoot.content.playlistPanelRenderer.contents : contentsRoot.playlist.playlist.contents

      if (playlistContent.length > config.options.maxAlbumPlaylistLength)
        playlistContent = playlistContent.slice(0, config.options.maxAlbumPlaylistLength)

      playlistContent.forEach((video, i) => {
        video = video.playlistPanelVideoRenderer

        if (video) {
          const track = {
            identifier: video.videoId,
            isSeekable: true,
            author: video.shortBylineText.runs ? video.shortBylineText.runs[0].text : 'Unknown author',
            length: video.lengthText ? (parseInt(video.lengthText.runs[0].text.split(':')[0]) * 60 + parseInt(video.lengthText.runs[0].text.split(':')[1])) * 1000 : 0,
            isStream: false,
            position: 0,
            title: video.title.runs[0].text,
            uri: `https://${_getBaseHost(type)}/watch?v=${video.videoId}`,
            artworkUrl: `https://i.ytimg.com/vi/${video.videoId}/maxresdefault.jpg`,
            isrc: null,
            sourceName: 'youtube'
          }

          tracks.push({
            encoded: encodeTrack(track),
            info: track,
            pluginInfo: {}
          })

          if (identifier && track.identifier === identifier)
            selectedTrack = i
        }
      })

      if (tracks.length === 0) {
        debugLog('loadtracks', 4, { type: 3, loadType: 'playlist', sourceName: _getSourceName(type), query, message: 'No matches found.' })

        return {
          loadType: 'empty',
          data: {}
        }
      }

      let playlistName = null
      
      if (config.options.bypassAgeRestriction) playlistName = contentsRoot.playlist.title
      else playlistName = type === 'ytmusic' ? contentsRoot.header.musicQueueHeaderRenderer.subtitle.runs[0].text : contentsRoot.playlist.playlist.title

      debugLog('loadtracks', 4, { type: 2, loadType: 'playlist', sourceName: _getSourceName(type), playlistName: playlistName })

      return {
        loadType: 'playlist',
        data: {
          info: {
            name: playlistName,
            selectedTrack: selectedTrack
          },
          pluginInfo: {},
          tracks
        }
      }
    }
    case constants.YouTube.shorts: {
      debugLog('loadtracks', 4, { type: 1, loadType: 'track', sourceName: 'YouTube Shorts', query })

      const { body: short } = await makeRequest(`https://${_getBaseHostRequest(type)}/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
        headers: {
          'User-Agent': ytContext.client.userAgent,
          ...(config.search.sources.youtube.authentication.enabled ? {
            Authorization: config.search.sources.youtube.authentication.authorization,
            Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
          } : {})
        },
        body: {
          context: ytContext,
          videoId: /shorts\/([a-zA-Z0-9_-]+)/.exec(query)[1],
          contentCheckOk: true,
          racyCheckOk: true,
          params: 'CgIQBg'
        },
        method: 'POST'
      })

      if (short.playabilityStatus.status !== 'OK') {
        const errorMessage = short.playabilityStatus.reason || short.playabilityStatus.messages[0]

        debugLog('loadtracks', 4, { type: 3, loadType: 'track', sourceName: 'YouTube Shorts', query, message: errorMessage })

        return {
          loadType: 'error',
          data: { message: errorMessage,
            severity: 'common',
            cause: 'Unknown'
          }
        }
      }

      const track = {
        identifier: short.videoDetails.videoId,
        isSeekable: true,
        author: short.videoDetails.author,
        length: parseInt(short.videoDetails.lengthSeconds) * 1000,
        isStream: false,
        position: 0,
        title: short.videoDetails.title,
        uri: `https://${_getBaseHost(type)}/watch?v=${short.videoDetails.videoId}`,
        artworkUrl: `https://i.ytimg.com/vi/${short.videoDetails.videoId}/maxresdefault.jpg`,
        isrc: null,
        sourceName: 'youtube'
      }

      debugLog('loadtracks', 4, { type: 2, loadType: 'track', sourceName: 'YouTube Shorts', track, query })

      return {
        loadType: 'short',
        data: {
          encoded: encodeTrack(track),
          info: track,
          pluginInfo: {}
        }
      }
    }
    default: {
      debugLog('loadtracks', 4, { type: 3, loadType: 'unknown', sourceName: _getSourceName(type), query, message: 'No matches found.' })

      return {
        loadType: 'empty',
        data: {}
      }
    }
  }
}

async function retrieveStream(identifier, type, title) {
  if (!config.options.bypassAgeRestriction)
    _switchClient(type === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')

  const { body: videos } = await makeRequest(`https://${_getBaseHostRequest(type)}/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false&t=${randomLetters(12)}&id=${identifier}`, {
    headers: {
      'User-Agent': ytContext.client.userAgent,
      ...(config.search.sources.youtube.authentication.enabled ? {
        Authorization: config.search.sources.youtube.authentication.authorization,
        Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
      } : {})
    },
    body: {
      context: ytContext,
      cpn: randomLetters(16),
      ...(config.options.bypassAgeRestriction ? {
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: sourceInfo.signatureTimestamp
          }
        }
      } : {}),
      videoId: identifier,
      contentCheckOk: true,
      racyCheckOk: true,
      params: 'CgIQBg'
    },
    method: 'POST',
    disableBodyCompression: true
  })

  if (videos.playabilityStatus.status !== 'OK') {
    debugLog('retrieveStream', 4, { type: 2, sourceName: _getSourceName(type), query: title, message: videos.playabilityStatus.reason })

    return {
      exception: {
        message: videos.playabilityStatus.reason,
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  let itag = null
  switch (config.audio.quality) {
    case 'high': itag = 251; break
    case 'medium': itag = 250; break
    case 'low': itag = 249; break
    case 'lowest': itag = 599; break
    default: itag = 251; break
  }

  const audio = videos.streamingData.adaptiveFormats.find((format) => format.itag === itag) || videos.streamingData.adaptiveFormats.find((format) => format.mimeType.startsWith('audio/'))
  let url = audio.url || audio.signatureCipher || audio.cipher

  if (config.options.bypassAgeRestriction) { /* ANDROID client won't ask for deciphering */
    const args = new URLSearchParams(url)
    url = decodeURIComponent(args.get('url'))

    if (audio.signatureCipher || audio.cipher)
      url += `&${args.get('sp')}=${eval(`const sig = "${args.get('s')}";` + sourceInfo.functions[0])}`
  } else {
    url = decodeURIComponent(url)
  }

  url += `&rn=1&cpn=${randomLetters(16)}&ratebypass=yes&range=0-` /* range query is necessary to bypass throttling */

  return {
    url,
    protocol: 'https',
    format: audio.mimeType === 'audio/webm; codecs="opus"' ? 'webm/opus' : 'arbitrary'
  }
}

async function loadLyrics(decodedTrack, language) {
  if (!config.options.bypassAgeRestriction)
    _switchClient(decodedTrack.sourceName === 'ytmusic' ? 'ANDROID_MUSIC' : 'ANDROID')

  const { body: video } = await makeRequest(`https://${_getBaseHostRequest(decodedTrack.sourceName)}/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false`, {
    headers: {
      'User-Agent': ytContext.client.userAgent,
      ...(config.search.sources.youtube.authentication.enabled ? {
        Authorization: config.search.sources.youtube.authentication.authorization,
        Cookie: `SID=${config.search.sources.youtube.authentication.cookies.SID}; LOGIN_INFO=${config.search.sources.youtube.authentication.cookies.LOGIN_INFO}`
      } : {})
    },
    body: {
      context: ytContext,
      videoId: decodedTrack.identifier,
      contentCheckOk: true,
      racyCheckOk: true,
      params: 'CgIQBg'
    },
    method: 'POST'
  })

  if (video.playabilityStatus.status !== 'OK') {
    debugLog('loadlyrics', 4, { type: 2, sourceName: _getSourceName(decodedTrack.sourceName), track: { title: decodedTrack.title, author: decodedTrack.author }, message: video.playabilityStatus.reason })

    return {
      loadType: 'error',
      data: {
        message: video.playabilityStatus.reason,
        severity: 'common',
        cause: 'Unknown'
      }
    }
  }

  if (!video.captions)
    return null

  const selectedCaption = video.captions.playerCaptionsTracklistRenderer.captionTracks.find((caption) => {
    return caption.languageCode === language
  })

  if (selectedCaption) {
    const { body: captionData } = await makeRequest(selectedCaption.baseUrl.replace('&fmt=srv3', '&fmt=json3'), { method: 'GET' }).catch((err) => {
      debugLog('loadlyrics', 4, { type: 2, sourceName: _getSourceName(decodedTrack.sourceName), track: { title: decodedTrack.title, author: decodedTrack.author }, message: err.message })

      return {
        loadType: 'error',
        data: {
          message: err.message,
          severity: 'common',
          cause: 'Unknown'
        }
      }
    })

    const captionEvents = []
    captionData.events.forEach((event) => {
      if (!event.segs) return null

      captionEvents.push({
        startTime: event.tStartMs,
        endTime: event.tStartMs + (event.dDurationMs || 0),
        text: event.segs ? event.segs.map((seg) => seg.utf8).join('') : null
      })
    })

    return {
      loadType: 'lyricsSingle',
      data: {
        name: selectedCaption.languageCode,
        synced: true,
        data: captionEvents,
        rtl: !!selectedCaption.rtl
      }
    }
  } else {
    const captions = []
    let i = 0

    if (!video.captions)
      return null

    video.captions.playerCaptionsTracklistRenderer.captionTracks.forEach(async (caption) => {
      const { body: captionData } = await makeRequest(caption.baseUrl.replace('&fmt=srv3', '&fmt=json3'), { method: 'GET' }).catch((err) => {
        debugLog('loadlyrics', 4, { type: 2, sourceName: _getSourceName(decodedTrack.sourceName), track: { title: decodedTrack.title, author: decodedTrack.author }, message: err.message })

        return {
          loadType: 'error',
          data: {
            message: err.message,
            severity: 'common',
            cause: 'Unknown'
          }
        }
      })

      const captionEvents = captionData.events.map((event) => {
        return {
          startTime: event.tStartMs,
          endTime: event.tStartMs + event.dDurationMs,
          text: event.segs ? event.segs.map((seg) => seg.utf8).join('') : null
        }
      })

      captions.push({
        name: caption.languageCode,
        synced: true,
        data: captionEvents,
        rtl: !!caption.rtl
      })

      if (i === video.captions.playerCaptionsTracklistRenderer.captionTracks.length - 1) {
        if (captions.length === 0) {
          debugLog('loadlyrics', 4, { type: 3, sourceName: _getSourceName(decodedTrack.sourceName), track: { title: decodedTrack.title, author: decodedTrack.author }, message: 'No captions found.' })

          return null
        }

        debugLog('loadlyrics', 4, { type: 2, sourceName: _getSourceName(decodedTrack.sourceName), track: { title: decodedTrack.title, author: decodedTrack.author } })

        return {
          loadType: 'lyricsMultiple',
          data: captions
        }
      }
    })
  }
}

export default {
  init,
  free,
  search,
  loadFrom,
  retrieveStream,
  loadLyrics
}