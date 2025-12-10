import { encodeTrack, logger, makeRequest } from '../../utils.js'

export const YOUTUBE_CONSTANTS = {
  VIDEO: 0,
  PLAYLIST: 1,
  SHORTS: 2,
  UNKNOWN: -1
}

const FALLBACK_TITLE = 'Unknown Title'
const FALLBACK_AUTHOR = 'Unknown Artist'
const FALLBACK_CHANNEL = 'Unknown Channel'

const RE_YT_VIDEO =
  /^https?:\/\/(?:www\.|music\.)?youtube\.com\/watch\?v=[\w-]+/
const RE_YT_PLAYLIST =
  /^https?:\/\/(?:www\.|music\.)?youtube\.com\/playlist\?list=[\w-]+/
const RE_YT_SHORT_URL = /^https?:\/\/youtu\.be\/[\w-]+/
const RE_YT_SHORTS = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/
const RE_URL_CAPTURE = /(https?:\/\/[^\s]+)/gi
const RE_DURATION = /[:\d]+/
const RE_CODECS = /codecs="([^"]+)"/
const RE_ID_EXTRACT = /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/
const RE_PLAYLIST_ID = /[?&]list=([\w-]+)/
const RE_VIDEO_IN_PLAYLIST = /[?&]v=([\w-]+)/
const RE_TIME_PARTS = {
  year: /(\d+)\s*year/,
  month: /(\d+)\s*month/,
  week: /(\d+)\s*week/,
  day: /(\d+)\s*day/,
  hour: /(\d+)\s*hour/,
  minute: /(\d+)\s*minute/,
  second: /(\d+)\s*second/
}
const RE_SUBSCRIBERS = /([\d.,]+)\s*([kmb])?/i
const RE_VIDEO_COUNT = /(\d+(?:,\d+)*)\s*video/i
const RE_SPOTIFY_ID =
  /spotify\.com\/(album|track|artist|playlist)\/([a-zA-Z0-9]+)/

const _utils = {
  safeString(value, fallback = '') {
    if (value === null || value === undefined) return fallback
    return String(value)
  },

  formatDuration(ms) {
    if (!ms || ms === 0) return { ms: 0, formatted: '🔴 LIVE', hms: '🔴 LIVE' }
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const s = seconds % 60
    const m = minutes % 60
    const formatted =
      hours > 0
        ? `${hours}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`
    const hms = `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    return { ms, formatted, hms }
  },

  formatNumber(num) {
    if (!num || isNaN(num)) return '0'
    if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`
    if (num >= 1000000) return `${(num / 1000000000).toFixed(1)}M`
    if (num >= 1000) return `${(num / 1000000).toFixed(1)}K`
    return String(num)
  },

  parsePublishedAt(publishedText) {
    if (!publishedText) return null

    const date = new Date(publishedText)
    if (!isNaN(date.getTime())) {
      const timestamp = date.getTime()
      const now = Date.now()
      const diffMs = now - timestamp
      const years = Math.floor(diffMs / 31557600000)
      const months = Math.floor((diffMs % 31557600000) / 2629746000)
      const weeks = Math.floor((diffMs % 2629746000) / 604800000)
      const days = Math.floor((diffMs % 604800000) / 86400000)
      const hours = Math.floor((diffMs % 86400000) / 3600000)
      const minutes = Math.floor((diffMs % 3600000) / 60000)
      const seconds = Math.floor((diffMs % 60000) / 1000)

      const parts = []
      if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`)
      if (months > 0) parts.push(`${months} month${months > 1 ? 's' : ''}`)
      if (weeks > 0) parts.push(`${weeks} week${weeks > 1 ? 's' : ''}`)
      if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`)

      const readable = parts.length > 0 ? parts.join(' ') + ' ago' : 'just now'
      return {
        original: publishedText,
        timestamp: Math.floor(timestamp),
        date: date.toISOString(),
        readable
      }
    }

    const text = publishedText.toLowerCase()
    let years = 0,
      months = 0,
      weeks = 0,
      days = 0,
      hours = 0,
      minutes = 0,
      seconds = 0

    const ym = text.match(RE_TIME_PARTS.year)
    if (ym) years = parseInt(ym[1], 10)
    const mm = text.match(RE_TIME_PARTS.month)
    if (mm) months = parseInt(mm[1], 10)
    const wm = text.match(RE_TIME_PARTS.week)
    if (wm) weeks = parseInt(wm[1], 10)
    const dm = text.match(RE_TIME_PARTS.day)
    if (dm) days = parseInt(dm[1], 10)
    const hm = text.match(RE_TIME_PARTS.hour)
    if (hm) hours = parseInt(hm[1], 10)
    const minm = text.match(RE_TIME_PARTS.minute)
    if (minm) minutes = parseInt(minm[1], 10)
    const sm = text.match(RE_TIME_PARTS.second)
    if (sm) seconds = parseInt(sm[1], 10)

    const now = Date.now()
    const msAgo =
      years * 31557600000 +
      months * 2629746000 +
      weeks * 604800000 +
      days * 86400000 +
      hours * 3600000 +
      minutes * 60000 +
      seconds * 1000
    const timestamp = now - msAgo

    return {
      original: publishedText,
      timestamp: Math.floor(timestamp),
      date: new Date(timestamp).toISOString(),
      readable: publishedText
    }
  },

  getRunsText(runsArray) {
    if (Array.isArray(runsArray) && runsArray.length > 0) {
      return runsArray.map((run) => run.text || '').join('')
    }
    return null
  },

  getItemValue(obj, paths, defaultValue = null) {
    if (!obj) return defaultValue
    for (const path of paths) {
      const value = path.split('.').reduce((o, k) => o?.[k], obj)
      if (value !== undefined && value !== null) return value
    }
    return defaultValue
  }
}

async function fetchOEmbedMetadata(videoId) {
  try {
    // fiquei 6 horas fazendo esse codigo, dai lembrei dps de 5 horas debuggando q o oembed existe. o problema ta entre o monitor e a cadeira.
    const { body, statusCode } = await makeRequest(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { method: 'GET', timeout: 5000 }
    )

    if (statusCode === 200 && body) {
      return {
        title: body.title || null,
        author: body.author_name || null,
        thumbnail_url: body.thumbnail_url || null
      }
    }
  } catch (e) {
    logger('debug', 'fetchOEmbedMetadata', `OEmbed fetch failed: ${e.message}`)
  }
  return null
}

function extractThumbnail(renderer, videoId) {
  const thumbnails =
    renderer?.thumbnail?.thumbnails ||
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails

  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    return thumbnails[thumbnails.length - 1]?.url?.split('?')[0] || null
  }
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null
}

async function fetchChannelInfo(channelId, context) {
  if (!channelId) return null

  try {
    const { body: channelResponse, statusCode } = await makeRequest(
      'https://www.youtube.com/youtubei/v1/browse',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20251030.01.00',
              hl: context?.client?.hl || 'en',
              gl: context?.client?.gl || 'US'
            }
          },
          browseId: channelId
        },
        disableBodyCompression: true
      }
    )

    if (statusCode !== 200 || !channelResponse) return null

    const header =
      channelResponse.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
    if (!header) return null

    const channelInfo = {
      icon: null,
      banner: null,
      subscribers: null,
      verified: false,
      description: null,
      links: []
    }

    const avatarSources =
      header.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image
        ?.sources
    channelInfo.icon = avatarSources?.at(-1)?.url?.split('=')[0] || null

    const bannerSources = header.banner?.imageBannerViewModel?.image?.sources
    channelInfo.banner = bannerSources?.at(-1)?.url?.split('=')[0] || null

    const label =
      header.title?.dynamicTextViewModel?.rendererContext?.accessibilityContext
        ?.label
    channelInfo.verified = label?.includes('Verified') || false

    // Metadata Rows
    const metadataRows = header.metadata?.contentMetadataViewModel?.metadataRows
    if (Array.isArray(metadataRows)) {
      for (const row of metadataRows) {
        if (!row.metadataParts) continue
        for (const part of row.metadataParts) {
          const text = part.text?.content || part.text
          if (typeof text !== 'string') continue
          const lowerText = text.toLowerCase()

          if (lowerText.includes('subscriber')) {
            const numStrMatch = lowerText.match(RE_SUBSCRIBERS)
            if (numStrMatch) {
              let count = parseFloat(numStrMatch[1].replace(/,/g, ''))
              const multiplier = numStrMatch[2]?.toLowerCase()
              if (multiplier === 'k') count *= 1000
              else if (multiplier === 'm') count *= 1000000
              else if (multiplier === 'b') count *= 1000000000
              channelInfo.subscribers = {
                original: text,
                count: Math.floor(count),
                formatted: _utils.formatNumber(Math.floor(count))
              }
            } else {
              channelInfo.subscribers = {
                original: text,
                count: null,
                formatted: text
              }
            }
          } else if (lowerText.includes('video')) {
            const match = lowerText.match(RE_VIDEO_COUNT)
            if (match) {
              const count = parseInt(match[1].replace(/,/g, ''), 10)
              channelInfo.videoCount = {
                original: text,
                count,
                formatted: _utils.formatNumber(count)
              }
            }
          }
        }
      }
    }

    channelInfo.description =
      header.description?.descriptionPreviewViewModel?.description?.content ||
      null
    const mainLink = header.attribution?.attributionViewModel?.text?.content
    if (mainLink && !mainLink.includes('and') && !mainLink.includes('more')) {
      channelInfo.links.push(mainLink)
    }

    // Featured Video
    const contents =
      channelResponse.contents?.singleColumnBrowseResultsRenderer?.tabs
    if (Array.isArray(contents)) {
      searchLoop: for (const tab of contents) {
        const sections = tab.tabRenderer?.content?.sectionListRenderer?.contents
        if (!sections) continue
        for (const section of sections) {
          const items = section.itemSectionRenderer?.contents
          if (!items) continue
          for (const item of items) {
            const cvp = item.channelVideoPlayerRenderer
            if (cvp?.videoId) {
              channelInfo.featuredVideo = {
                id: cvp.videoId,
                url: `https://www.youtube.com/watch?v=${cvp.videoId}`,
                title: cvp.title?.runs?.[0]?.text || null,
                description: cvp.description?.runs?.[0]?.text || null
              }
              break searchLoop
            }
          }
        }
      }
    }

    return channelInfo
  } catch (e) {
    logger('error', 'fetchChannelInfo', e.message)
    return null
  }
}

async function resolveExternalLinks(externalLinks) {
  if (!externalLinks) return null
  const resolved = { ...externalLinks }

  const resolveUrl = async (key, checkStr) => {
    if (
      resolved[key] &&
      (resolved[key].includes('smarturl.it') ||
        resolved[key].includes(checkStr))
    ) {
      try {
        const response = await makeRequest(resolved[key], {
          method: 'GET',
          followRedirects: true,
          maxRedirects: 5
        })
        if (response.finalUrl) {
          if (
            key === 'spotify' &&
            response.finalUrl.includes('googleusercontent.com/spotify.com')
          ) {
            resolved.spotify = response.finalUrl
            const match = response.finalUrl.match(RE_SPOTIFY_ID)
            if (match) resolved.spotifyId = { type: match[1], id: match[2] }
          } else if (
            key === 'appleMusic' &&
            response.finalUrl.includes('music.apple.com')
          ) {
            resolved.appleMusic = response.finalUrl
          }
        }
      } catch (e) {
        /* ignore */
      }
    }
  }

  await Promise.all([
    resolveUrl('spotify', 'ffm.to'),
    resolveUrl('appleMusic', 'apple')
  ])

  return resolved
}

function extractExternalLinks(description) {
  if (!description) return null

  const links = {
    spotify: null,
    appleMusic: null,
    soundcloud: null,
    bandcamp: null,
    deezer: null,
    tidal: null,
    amazonMusic: null,
    youtubeMusic: null,
    website: null,
    other: []
  }

  const matches = description.match(RE_URL_CAPTURE) || []
  const linkMatchers = [
    {
      key: 'spotify',
      patterns: ['googleusercontent.com/spotify.com', 'spotify.com']
    },
    {
      key: 'appleMusic',
      patterns: ['apple.com', 'itunes.apple.com', 'music.apple.com']
    },
    { key: 'soundcloud', patterns: ['soundcloud.com'] },
    { key: 'bandcamp', patterns: ['bandcamp.com'] },
    { key: 'deezer', patterns: ['deezer.com'] },
    { key: 'tidal', patterns: ['tidal.com'] },
    { key: 'amazonMusic', patterns: ['amazon.com/music', 'music.amazon'] },
    { key: 'youtubeMusic', patterns: ['music.youtube.com'] }
  ]

  for (let url of matches) {
    url = url.replace(/[,;)]$/, '')
    let matched = false

    for (const matcher of linkMatchers) {
      if (matcher.patterns.some((pattern) => url.includes(pattern))) {
        links[matcher.key] = url
        matched = true
        break
      }
    }

    if (!matched && !url.includes('youtube.com') && !url.includes('youtu.be')) {
      if (!links.website && /\.(com|net|org|io)/.test(url)) {
        links.website = url
      } else {
        links.other.push(url)
      }
    }
  }

  if (links.other.length === 0) delete links.other
  const hasLinks = Object.values(links).some(
    (v) => v !== null && (!Array.isArray(v) || v.length > 0)
  )
  return hasLinks ? links : null
}

function extractVideoQualities(streamingData) {
  if (!streamingData) return []
  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || [])
  ]
  const qualityMap = new Map()

  for (const format of allFormats) {
    if (
      format.qualityLabel &&
      format.bitrate &&
      format.mimeType?.startsWith('video/')
    ) {
      const quality = format.qualityLabel
      if (
        !qualityMap.has(quality) ||
        format.bitrate > qualityMap.get(quality).bitrate
      ) {
        const codecMatch = format.mimeType.match(RE_CODECS)
        qualityMap.set(quality, {
          quality,
          bitrate: format.bitrate,
          fps: format.fps || null,
          mimeType: format.mimeType || null,
          width: format.width || null,
          height: format.height || null,
          codec: codecMatch ? codecMatch[1].split('.')[0] : 'unknown',
          itag: format.itag,
          container: format.mimeType?.split(';')[0]?.split('/')[1] || null,
          averageBitrate: format.averageBitrate || null,
          contentLength: format.contentLength || null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort(
    (a, b) => (parseInt(a.quality) || 0) - (parseInt(b.quality) || 0)
  )
}

function extractAudioFormats(streamingData) {
  if (!streamingData) return []
  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || [])
  ]
  const qualityMap = new Map()

  for (const format of allFormats) {
    if (format.mimeType?.startsWith('audio/') && format.bitrate) {
      const audioQuality = format.audioQuality || 'UNKNOWN'
      if (
        !qualityMap.has(audioQuality) ||
        format.bitrate > qualityMap.get(audioQuality).bitrate
      ) {
        const codecMatch = format.mimeType.match(RE_CODECS)
        qualityMap.set(audioQuality, {
          itag: format.itag,
          mimeType: format.mimeType,
          bitrate: format.bitrate,
          averageBitrate: format.averageBitrate || null,
          audioQuality: format.audioQuality || null,
          audioSampleRate: format.audioSampleRate || null,
          audioChannels: format.audioChannels || null,
          codec: codecMatch ? codecMatch[1] : 'unknown',
          container: format.mimeType?.split(';')[0]?.split('/')[1] || null,
          contentLength: format.contentLength || null,
          loudnessDb: format.loudnessDb || null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort((a, b) => b.bitrate - a.bitrate)
}

function parseLengthAndStream(lengthText, lengthSeconds, isLive) {
  if (isLive) return { lengthMs: -1, isStream: true }
  let lengthMs = 0
  let isStream = true

  if (lengthText && RE_DURATION.test(lengthText)) {
    const parts = lengthText.split(':').map(Number)
    lengthMs = parts.reduce((acc, val) => acc * 60 + val, 0) * 1000
    isStream = !Number.isFinite(lengthMs) || lengthMs <= 0
  } else if (lengthSeconds) {
    lengthMs = parseInt(lengthSeconds, 10) * 1000
    isStream = false
  }
  return { lengthMs, isStream }
}

function getRendererFromItemData(itemData, itemType) {
  if (!itemData) return null
  if (itemType === 'ytmusic') {
    return _utils.getItemValue(itemData, [
      'musicResponsiveListItemRenderer',
      'playlistPanelVideoRenderer',
      'musicTwoColumnItemRenderer'
    ])
  }
  return (
    _utils.getItemValue(itemData, [
      'videoRenderer',
      'compactVideoRenderer',
      'playlistPanelVideoRenderer',
      'gridVideoRenderer'
    ]) || (itemData.videoId ? itemData : null)
  )
}

export async function buildTrack(
  itemData,
  itemType,
  sourceNameOverride = null,
  fullApiResponse = null,
  enableHolo = false,
  config = {}
) {
  if (!itemData) return null

  const renderer = getRendererFromItemData(itemData, itemType)
  const videoId =
    _utils.getItemValue(renderer, [
      'playlistItemData.videoId',
      'navigationEndpoint.watchEndpoint.videoId',
      'videoId'
    ]) ||
    itemData.videoId ||
    renderer?.videoId

  if (!videoId) return null

  let title = FALLBACK_TITLE
  let author = FALLBACK_AUTHOR
  let lengthMs = 0
  let isStream = true
  let artworkUrl = null
  let uri = ''

  if (itemType === 'ytmusic') {
    title = _utils.safeString(
      _utils.getRunsText(_utils.getItemValue(renderer, ['title.runs'])),
      FALLBACK_TITLE
    )
    const subtitleRuns = _utils.getItemValue(renderer, ['subtitle.runs'])
    if (Array.isArray(subtitleRuns) && subtitleRuns.length > 0) {
      author = _utils.safeString(subtitleRuns[0]?.text, FALLBACK_AUTHOR)
    }

    let lengthText = null
    if (Array.isArray(subtitleRuns)) {
      const lengthRun = subtitleRuns.find(
        (run) => run.text && /^\d{1,2}:\d{2}(:\d{2})?$/.test(run.text)
      )
      lengthText = lengthRun?.text
    }
    const parsed = parseLengthAndStream(
      lengthText,
      itemData.lengthSeconds,
      itemData.isLive
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream
    artworkUrl = extractThumbnail(renderer, videoId)
    uri = `https://music.youtube.com/watch?v=${videoId}`
  } else {
    let metaFound = false

    if (fullApiResponse?.videoDetails) {
      const vd = fullApiResponse.videoDetails
      if (vd.title && vd.title !== 'undefined') {
        title = vd.title
        metaFound = true
      }
      if (vd.author && vd.author !== 'undefined') author = vd.author
    }

    if (!metaFound && renderer) {
      const renTitle =
        renderer.title?.simpleText || _utils.getRunsText(renderer.title?.runs)
      if (renTitle) {
        title = renTitle
        metaFound = true
      }
      const renAuthor = _utils.getRunsText(
        renderer.longBylineText?.runs ||
          renderer.shortBylineText?.runs ||
          renderer.ownerText?.runs
      )
      if (renAuthor) author = renAuthor
    }

    // Fallback to oEmbed if metadata is missing or generic
    if (!metaFound || title === FALLBACK_TITLE || author === FALLBACK_AUTHOR) {
      const oEmbed = await fetchOEmbedMetadata(videoId)
      if (oEmbed) {
        title = _utils.safeString(oEmbed.title, FALLBACK_TITLE)
        author = _utils.safeString(oEmbed.author, FALLBACK_AUTHOR)
        if (oEmbed.thumbnail_url && !artworkUrl)
          artworkUrl = oEmbed.thumbnail_url
      }
    }

    const lengthText =
      _utils.getItemValue(renderer, ['lengthText.simpleText']) ||
      _utils.getRunsText(renderer?.lengthText?.runs)
    const parsed = parseLengthAndStream(
      lengthText,
      renderer?.lengthSeconds,
      renderer?.isLive
    )
    lengthMs = parsed.lengthMs
    isStream = parsed.isStream
    artworkUrl = artworkUrl || extractThumbnail(renderer, videoId)
    uri = `https://www.youtube.com/watch?v=${videoId}`
  }

  const sourceName =
    sourceNameOverride ||
    (uri.includes('music.youtube.com') ? 'ytmusic' : 'youtube')

  const trackInfo = {
    identifier: _utils.safeString(videoId, ''),
    isSeekable: !isStream,
    author: _utils.safeString(author, FALLBACK_AUTHOR),
    length: lengthMs,
    isStream,
    position: 0,
    title: _utils.safeString(title, FALLBACK_TITLE),
    uri: _utils.safeString(uri, ''),
    artworkUrl,
    isrc: null,
    sourceName
  }

  if (!trackInfo.identifier) return null

  const basicTrack = {
    encoded: encodeTrack(trackInfo),
    info: trackInfo,
    pluginInfo: { captions: fullApiResponse?.captions }
  }

  if (enableHolo) {
    return await buildHoloTrack(
      trackInfo,
      itemData,
      itemType,
      fullApiResponse,
      config
    )
  }

  return basicTrack
}

export async function buildHoloTrack(
  trackInfo,
  itemData,
  itemType,
  fullApiResponse = null,
  config = {}
) {
  const duration = _utils.formatDuration(trackInfo.length)
  const sourceName = trackInfo.sourceName
  const sourceUrl =
    sourceName === 'ytmusic'
      ? 'https://music.youtube.com'
      : 'https://www.youtube.com'
  const renderer = getRendererFromItemData(itemData, itemType)

  const channelData = {
    name: trackInfo.author,
    id: null,
    url: null,
    icon: null,
    banner: null,
    subscribers: null,
    verified: false,
    description: null,
    videoCount: null,
    featuredVideo: null,
    links: []
  }

  let thumbnails = {}
  let viewCount = null
  let publishedAt = null
  let keywords = []
  let description = null
  let isLive = false
  let category = null
  let likeCount = null
  let accessibilityLabel = `${trackInfo.title} by ${trackInfo.author}`

  if (fullApiResponse?.videoDetails) {
    const vd = fullApiResponse.videoDetails
    viewCount = vd.viewCount ? parseInt(vd.viewCount, 10) : null
    keywords = vd.keywords || []
    description = vd.shortDescription || null
    isLive = vd.isLiveContent || false
    accessibilityLabel = `${trackInfo.title} by ${vd.author || trackInfo.author}`

    channelData.name = vd.author || trackInfo.author
    channelData.id = vd.channelId || null
    channelData.url = vd.channelId
      ? `https://www.youtube.com/channel/${vd.channelId}`
      : null

    if (vd.thumbnail?.thumbnails) {
      const thumbs = vd.thumbnail.thumbnails
      thumbnails = {
        default: thumbs[0]?.url?.split('?')[0],
        medium: (thumbs[1] || thumbs[0])?.url?.split('?')[0],
        high: thumbs.at(-1)?.url?.split('?')[0]
      }
    }
    if (vd.publishDate) publishedAt = _utils.parsePublishedAt(vd.publishDate)
  }

  if (fullApiResponse?.microformat?.playerMicroformatRenderer) {
    const micro = fullApiResponse.microformat.playerMicroformatRenderer
    publishedAt =
      publishedAt ||
      (micro.publishDate ? _utils.parsePublishedAt(micro.publishDate) : null) ||
      (micro.uploadDate ? _utils.parsePublishedAt(micro.uploadDate) : null)
    category = category || micro.category || null
    likeCount =
      likeCount || (micro.likeCount ? parseInt(micro.likeCount, 10) : null)
  }

  if (renderer) {
    const thumbArray =
      renderer.thumbnail?.thumbnails ||
      renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
      []
    thumbnails.default = thumbnails.default || thumbArray[0]?.url?.split('?')[0]
    thumbnails.medium =
      thumbnails.medium || (thumbArray[1] || thumbArray[0])?.url?.split('?')[0]
    thumbnails.high = thumbnails.high || thumbArray.at(-1)?.url?.split('?')[0]

    const viewCountText =
      _utils.getRunsText(
        _utils.getItemValue(renderer, [
          'viewCountText.runs',
          'shortViewCountText.runs'
        ])
      ) ||
      _utils.getItemValue(renderer, [
        'viewCountText.simpleText',
        'shortViewCountText.simpleText'
      ])

    if (viewCountText && !viewCount) {
      const match = viewCountText.match(/[\d,]+/)
      if (match) viewCount = parseInt(match[0].replace(/,/g, ''), 10)
    }

    const rendererPublishedAt =
      _utils.getRunsText(
        _utils.getItemValue(renderer, ['publishedTimeText.runs'])
      ) || _utils.getItemValue(renderer, ['publishedTimeText.simpleText'])

    if (rendererPublishedAt && !publishedAt) {
      publishedAt = _utils.parsePublishedAt(rendererPublishedAt)
    }

    if (!channelData.id) {
      const channelName =
        _utils.getRunsText(
          _utils.getItemValue(renderer, [
            'longBylineText.runs',
            'shortBylineText.runs',
            'ownerText.runs'
          ])
        ) || trackInfo.author
      const ep = _utils.getItemValue(renderer, [
        'longBylineText.runs.0.navigationEndpoint.browseEndpoint',
        'ownerText.runs.0.navigationEndpoint.browseEndpoint'
      ])

      channelData.name = channelName
      channelData.id = ep?.browseId || null
      channelData.url = ep?.canonicalBaseUrl
        ? `https://www.youtube.com${ep.canonicalBaseUrl}`
        : null
    }
  }

  thumbnails.default = thumbnails.default || trackInfo.artworkUrl
  thumbnails.medium = thumbnails.medium || trackInfo.artworkUrl
  thumbnails.high = thumbnails.high || trackInfo.artworkUrl

  if (config.fetchChannelInfo && channelData.id) {
    const ci = await fetchChannelInfo(
      channelData.id,
      fullApiResponse?.responseContext
    )
    if (ci) Object.assign(channelData, ci)
  }

  let externalLinks = extractExternalLinks(description)
  if (config.resolveExternalLinks && externalLinks) {
    externalLinks = await resolveExternalLinks(externalLinks)
  }

  const pluginInfo = {
    type: 'holo',
    accessibility: accessibilityLabel,
    description,
    keywords,
    externalLinks,
    details: {
      isSeekable: trackInfo.isSeekable,
      isLive,
      isExplicit: false,
      genres:
        keywords.length > 0 ? keywords.slice(0, 5) : category ? [category] : [],
      publishedAt
    },
    links: {
      source: trackInfo.uri,
      preview: `https://www.youtube.com/embed/${trackInfo.identifier}`,
      artist: channelData?.url || null
    },
    ids: { internal: trackInfo.identifier, isrc: trackInfo.isrc },
    duration,
    thumbnails,
    source: { name: sourceName, url: sourceUrl },
    artists: [],
    channel: channelData,
    album: null,
    chapters: [],
    stats: { views: viewCount, likes: likeCount, category },
    videoQualities: fullApiResponse?.streamingData
      ? extractVideoQualities(fullApiResponse.streamingData)
      : [],
    audioFormats: fullApiResponse?.streamingData
      ? extractAudioFormats(fullApiResponse.streamingData)
      : [],
    captions: fullApiResponse?.captions
  }

  return {
    encoded: encodeTrack(trackInfo),
    info: trackInfo,
    pluginInfo
  }
}

export function checkURLType(url, type) {
  const source = type === 'ytmusic' ? 'music' : 'www'

  if (
    RE_YT_PLAYLIST.test(url) ||
    (RE_YT_VIDEO.test(url) && url.includes('&list='))
  ) {
    return YOUTUBE_CONSTANTS.PLAYLIST
  }
  if (RE_YT_VIDEO.test(url)) {
    return YOUTUBE_CONSTANTS.VIDEO
  }
  if (type !== 'ytmusic') {
    if (RE_YT_SHORTS.test(url)) return YOUTUBE_CONSTANTS.SHORTS
    if (RE_YT_SHORT_URL.test(url)) return YOUTUBE_CONSTANTS.VIDEO
  }
  return YOUTUBE_CONSTANTS.UNKNOWN
}

export class BaseClient {
  constructor(nodelink, name, oauth) {
    this.nodelink = nodelink
    this.config = nodelink.options
    this.name = name
    this.oauth = oauth
  }

  getClient() {
    throw new Error('Not implemented')
  }
  requirePlayerScript() {
    return false
  }
  getApiEndpoint() {
    return 'https://youtubei.googleapis.com'
  }
  getPlayerParams() {
    return null
  }
  isEmbedded() {
    return false
  }
  async getAuthHeaders() {
    return {}
  }
  async search(query, type) {
    return { loadType: 'empty', data: {} }
  }

  async _makePlayerRequest(videoId, context, headers, cipherManager) {
    const requestBody = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }
    const playerParams = this.getPlayerParams()
    if (playerParams) requestBody.params = playerParams

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const script = await cipherManager.getCachedPlayerScript()
        if (script?.url) {
          const timestamp = await cipherManager.getTimestamp(script.url)
          requestBody.playbackContext = {
            contentPlaybackContext: { signatureTimestamp: timestamp }
          }
        }
      } catch (e) {
        console.error(`Signature timestamp failed: ${e.message}`)
      }
    }

    const response = await makeRequest(
      `${this.getApiEndpoint()}/youtubei/v1/player?prettyPrint=false`,
      {
        method: 'POST',
        headers: {
          'User-Agent': this.getClient(context).client.userAgent,
          ...(this.getClient(context).client.visitorData
            ? {
                'X-Goog-Visitor-Id': this.getClient(context).client.visitorData
              }
            : {}),
          ...(this.isEmbedded() ? { Referer: 'https://www.youtube.com' } : {}),
          ...headers
        },
        body: requestBody,
        disableBodyCompression: true
      }
    )

    if (response.statusCode !== 200) {
      const message = `Failed to get player data. Status: ${response.statusCode}`
      console.error(`Failed to get player data. Status: ${response.statusCode}`)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }
    return response
  }

  async _handlePlayerResponse(playerResponse, sourceName, videoId, context) {
    if (!playerResponse || typeof playerResponse !== 'object') {
      return { loadType: 'empty', data: {} }
    }
    if (playerResponse.error) {
      return {
        loadType: 'error',
        data: {
          message: playerResponse.error.message,
          severity: 'fault',
          cause: 'Upstream'
        }
      }
    }
    if (playerResponse.playabilityStatus?.status !== 'OK') {
      return {
        loadType: 'error',
        data: {
          message: playerResponse.playabilityStatus?.reason || 'Not playable',
          severity: 'common',
          cause: 'UpstreamPlayability'
        }
      }
    }

    const videoDetails = playerResponse.videoDetails
    if (!videoDetails?.videoId) {
      return {
        loadType: 'error',
        data: {
          message: 'No video details.',
          severity: 'fault',
          cause: 'NoVideoDetails'
        }
      }
    }

    const track = await buildTrack(
      videoDetails,
      sourceName,
      null,
      playerResponse,
      this.config.enableHoloTracks,
      {
        resolveExternalLinks: this.config.resolveExternalLinks,
        fetchChannelInfo: this.config.fetchChannelInfo
      }
    )

    if (!track) {
      return {
        loadType: 'error',
        data: {
          message: 'Track build failed.',
          severity: 'fault',
          cause: 'TrackBuildFailed'
        }
      }
    }
    return { loadType: 'track', data: track }
  }

  async _handlePlaylistResponse(
    playlistId,
    currentVideoId,
    playlistResponse,
    sourceName,
    context
  ) {
    if (playlistResponse?.error) {
      return {
        loadType: 'error',
        data: {
          message: playlistResponse.error.message,
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }

    const contentsRoot =
      playlistResponse.contents?.singleColumnWatchNextResults ||
      playlistResponse.contents?.singleColumnMusicWatchNextResultsRenderer

    let playlistContent = null
    if (contentsRoot?.playlist?.playlist?.contents) {
      playlistContent = contentsRoot.playlist.playlist.contents
    } else if (
      contentsRoot?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
        ?.tabRenderer?.content?.musicQueueRenderer
    ) {
      playlistContent =
        contentsRoot.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0]
          .tabRenderer.content.musicQueueRenderer.content?.playlistPanelRenderer
          ?.contents
    }

    if (!playlistContent?.length) {
      return { loadType: 'empty', data: {} }
    }

    const tracks = []
    let selectedTrack = 0
    const maxLength = this.config.maxAlbumPlaylistLength || 100

    for (let i = 0; i < Math.min(playlistContent.length, maxLength); i++) {
      const item = playlistContent[i]
      try {
        const track = await buildTrack(
          item,
          sourceName || 'youtube',
          null,
          null,
          this.config.enableHoloTracks,
          { fetchChannelInfo: false, resolveExternalLinks: false }
        )
        if (track) {
          tracks.push(track)
          if (currentVideoId && track.info?.identifier === currentVideoId)
            selectedTrack = i
        }
      } catch (err) {}
    }

    if (tracks.length === 0) return { loadType: 'empty', data: {} }

    return {
      loadType: 'playlist',
      data: {
        info: {
          name: contentsRoot.playlist?.playlist?.title || 'Unknown Playlist',
          selectedTrack
        },
        pluginInfo: {},
        tracks
      }
    }
  }

  async _extractStreamData(
    playerResponse,
    decodedTrack,
    context,
    cipherManager,
    itag
  ) {
    const streamingData = playerResponse.streamingData

    if (!streamingData) {
      logger(
        'error',
        `youtube-${this.name}`,
        `No streaming data found for ${decodedTrack.identifier}`
      )
      return {
        exception: {
          message: 'No streaming data available.',
          severity: 'common',
          cause: 'UpstreamNoStream'
        }
      }
    }

    const { targetItag, allowItag = [] } = this.config.sources.youtube || {}
    let targetItags = []

    if (itag) {
      logger('debug', `youtube-${this.name}`, `Using requested itag: ${itag}`)

      targetItags = [Number(itag)]
    } else if (targetItag) {
      logger(
        'debug',
        `youtube-${this.name}`,
        `Using target itag: ${targetItag}`
      )

      targetItags = [Number(targetItag)]
    } else {
      const qualityPriority = this._getQualityPriority()

      targetItags = qualityPriority[this.config.audio.quality || 'high'] || []

      if (allowItag.length > 0) {
        targetItags = [...new Set([...targetItags, ...allowItag])]
      }
    }

    const allFormats = [
      ...(streamingData.adaptiveFormats || []),
      ...(streamingData.formats || [])
    ]

    const formats = allFormats.map((f) => ({
      itag: f.itag,
      mimeType: f.mimeType,
      qualityLabel: f.qualityLabel,
      bitrate: f.bitrate,
      audioQuality: f.audioQuality
    }))

    const filteredFormats = allFormats
      .filter((format) => targetItags.includes(format.itag))
      .sort((a, b) => targetItags.indexOf(a.itag) - targetItags.indexOf(b.itag))

    if (filteredFormats.length === 0) {
      if (streamingData.hlsManifestUrl) {
        logger(
          'debug',
          `youtube-${this.name}`,
          `No suitable audio stream found for the configured quality. Falling back to HLS.`
        )
      } else {
        logger(
          'debug',
          `youtube-${this.name}`,
          `No suitable audio stream found for the configured quality. Available itags: ${allFormats.map((f) => f.itag).join(', ')}`
        )
        return {
          exception: {
            message:
              'No suitable audio stream found for the configured quality.',
            severity: 'common',
            cause: 'Upstream'
          }
        }
      }
    }

    let resolvedFormat = null

    if (this.requirePlayerScript()) {
      const playerScript = await cipherManager.getCachedPlayerScript()
      if (!playerScript) {
        logger(
          'error',
          `youtube-${this.name}`,
          'Failed to obtain player script for deciphering. Cannot extract stream data.'
        )
        return {
          exception: {
            message: 'Failed to obtain player script for deciphering.',
            severity: 'fault',
            cause: 'Internal'
          }
        }
      }
      for (const format of filteredFormats) {
        let currentStreamUrl = format.url
        let currentEncryptedSignature
        let currentNParam
        let currentSignatureKey

        if (format.signatureCipher) {
          const cipher = new URLSearchParams(format.signatureCipher)
          currentStreamUrl = cipher.get('url')
          currentEncryptedSignature = cipher.get('s')
          currentSignatureKey = cipher.get('sp') || 'sig'
          currentNParam = cipher.get('n')
        }

        if (currentStreamUrl) {
          try {
            const decipheredUrl = await cipherManager.resolveUrl(
              currentStreamUrl,
              currentEncryptedSignature,
              currentNParam,
              currentSignatureKey,
              playerScript,
              context
            )
            format.url = decipheredUrl
            resolvedFormat = format
            logger(
              'debug',
              `youtube-${this.name}`,
              `Successfully resolved URL for itag ${format.itag}.`
            )
            break
          } catch (e) {
            logger(
              'warn',
              `youtube-${this.name}`,
              `Failed to resolve format URL for itag ${format.itag}: ${e.message}`
            )
          }
        }
      }
    } else {
      resolvedFormat = filteredFormats[0]
    }

    if (!resolvedFormat) {
      if (streamingData.hlsManifestUrl) {
        logger(
          'debug',
          `youtube-${this.name}`,
          'Could not resolve a working URL from the filtered formats. Falling back to HLS.'
        )
      } else {
        logger(
          'debug',
          `youtube-${this.name}`,
          'Could not resolve a working URL from the filtered formats.'
        )
        return {
          exception: {
            message: 'Could not resolve a working URL.',
            severity: 'fault',
            cause: 'Cipher'
          }
        }
      }
    }

    const directUrl =
      resolvedFormat?.url && !decodedTrack.isStream
        ? resolvedFormat.url
        : undefined

    if (!directUrl && !streamingData.hlsManifestUrl) {
      logger(
        'debug',

        `youtube-${this.name}`,

        `No suitable audio stream found. Available streamingData: ${JSON.stringify(streamingData)}`
      )

      return {
        exception: {
          message: 'No suitable audio stream found.',

          severity: 'common',

          cause: 'Upstream'
        },

        formats
      }
    }

    const resolveFormat = (mimeType) => {
      if (!mimeType) return null

      const lowerMime = mimeType.toLowerCase()

      if (lowerMime.includes('opus')) {
        return 'webm/opus'
      }

      if (lowerMime.includes('mp4')) {
        return 'mp4'
      }

      if (lowerMime.includes('mp3')) {
        return 'mp3'
      }

      if (lowerMime.includes('aac')) {
        return 'aac'
      }

      if (decodedTrack.isStream) {
        return 'mpegts'
      }

      return null
    }

    return {
      url: directUrl,

      protocol: directUrl ? 'http' : null,

      format: resolveFormat(resolvedFormat?.mimeType),

      hlsUrl: streamingData.hlsManifestUrl || null,

      formats
    }
  }

  _getQualityPriority() {
    return {
      high: [251, 141],
      medium: [250, 140],
      low: [249],
      lowest: [249]
    }
  }

  async resolve(url, type, context, cipherManager) {
    const sourceName = 'youtube'
    const urlType = checkURLType(url, 'youtube')
    const headers = this.oauth ? await this.getAuthHeaders() : {}

    if (
      urlType === YOUTUBE_CONSTANTS.VIDEO ||
      urlType === YOUTUBE_CONSTANTS.SHORTS
    ) {
      const match = url.match(RE_ID_EXTRACT)
      if (!match)
        return {
          loadType: 'error',
          data: { message: 'Invalid URL', severity: 'common', cause: 'Input' }
        }

      const { body, statusCode } = await this._makePlayerRequest(
        match[1],
        context,
        headers,
        cipherManager
      )
      if (statusCode !== 200) {
        return {
          loadType: 'error',
          data: {
            message: 'Failed to load player data',
            severity: 'common',
            cause: 'Upstream'
          }
        }
      }
      return await this._handlePlayerResponse(
        body,
        sourceName,
        match[1],
        context
      )
    }

    if (urlType === YOUTUBE_CONSTANTS.PLAYLIST) {
      const listMatch = url.match(RE_PLAYLIST_ID)
      if (!listMatch)
        return {
          loadType: 'error',
          data: {
            message: 'Invalid playlist URL',
            severity: 'common',
            cause: 'Input'
          }
        }

      const vMatch = url.match(RE_VIDEO_IN_PLAYLIST)
      const { body, statusCode } = await makeRequest(
        `${this.getApiEndpoint()}/youtubei/v1/next`,
        {
          headers: {
            'User-Agent': this.getClient(context).userAgent,
            ...headers
          },
          body: {
            context: { client: this.getClient(context) },
            playlistId: listMatch[1]
          },
          method: 'POST',
          disableBodyCompression: true
        }
      )

      if (statusCode !== 200 || body?.error) {
        return {
          loadType: 'error',
          data: {
            message: 'Failed to fetch playlist',
            severity: 'common',
            cause: 'Upstream'
          }
        }
      }
      return await this._handlePlaylistResponse(
        listMatch[1],
        vMatch?.[1],
        body,
        sourceName,
        context
      )
    }

    return { loadType: 'empty', data: {} }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const headers = this.oauth ? await this.getAuthHeaders() : {}
    const { body, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager
    )

    if (statusCode !== 200) {
      return {
        exception: {
          message: 'Failed to get player data',
          severity: 'common',
          cause: 'Upstream'
        }
      }
    }
    return await this._extractStreamData(
      body,
      decodedTrack,
      context,
      cipherManager
    )
  }
}
