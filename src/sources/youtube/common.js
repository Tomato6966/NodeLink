import {
  encodeTrack,
  generateRandomLetters,
  logger,
  makeRequest
} from '../../utils.js'

export const YOUTUBE_CONSTANTS = {
  VIDEO: 0,
  PLAYLIST: 1,
  SHORTS: 2,
  UNKNOWN: -1
}

function formatDuration(ms) {
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
}

function formatNumber(num) {
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(1)}B`
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
  return String(num)
}

function parsePublishedAt(publishedText) {
  if (!publishedText) return null

  const date = new Date(publishedText)
  if (!isNaN(date.getTime())) {
    const timestamp = date.getTime()
    const now = Date.now()
    const diffMs = now - timestamp

    const years = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000))
    const months = Math.floor(
      (diffMs % (365.25 * 24 * 60 * 60 * 1000)) / (30.44 * 24 * 60 * 60 * 1000)
    )
    const weeks = Math.floor(
      (diffMs % (30.44 * 24 * 60 * 60 * 1000)) / (7 * 24 * 60 * 60 * 1000)
    )
    const days = Math.floor(
      (diffMs % (7 * 24 * 60 * 60 * 1000)) / (24 * 60 * 60 * 1000)
    )
    const hours = Math.floor(
      (diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)
    )
    const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000))
    const seconds = Math.floor((diffMs % (60 * 1000)) / 1000)

    const parts = []
    if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`)
    if (months > 0) parts.push(`${months} month${months > 1 ? 's' : ''}`)
    if (weeks > 0) parts.push(`${weeks} week${weeks > 1 ? 's' : ''}`)
    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`)
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`)
    if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`)
    if (seconds > 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`)

    const readable = parts.length > 0 ? parts.join(' ') + ' ago' : 'just now'
    const compact = `${years}y ${months}mo ${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`

    return {
      original: publishedText,
      timestamp: Math.floor(timestamp),
      date: date.toISOString(),
      readable,
      compact
    }
  }

  const text = publishedText.toLowerCase()

  const yearMatch = text.match(/(\d+)\s*year/)
  const monthMatch = text.match(/(\d+)\s*month/)
  const weekMatch = text.match(/(\d+)\s*week/)
  const dayMatch = text.match(/(\d+)\s*day/)
  const hourMatch = text.match(/(\d+)\s*hour/)
  const minuteMatch = text.match(/(\d+)\s*minute/)
  const secondMatch = text.match(/(\d+)\s*second/)

  const years = yearMatch ? Number.parseInt(yearMatch[1], 10) : 0
  const months = monthMatch ? Number.parseInt(monthMatch[1], 10) : 0
  const weeks = weekMatch ? Number.parseInt(weekMatch[1], 10) : 0
  const days = dayMatch ? Number.parseInt(dayMatch[1], 10) : 0
  const hours = hourMatch ? Number.parseInt(hourMatch[1], 10) : 0
  const minutes = minuteMatch ? Number.parseInt(minuteMatch[1], 10) : 0
  const seconds = secondMatch ? Number.parseInt(secondMatch[1], 10) : 0

  const now = Date.now()
  const msAgo =
    years * 365.25 * 24 * 60 * 60 * 1000 +
    months * 30.44 * 24 * 60 * 60 * 1000 +
    weeks * 7 * 24 * 60 * 60 * 1000 +
    days * 24 * 60 * 60 * 1000 +
    hours * 60 * 60 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000
  const timestamp = now - msAgo

  const parts = []
  if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`)
  if (months > 0) parts.push(`${months} month${months > 1 ? 's' : ''}`)
  if (weeks > 0) parts.push(`${weeks} week${weeks > 1 ? 's' : ''}`)
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`)
  if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`)
  if (seconds > 0) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`)

  const readable = parts.length > 0 ? parts.join(' ') + ' ago' : 'just now'

  const compact = `${years}y ${months}mo ${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`

  return {
    original: publishedText,
    timestamp: Math.floor(timestamp),
    date: new Date(timestamp).toISOString(),
    readable,
    compact,
    ago: {
      years,
      months,
      weeks,
      days,
      hours,
      minutes,
      seconds
    }
  }
}

async function fetchChannelInfo(channelId, makeRequest, context) {
  if (!channelId) return null

  try {
    logger(
      'debug',
      'fetchChannelInfo',
      `Fetching info for channel: ${channelId}`
    )

    const { body: channelResponse, statusCode } = await makeRequest(
      'https://www.youtube.com/youtubei/v1/browse',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20241106.01.00',
              hl: context?.client?.hl || 'en',
              gl: context?.client?.gl || 'US'
            }
          },
          browseId: channelId
        },
        disableBodyCompression: true
      }
    )

    if (statusCode !== 200 || !channelResponse) {
      logger(
        'warn',
        'fetchChannelInfo',
        `Bad status code or empty response: ${statusCode}`
      )
      return null
    }

    const header =
      channelResponse.header?.pageHeaderRenderer?.content?.pageHeaderViewModel
    if (!header) {
      logger('warn', 'fetchChannelInfo', 'No pageHeaderViewModel found')
      return null
    }

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

    channelInfo.icon =
      Array.isArray(avatarSources) && avatarSources.length > 0
        ? avatarSources[avatarSources.length - 1]?.url?.split('=')[0] || null
        : null

    const bannerSources = header.banner?.imageBannerViewModel?.image?.sources

    channelInfo.banner =
      Array.isArray(bannerSources) && bannerSources.length > 0
        ? bannerSources[bannerSources.length - 1]?.url?.split('=')[0] || null
        : null

    const accessibilityLabel =
      header.title?.dynamicTextViewModel?.rendererContext?.accessibilityContext
        ?.label

    channelInfo.verified = accessibilityLabel?.includes('Verified') || false

    const metadataRows = header.metadata?.contentMetadataViewModel?.metadataRows

    if (Array.isArray(metadataRows)) {
      for (const row of metadataRows) {
        if (Array.isArray(row.metadataParts)) {
          for (const part of row.metadataParts) {
            const text = part.text?.content || part.text

            if (typeof text === 'string') {
              const lowerText = text.toLowerCase()

              if (lowerText.includes('subscriber')) {
                const numStrMatch = lowerText.match(/([\d.,]+)\s*([kmb])?/i)

                if (numStrMatch) {
                  let count = parseFloat(numStrMatch[1].replace(/,/g, ''))

                  const multiplier = numStrMatch[2]?.toLowerCase()

                  if (multiplier === 'k') count *= 1000
                  else if (multiplier === 'm') count *= 1000000
                  else if (multiplier === 'b') count *= 1000000000

                  channelInfo.subscribers = {
                    original: text,

                    count: Math.floor(count),

                    formatted: formatNumber(Math.floor(count))
                  }
                } else {
                  channelInfo.subscribers = {
                    original: text,

                    count: null,

                    formatted: text
                  }
                }
              } else if (lowerText.includes('video')) {
                const match = lowerText.match(/(\d+(?:,\d+)*)\s*video/i)

                if (match) {
                  const count = parseInt(match[1].replace(/,/g, ''), 10)

                  channelInfo.videoCount = {
                    original: text,

                    count,

                    formatted: formatNumber(count)
                  }
                } else {
                  channelInfo.videoCount = {
                    original: text,

                    count: null,

                    formatted: text
                  }
                }
              }
            }
          }
        }
      }
    }

    channelInfo.description =
      header.description?.descriptionPreviewViewModel?.description?.content ||
      null

    const attribution = header.attribution?.attributionViewModel

    const mainLink = attribution?.text?.content

    if (mainLink && !mainLink.includes('and') && !mainLink.includes('more')) {
      channelInfo.links.push(mainLink)
    }

    const contents =
      channelResponse.contents?.singleColumnBrowseResultsRenderer?.tabs

    if (Array.isArray(contents)) {
      for (const tab of contents) {
        const tabContent =
          tab.tabRenderer?.content?.sectionListRenderer?.contents

        if (Array.isArray(tabContent)) {
          for (const section of tabContent) {
            const items = section.itemSectionRenderer?.contents

            if (Array.isArray(items)) {
              for (const item of items) {
                const channelVideoPlayer = item.channelVideoPlayerRenderer

                if (channelVideoPlayer?.videoId) {
                  channelInfo.featuredVideo = {
                    id: channelVideoPlayer.videoId,

                    url: `https://www.youtube.com/watch?v=${channelVideoPlayer.videoId}`,

                    title: channelVideoPlayer.title?.runs?.[0]?.text || null,

                    description:
                      channelVideoPlayer.description?.runs?.[0]?.text || null
                  }

                  break
                }
              }
            }

            if (channelInfo.featuredVideo) break
          }
        }

        if (channelInfo.featuredVideo) break
      }
    }

    logger(
      'debug',
      'fetchChannelInfo',
      `Channel info: icon=${channelInfo.icon ? 'yes' : 'no'}, subscribers=${channelInfo.subscribers}, verified=${channelInfo.verified}`
    )
    return channelInfo
  } catch (e) {
    logger(
      'error',
      'fetchChannelInfo',
      `Failed to fetch channel info: ${e.message}`
    )
    logger('error', 'fetchChannelInfo', e.stack)
    return null
  }
}

async function resolveExternalLinks(externalLinks, makeRequest) {
  if (!externalLinks) return null

  const resolved = { ...externalLinks }

  if (
    resolved.spotify &&
    (resolved.spotify.includes('smarturl.it') ||
      resolved.spotify.includes('ffm.to'))
  ) {
    try {
      const response = await makeRequest(resolved.spotify, {
        method: 'GET',
        followRedirects: true,
        maxRedirects: 5
      })
      if (response.finalUrl && response.finalUrl.includes('spotify.com')) {
        resolved.spotify = response.finalUrl

        const match = response.finalUrl.match(
          /spotify\.com\/(album|track|artist|playlist)\/([a-zA-Z0-9]+)/
        )
        if (match) {
          resolved.spotifyId = {
            type: match[1],
            id: match[2]
          }
        }
      }
    } catch (e) {}
  }

  if (
    resolved.appleMusic &&
    (resolved.appleMusic.includes('smarturl.it') ||
      resolved.appleMusic.includes('apple'))
  ) {
    try {
      const response = await makeRequest(resolved.appleMusic, {
        method: 'GET',
        followRedirects: true,
        maxRedirects: 5
      })
      if (response.finalUrl && response.finalUrl.includes('music.apple.com')) {
        resolved.appleMusic = response.finalUrl
      }
    } catch (e) {}
  }

  return resolved
}

function extractExternalLinks(
  description,
  resolve = false,
  makeRequest = null
) {
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

  const urlRegex = /(https?:\/\/[^\s]+)/gi
  const matches = description.match(urlRegex) || []

  const linkMatchers = [
    { key: 'spotify', patterns: ['spotify.com', 'open.spotify.com'] },
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
      if (
        !links.website &&
        (url.includes('.com') ||
          url.includes('.net') ||
          url.includes('.org') ||
          url.includes('.io'))
      ) {
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
        const codecMatch = format.mimeType.match(/codecs="([^"]+)"/)
        const codec = codecMatch ? codecMatch[1].split('.')[0] : 'unknown'

        qualityMap.set(quality, {
          quality,
          bitrate: format.bitrate,
          fps: format.fps || null,
          mimeType: format.mimeType || null,
          width: format.width || null,
          height: format.height || null,
          codec,
          itag: format.itag,
          container: format.mimeType?.split(';')[0]?.split('/')[1] || null,
          averageBitrate: format.averageBitrate || null,
          contentLength: format.contentLength || null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort((a, b) => {
    const resA = Number.parseInt(a.quality) || 0
    const resB = Number.parseInt(b.quality) || 0
    return resA - resB
  })
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
        const codecMatch = format.mimeType.match(/codecs="([^"]+)"/)
        const codec = codecMatch ? codecMatch[1] : 'unknown'

        qualityMap.set(audioQuality, {
          itag: format.itag,
          mimeType: format.mimeType,
          bitrate: format.bitrate,
          averageBitrate: format.averageBitrate || null,
          audioQuality: format.audioQuality || null,
          audioSampleRate: format.audioSampleRate || null,
          audioChannels: format.audioChannels || null,
          codec,
          container: format.mimeType?.split(';')[0]?.split('/')[1] || null,
          contentLength: format.contentLength || null,
          loudnessDb: format.loudnessDb || null
        })
      }
    }
  }

  return Array.from(qualityMap.values()).sort((a, b) => b.bitrate - a.bitrate)
}

export async function buildHoloTrack(
  trackInfo,
  itemData,
  itemType,
  fullApiResponse = null,
  config = {}
) {
  const duration = formatDuration(trackInfo.length)
  const sourceName = trackInfo.sourceName
  const sourceUrl =
    sourceName === 'ytmusic'
      ? 'https://music.youtube.com'
      : 'https://www.youtube.com'

  const getItemValue = (obj, paths, defaultValue = null) => {
    for (const path of paths) {
      const value = path.split('.').reduce((o, k) => o?.[k], obj)
      if (value !== undefined && value !== null) return value
    }
    return defaultValue
  }

  const getRunsText = (runsArray, defaultValue = null) => {
    if (Array.isArray(runsArray) && runsArray.length > 0) {
      return runsArray.map((run) => run.text).join('')
    }
    return defaultValue
  }

  let renderer = null
  if (itemType === 'ytmusic') {
    renderer = getItemValue(itemData, [
      'musicResponsiveListItemRenderer',
      'playlistPanelVideoRenderer',
      'musicTwoColumnItemRenderer'
    ])
  } else {
    renderer =
      getItemValue(itemData, [
        'videoRenderer',
        'compactVideoRenderer',
        'playlistPanelVideoRenderer',
        'gridVideoRenderer'
      ]) || (itemData.videoId ? itemData : null)
  }

  const channelData = {
    name: trackInfo.author,
    id: null,
    url: null,
    icon: null,
    subscribers: null,
    verified: false,
    description: null,
    videoCount: null,
    featuredVideo: null,
    links: []
  }
  let thumbnails = {}
  let viewCount = null
  let badges = []
  let accessibilityLabel = `${trackInfo.title} by ${trackInfo.author}`
  let publishedAt = null
  let keywords = []
  let description = null
  let isLive = false
  let category = null
  let likeCount = null

  if (fullApiResponse?.videoDetails) {
    const vd = fullApiResponse.videoDetails
    viewCount = vd.viewCount ? Number.parseInt(vd.viewCount, 10) : null
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
        default: thumbs[0]?.url?.split('?')[0] || null,
        medium:
          thumbs[1]?.url?.split('?')[0] ||
          thumbs[0]?.url?.split('?')[0] ||
          null,
        high: thumbs[thumbs.length - 1]?.url?.split('?')[0] || null
      }
    }
    publishedAt = vd.publishDate || null

    if (publishedAt && typeof publishedAt === 'string') {
      publishedAt = parsePublishedAt(publishedAt)
    }
  }

  if (fullApiResponse?.microformat?.playerMicroformatRenderer) {
    const micro = fullApiResponse.microformat.playerMicroformatRenderer

    publishedAt =
      publishedAt ||
      (micro.publishDate ? parsePublishedAt(micro.publishDate) : null) ||
      (micro.uploadDate ? parsePublishedAt(micro.uploadDate) : null)
    category = category || micro.category || null
    likeCount =
      likeCount ||
      (micro.likeCount ? Number.parseInt(micro.likeCount, 10) : null)
  }

  if (renderer) {
    const thumbArray =
      renderer.thumbnail?.thumbnails ||
      renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
      []
    thumbnails = {
      default: thumbArray[0]?.url?.split('?')[0] || null,
      medium:
        thumbArray[1]?.url?.split('?')[0] ||
        thumbArray[0]?.url?.split('?')[0] ||
        null,
      high: thumbArray[thumbArray.length - 1]?.url?.split('?')[0] || null
    }

    const viewCountText =
      getRunsText(
        getItemValue(renderer, [
          'viewCountText.runs',
          'shortViewCountText.runs'
        ])
      ) ||
      getItemValue(renderer, [
        'viewCountText.simpleText',
        'shortViewCountText.simpleText'
      ])
    if (viewCountText && !viewCount) {
      const match = viewCountText.match(/[\d,]+/)
      if (match) viewCount = Number.parseInt(match[0].replace(/,/g, ''), 10)
    }

    const rendererPublishedAt =
      getRunsText(getItemValue(renderer, ['publishedTimeText.runs'])) ||
      getItemValue(renderer, ['publishedTimeText.simpleText'])

    if (rendererPublishedAt && !publishedAt) {
      publishedAt = parsePublishedAt(rendererPublishedAt)
    }

    const rendererAccessibility = getItemValue(renderer, [
      'accessibility.accessibilityData.label',
      'title.accessibility.accessibilityData.label'
    ])

    accessibilityLabel = accessibilityLabel || rendererAccessibility

    const ownerBadges = renderer.ownerBadges || []
    badges = ownerBadges
      .map((b) =>
        getItemValue(b, [
          'metadataBadgeRenderer.tooltip',
          'metadataBadgeRenderer.label'
        ])
      )
      .filter(Boolean)

    if (!channelData.id) {
      const channelName =
        getRunsText(
          getItemValue(renderer, [
            'longBylineText.runs',
            'shortBylineText.runs',
            'ownerText.runs'
          ])
        ) || trackInfo.author
      const channelUrl = getItemValue(renderer, [
        'longBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
        'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl',
        'ownerText.runs.0.navigationEndpoint.browseEndpoint.canonicalBaseUrl'
      ])
      const channelIdFromRenderer = getItemValue(renderer, [
        'longBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
        'shortBylineText.runs.0.navigationEndpoint.browseEndpoint.browseId',
        'ownerText.runs.0.navigationEndpoint.browseEndpoint.browseId'
      ])

      channelData.name = channelName
      channelData.id = channelIdFromRenderer || null
      channelData.url = channelUrl
        ? `https://www.youtube.com${channelUrl}`
        : null
    }
  }

  accessibilityLabel =
    accessibilityLabel ||
    `${trackInfo.title} by ${channelData.name || trackInfo.author}`

  if (config.fetchChannelInfo && channelData.id) {
    try {
      const channelInfo = await fetchChannelInfo(
        channelData.id,
        makeRequest,
        fullApiResponse?.responseContext
      )
      if (channelInfo) {
        channelData.icon = channelInfo.icon
        channelData.banner = channelInfo.banner
        channelData.subscribers = channelInfo.subscribers
        channelData.verified = channelInfo.verified
        channelData.description = channelInfo.description
        channelData.videoCount = channelInfo.videoCount
        channelData.featuredVideo = channelInfo.featuredVideo || null
        if (channelInfo.links && channelInfo.links.length > 0) {
          channelData.links = channelInfo.links
        }
      }
    } catch (e) {
      logger(
        'warn',
        'buildHoloTrack',
        `Failed to fetch channel info: ${e.message}`
      )
    }
  }

  thumbnails.default = thumbnails.default || trackInfo.artworkUrl
  thumbnails.medium = thumbnails.medium || trackInfo.artworkUrl
  thumbnails.high = thumbnails.high || trackInfo.artworkUrl

  let externalLinks = extractExternalLinks(description)

  if (config.resolveExternalLinks && externalLinks) {
    try {
      externalLinks = await resolveExternalLinks(externalLinks, makeRequest)
    } catch (e) {
      logger(
        'warn',
        'buildHoloTrack',
        `Failed to resolve external links: ${e.message}`
      )
    }
  }

  const videoQualities = fullApiResponse?.streamingData
    ? extractVideoQualities(fullApiResponse.streamingData)
    : []

  const audioFormats = fullApiResponse?.streamingData
    ? extractAudioFormats(fullApiResponse.streamingData)
    : []

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
    ids: {
      internal: trackInfo.identifier,
      isrc: trackInfo.isrc
    },
    duration,
    thumbnails,
    source: {
      name: sourceName,
      url: sourceUrl
    },
    artists: [],
    channel: channelData,
    album: null,
    chapters: [],
    stats: {
      views: viewCount,
      likes: likeCount,
      category: category
    },
    videoQualities,
    audioFormats,
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
  const videoRegex = new RegExp(
    `^https?://${source === 'music' ? 'music\\.' : '(?:www\\.)?'}youtube.com/watch\\?v=[\\w-]+`
  )
  const playlistRegex = new RegExp(
    `^https?://${source === 'music' ? 'music\\.' : '(?:www\\.)?'}youtube.com/playlist\\?list=[\\w-]+`
  )
  const shortUrlRegex = /^https?:\/\/youtu\.be\/[\w-]+/
  const shortsRegex = /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/[\w-]+/

  if (
    playlistRegex.test(url) ||
    (videoRegex.test(url) && url.includes('&list='))
  ) {
    return YOUTUBE_CONSTANTS.PLAYLIST
  }
  if (videoRegex.test(url)) {
    return YOUTUBE_CONSTANTS.VIDEO
  }
  if (type !== 'ytmusic') {
    if (shortsRegex.test(url)) {
        return YOUTUBE_CONSTANTS.SHORTS;
    }
    if (shortUrlRegex.test(url)) {
        return YOUTUBE_CONSTANTS.VIDEO;
    }
  }
  return YOUTUBE_CONSTANTS.UNKNOWN
}

function parseLengthAndStream(lengthText, lengthSeconds, isLive) {
  if (isLive) {
    return { lengthMs: -1, isStream: true }
  }

  let lengthMs = 0
  let isStream = true

  if (lengthText && /[:\d]+/.test(lengthText)) {
    const parts = lengthText.split(':').map(Number)
    lengthMs = parts.reduce((acc, val) => acc * 60 + val, 0) * 1000
    isStream = !Number.isFinite(lengthMs)
  } else if (lengthSeconds) {
    lengthMs = Number.parseInt(lengthSeconds, 10) * 1000
    isStream = !!isLive
  }
  return { lengthMs, isStream }
}

export async function buildTrack(
  itemData,
  itemType,
  sourceNameOverride = null,
  fullApiResponse = null,
  enableHolo = false,
  config = {}
) {
  let videoId
  let title
  let author
  let lengthMs = 0
  let isStream = true
  let artworkUrl
  let uri

  const getItemValue = (obj, paths, defaultValue = null) => {
    for (const path of paths) {
      const value = path.split('.').reduce((o, k) => o?.[k], obj)
      if (value !== undefined && value !== null) return value
    }
    return defaultValue
  }

  const getRunsText = (runsArray, defaultValue = 'Unknown') => {
    if (Array.isArray(runsArray) && runsArray.length > 0) {
      return runsArray.map((run) => run.text).join('')
    }
    return defaultValue
  }

  let renderer = null
  if (itemType === 'ytmusic') {
    renderer = getItemValue(itemData, [
      'musicResponsiveListItemRenderer',
      'playlistPanelVideoRenderer',
      'musicTwoColumnItemRenderer'
    ])
  } else {
    renderer =
      getItemValue(itemData, [
        'videoRenderer',
        'compactVideoRenderer',
        'playlistPanelVideoRenderer',
        'gridVideoRenderer'
      ]) || (itemData.videoId ? itemData : null)
  }

  if (!renderer && !itemData.videoId) return null

  videoId = getItemValue(
    renderer,
    [
      'playlistItemData.videoId',
      'navigationEndpoint.watchEndpoint.videoId',
      'videoId'
    ],
    itemData.videoId || renderer?.videoId
  )

  if (!videoId) return null;

  if (itemType === 'ytmusic') {
    title = getRunsText(getItemValue(renderer, ['title.runs']), 'Unknown Title')
    
    let authorText = 'Unknown Artist';
    const subtitleRuns = getItemValue(renderer, ['subtitle.runs']);
    if (Array.isArray(subtitleRuns) && subtitleRuns.length > 0) {
        authorText = subtitleRuns[0]?.text || authorText;
    }
    author = authorText;

    let lengthText = null;
    if (Array.isArray(subtitleRuns)) {
        lengthText = subtitleRuns.find(run => run.text && /^\d{1,2}:\d{2}$/.test(run.text || ''))?.text;
    }
    const { lengthMs: parsedLengthMs, isStream: parsedIsStream } =
      parseLengthAndStream(
        lengthText,
        itemData.lengthSeconds, 
        itemData.isLive
      )
    lengthMs = parsedLengthMs
    isStream = parsedIsStream

    const thumbnails = getItemValue(renderer, ['thumbnail.musicThumbnailRenderer.thumbnail.thumbnails']);
    if (Array.isArray(thumbnails) && thumbnails.length > 0) {
        artworkUrl = thumbnails[thumbnails.length - 1]?.url; 
    } else {
        artworkUrl = itemData.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.pop()?.url || itemData.thumbnail?.thumbnails?.pop()?.url;
    }

    uri = `https://music.youtube.com/watch?v=${videoId}`
  } else {
    title =
      typeof renderer.title === 'string'
        ? renderer.title
        : getRunsText(
            renderer.title?.runs,
            getItemValue(fullApiResponse, [
              'videoDetails.endscreen.endscreenRenderer.elements.1.endscreenElementRenderer.title.simpleText'
            ]),
            getItemValue(renderer, ['title.simpleText'], 'Unknown Title')
          )
    author =
      renderer.author ||
      getRunsText(
        getItemValue(renderer, [
          'longBylineText.runs',
          'shortBylineText.runs',
          'ownerText.runs'
        ]),
        getItemValue(fullApiResponse, [
          'videoDetails.endscreen.endscreenRenderer.elements.0.endscreenElementRenderer.title.simpleText'
        ]),
        'Unknown Channel'
      )
    const { lengthMs: parsedLengthMs, isStream: parsedIsStream } =
      parseLengthAndStream(
        getItemValue(
          renderer,
          ['lengthText.simpleText'],
          getRunsText(renderer.lengthText?.runs)
        ),
        renderer.lengthSeconds,
        renderer.isLive
      )
    lengthMs = parsedLengthMs
    isStream = parsedIsStream
    artworkUrl = renderer.thumbnail?.thumbnails?.pop()?.url
    uri = `https://www.youtube.com/watch?v=${videoId}`
  }

  const trackInfo = {
    identifier: videoId,
    isSeekable: !isStream,
    author,
    length: lengthMs,
    isStream,
    position: 0,
    title,
    uri,
    artworkUrl: artworkUrl || null,
    isrc: null,
    sourceName:
      sourceNameOverride || (itemType === 'ytmusic' ? 'ytmusic' : 'youtube')
  }

  if (trackInfo.uri?.includes('music.youtube.com')) {
    trackInfo.sourceName = 'ytmusic'
  } else if (trackInfo.uri?.includes('youtube.com') || trackInfo.uri?.includes('youtu.be')) {
    trackInfo.sourceName = 'youtube'
  }

  if (trackInfo.sourceName === 'ytmusic' && renderer) {
    const musicThumbnails = getItemValue(renderer, ['thumbnail.musicThumbnailRenderer.thumbnail.thumbnails']);
    if (Array.isArray(musicThumbnails) && musicThumbnails.length > 0) {
        trackInfo.artworkUrl = musicThumbnails[musicThumbnails.length - 1]?.url;
    }
  }
  if (!trackInfo.artworkUrl) {
    trackInfo.artworkUrl = artworkUrl;
  }
  trackInfo.artworkUrl = trackInfo.artworkUrl?.split('?')[0] || trackInfo.artworkUrl;

  const basicTrack = {
    encoded: encodeTrack(trackInfo),
    info: trackInfo,
    pluginInfo: {
      captions: fullApiResponse?.captions
    }
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
    const apiEndpoint = this.getApiEndpoint()
    const requestBody = {
      context: this.getClient(context),
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }

    const playerParams = this.getPlayerParams()
    if (playerParams) {
      requestBody.params = playerParams
    }

    if (this.requirePlayerScript() && cipherManager) {
      try {
        const playerScript = await cipherManager.getCachedPlayerScript()
        if (playerScript && playerScript.url) {
          const signatureTimestamp = await cipherManager.getTimestamp(
            playerScript.url
          )
          requestBody.playbackContext = {
            contentPlaybackContext: {
              signatureTimestamp: signatureTimestamp
            }
          }
        }
      } catch (e) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to get signature timestamp for player request: ${e.message}`
        )
      }
    }
    const response = await makeRequest(
      `${apiEndpoint}/youtubei/v1/player?prettyPrint=false`,
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
      const message = `Failed to get player data for stream. Status: ${response.statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }
    return response
  }

  async _handlePlayerResponse(playerResponse, sourceName, videoId, context) {
    if (playerResponse.error) {
      logger(
        'error',
        `youtube-${this.name}`,
        `API error for video/short ${videoId}: ${playerResponse.error.message}`
      )
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
      const message =
        playerResponse.playabilityStatus?.reason || 'Video not playable.'
      logger(
        'warn',
        `youtube-${this.name}`,
        `Video/short ${videoId} not playable: ${message}`
      )
      return {
        loadType: 'error',
        data: { message, severity: 'common', cause: 'UpstreamPlayability' }
      }
    }

    const track = await buildTrack(
      playerResponse.videoDetails,
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
          message: 'Failed to process video data.',
          severity: 'fault',
          cause: 'Internal'
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
      const errMsg =
        playlistResponse?.error?.message || 'Failed to fetch playlist.'
      logger(
        'error',
        `youtube-${this.name}`,
        `Error loading playlist ${playlistId}: ${errMsg}`
      )
      return {
        loadType: 'error',
        data: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const contentsRoot = playlistResponse.contents.singleColumnWatchNextResults || 
                         playlistResponse.contents.singleColumnMusicWatchNextResultsRenderer
    
    let playlistContent = null
    
    if (contentsRoot?.playlist?.playlist?.contents) {
      playlistContent = contentsRoot.playlist.playlist.contents
    } else if (contentsRoot?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer) {
      const musicQueue = contentsRoot.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer
      playlistContent = musicQueue.content?.playlistPanelRenderer?.contents || musicQueue.contents
    }

    if (!playlistContent || playlistContent.length === 0) {
      logger(
        'debug',
        `youtube-${this.name}`,
        `Playlist structure keys: ${Object.keys(playlistResponse.contents || {}).join(', ')}`
      )
      if (contentsRoot?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer) {
        const musicQueue = contentsRoot.tabbedRenderer.watchNextTabbedResultsRenderer.tabs[0].tabRenderer.content.musicQueueRenderer
        logger(
          'debug',
          `youtube-${this.name}`,
          `musicQueueRenderer keys: ${Object.keys(musicQueue).join(', ')}`
        )
      }
      logger(
        'info',
        `youtube-${this.name}`,
        `Playlist ${playlistId} is empty or inaccessible.`
      )
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
          {
            fetchChannelInfo: false,
            resolveExternalLinks: false
          }
        )
        if (track) {
          tracks.push(track)
          if (currentVideoId && track.info?.identifier === currentVideoId) {
            selectedTrack = i
          }
        }
      } catch (err) {
        logger(
          'warn',
          `youtube-${this.name}`,
          `Failed to build track: ${err.message}`
        )
      }
    }

    if (tracks.length === 0) {
      logger(
        'info',
        `youtube-${this.name}`,
        `No valid tracks parsed from playlist ${playlistId}.`
      )
      return { loadType: 'empty', data: {} }
    }

    const playlistTitle =
      contentsRoot.playlist?.playlist?.title || 'Unknown Playlist'

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack },
        pluginInfo: {},
        tracks
      }
    }
  }

  async _handleBrowsePlaylistResponse(
    playlistId,
    browseResponse,
    sourceName,
    context
  ) {
    if (browseResponse?.error) {
      const errMsg = browseResponse?.error?.message || 'Failed to browse playlist.'
      logger('error', `youtube-${this.name}`, `Error browsing playlist ${playlistId}: ${errMsg}`)
      return {
        loadType: 'error',
        data: { message: errMsg, severity: 'common', cause: 'Upstream' }
      }
    }

    const shelf = browseResponse.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer
    
    if (!shelf || !shelf.contents || shelf.contents.length === 0) {
      logger('info', `youtube-${this.name}`, `Browse playlist ${playlistId} is empty or inaccessible.`)
      return { loadType: 'empty', data: {} }
    }

    const tracks = []
    const maxLength = this.config.maxAlbumPlaylistLength || 100

    for (let i = 0; i < Math.min(shelf.contents.length, maxLength); i++) {
      const item = shelf.contents[i]
      try {
        const track = await buildTrack(
          item,
          sourceName || 'ytmusic',
          sourceName,
          browseResponse,
          this.config.enableHoloTracks,
          {
            fetchChannelInfo: false,
            resolveExternalLinks: false
          }
        )
        if (track) {
          tracks.push(track)
        }
      } catch (err) {
        logger('warn', `youtube-${this.name}`, `Failed to build track: ${err.message}`)
      }
    }

    if (tracks.length === 0) {
      logger('info', `youtube-${this.name}`, `No valid tracks parsed from browse playlist ${playlistId}.`)
      return { loadType: 'empty', data: {} }
    }

    const playlistTitle = browseResponse.header?.musicDetailHeaderRenderer?.title?.runs?.[0]?.text || 
                         browseResponse.header?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicDetailHeaderRenderer?.title?.runs?.[0]?.text ||
                         'Unknown Playlist'

    return {
      loadType: 'playlist',
      data: {
        info: { name: playlistTitle, selectedTrack: 0 },
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
    const apiEndpoint = this.getApiEndpoint()

    switch (urlType) {
      case YOUTUBE_CONSTANTS.VIDEO:
      case YOUTUBE_CONSTANTS.SHORTS: {
        const idPattern = /(?:v=|shorts\/|youtu\.be\/)([^&?]+)/
        const videoIdMatch = url.match(idPattern)
        if (!videoIdMatch || !videoIdMatch[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
            `Could not parse video ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            data: {
              message: 'Invalid video URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }
        const videoId = videoIdMatch[1]

        const headers = this.oauth ? await this.getAuthHeaders() : {}
        const { body: playerResponse, statusCode } =
          await this._makePlayerRequest(
            videoId,
            context,
            headers,
            cipherManager
          )

        if (statusCode !== 200) {
          const message = `Failed to load video/short player data. Status: ${statusCode}`
          logger('error', `youtube-${this.name}`, message)
          return {
            loadType: 'error',
            data: { message, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlayerResponse(
          playerResponse,
          sourceName,
          videoId,
          context
        )
      }

      case YOUTUBE_CONSTANTS.PLAYLIST: {
        const playlistIdMatch = url.match(/[?&]list=([\w-]+)/)
        if (!playlistIdMatch || !playlistIdMatch[1]) {
          logger(
            'error',
            `youtube-${this.name}`,
            `Could not parse playlist ID from URL: ${url}`
          )
          return {
            loadType: 'error',
            data: {
              message: 'Invalid playlist URL.',
              severity: 'common',
              cause: 'Input'
            }
          }
        }

        const playlistId = playlistIdMatch[1]
        const videoIdMatch = url.match(/[?&]v=([\w-]+)/)
        const currentVideoId = videoIdMatch?.[1] ?? null

        const headers = this.oauth ? await this.getAuthHeaders() : {}
        const { body: playlistResponse, statusCode } = await makeRequest(
          `${apiEndpoint}/youtubei/v1/next`,
          {
            headers: {
              'User-Agent': this.getClient(context).userAgent,
              ...headers
            },
            body: {
              context: { client: this.getClient(context) },
              playlistId,
              contentCheckOk: true,
              racyCheckOk: true
            },
            method: 'POST',
            disableBodyCompression: true
          }
        )

        if (statusCode !== 200 || playlistResponse?.error) {
          const errMsg =
            playlistResponse?.error?.message ||
            `Failed to fetch playlist. Status: ${statusCode}`
          logger(
            'error',
            `youtube-${this.name}`,
            `Error loading playlist ${playlistId}: ${errMsg}`
          )
          return {
            loadType: 'error',
            data: { message: errMsg, severity: 'common', cause: 'Upstream' }
          }
        }

        return await this._handlePlaylistResponse(
          playlistId,
          currentVideoId,
          playlistResponse,
          sourceName,
          context
        )
      }

      default:
        return { loadType: 'empty', data: {} }
    }
  }

  async getTrackUrl(decodedTrack, context, cipherManager) {
    const sourceName = decodedTrack.sourceName || 'youtube'
    const apiEndpoint = this.getApiEndpoint()
    logger(
      'debug',
      `youtube-${this.name}`,
      `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`
    )

    const headers = this.oauth ? await this.getAuthHeaders() : {}
    const { body: playerResponse, statusCode } = await this._makePlayerRequest(
      decodedTrack.identifier,
      context,
      headers,
      cipherManager
    )

    if (statusCode !== 200) {
      const message = `Failed to get player data for stream. Status: ${statusCode}`
      logger('error', `youtube-${this.name}`, message)
      return { exception: { message, severity: 'common', cause: 'Upstream' } }
    }

    return await this._extractStreamData(
      playerResponse,
      decodedTrack,
      context,
      cipherManager
    )
  }
}
