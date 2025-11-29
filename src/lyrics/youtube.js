import { logger, makeRequest } from '../utils.js'

export default class YouTubeLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  async getLyrics(trackInfo, language) {
    const resolvedTrack = await this.nodelink.sources.resolve(
      trackInfo.uri,
      trackInfo.sourceName
    )

    if (
      resolvedTrack.loadType !== 'track' ||
      !resolvedTrack.data.pluginInfo?.captions
    ) {
      logger(
        'debug',
        'Lyrics',
        `No captions found for ${trackInfo.title} after resolving.`
      )
      return { loadType: 'empty', data: {} }
    }

    const captionTracks =
      resolvedTrack.data.pluginInfo.captions.playerCaptionsTracklistRenderer
        .captionTracks
    if (!captionTracks || captionTracks.length === 0) {
      return { loadType: 'empty', data: {} }
    }

    const langs = captionTracks.map((c) => ({
      code: c.languageCode,
      name: c.name.simpleText,
      isTranslatable: c.isTranslatable
    }))

    let trackLang

    if (language) {
      trackLang = captionTracks.find((c) => c.languageCode === language)

      if (!trackLang) {
        const defaultTrack =
          captionTracks.find((c) => c.languageCode.startsWith('en')) ||
          captionTracks.find((c) => c.kind !== 'asr') ||
          captionTracks[0]

        if (defaultTrack && defaultTrack.isTranslatable) {
          trackLang = {
            ...defaultTrack,
            languageCode: language,
            baseUrl: `${defaultTrack.baseUrl}&tlang=${language}`,
            name: {
              simpleText: `${defaultTrack.name.simpleText} (Translated to ${language})`
            }
          }
        }
      }
    }

    if (!trackLang) {
      trackLang =
        captionTracks.find((c) => c.languageCode.startsWith('en')) ||
        captionTracks.find((c) => c.kind !== 'asr') ||
        captionTracks[0]
    }

    const {
      body: lyrics,
      error,
      statusCode
    } = await makeRequest(
      trackLang.baseUrl.replace('&fmt=srv3', '&fmt=json3'),
      { method: 'GET' }
    )

    if (error || statusCode !== 200) {
      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics content from ${trackLang.baseUrl}: ${error?.message || statusCode}`
      )
      return { loadType: 'empty', data: {} }
    }

    const lines = lyrics.events
      .map((event) => {
        const text = event.segs?.map((seg) => seg.utf8).join('') || ''
        return {
          text: text
            .replace(/&amp;#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&'),
          time: event.tStartMs,
          duration: event.dDurationMs || 0
        }
      })
      .filter((line) => line.text.trim().length > 0)

    return {
      loadType: 'lyrics',
      data: {
        name: trackLang.name.simpleText,
        synced: true,
        lang: trackLang.languageCode,
        lines,
        langs
      }
    }
  }
}
