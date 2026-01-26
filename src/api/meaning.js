import myzod from 'myzod'
import { translateMany, translateText } from '../modules/googleTranslate.js'
import {
  decodeTrack,
  http1makeRequest,
  logger,
  sendErrorResponse
} from '../utils.js'

const meaningSchema = myzod.object({
  encodedTrack: myzod.string(),
  lang: myzod.string().optional()
})

const decodeHtml = (text) => {
  if (!text) return text
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const extractMeta = (html, property) => {
  const re1 = new RegExp(
    `<meta[^>]+property=[\"']${property}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>`,
    'i'
  )
  const re2 = new RegExp(
    `<meta[^>]+content=[\"']([^\"']+)[^>]+property=[\"']${property}[\"'][^>]*>`,
    'i'
  )
  const match = html.match(re1) || html.match(re2)
  return match ? decodeHtml(match[1]) : null
}

const extractOmqLyric = (html) => {
  const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

const extractOmqMeaning = (html) => {
  const match = html.match(
    /_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,\s*({[\s\S]*?})\s*,/i
  )
  if (!match) return null
  try {
    return JSON.parse(match[2])
  } catch {
    return null
  }
}

const extractMeaning = (html) => {
  const match = html.match(/<div class="lyric-meaning[^>]*">([\s\S]*?)<\/div>/i)
  if (!match) return { title: null, body: [] }
  let block = match[1]
  const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
  const title = titleMatch ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, '')) : null
  block = block.replace(/<h3[^>]*>[\s\S]*?<\/h3>/i, '')
  const paragraphs = []
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let pMatch
  while ((pMatch = pRegex.exec(block))) {
    let text = pMatch[1]
    text = text.replace(/<br\s*\/?>/gi, '\n')
    text = text.replace(/<[^>]+>/g, '')
    text = decodeHtml(text)
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length) paragraphs.push(lines.join(' '))
  }
  if (!paragraphs.length) {
    let text = block.replace(/<br\s*\/?>/gi, '\n')
    text = text.replace(/<[^>]+>/g, '')
    text = decodeHtml(text)
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length) paragraphs.push(lines.join(' '))
  }
  return { title, body: paragraphs }
}

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const result = meaningSchema.try({
    encodedTrack: parsedUrl.searchParams.get('encodedTrack'),
    lang: parsedUrl.searchParams.get('lang') || 'en'
  })

  if (result instanceof myzod.ValidationError) {
    const errorMessage = result.message || 'encodedTrack parameter is required.'
    logger('warn', 'Meaning', errorMessage)
    return sendErrorResponse(
      req,
      res,
      400,
      'missing encodedTrack parameter',
      errorMessage,
      parsedUrl.pathname,
      true
    )
  }

  let decodedTrack
  const targetLang = result.lang
  try {
    decodedTrack = decodeTrack(result.encodedTrack.replace(/ /g, '+'))
  } catch (err) {
    logger('warn', 'Meaning', `Invalid encoded track: ${err.message}`)
    return sendErrorResponse(
      req,
      res,
      400,
      'invalid encodedTrack',
      err.message,
      parsedUrl.pathname,
      true
    )
  }

  try {
    let trackInfo = decodedTrack.info
    if (nodelink.sources?.resolve && decodedTrack.info?.uri) {
      const resolved = await nodelink.sources.resolve(decodedTrack.info.uri)
      if (resolved.loadType !== 'track') {
        return sendResponse(
          req,
          res,
          { loadType: 'empty', data: {} },
          200
        )
      }
      trackInfo = resolved.data?.info || resolved.data
    }

    if (!trackInfo || trackInfo.sourceName !== 'letrasmus') {
      return sendResponse(
        req,
        res,
        { loadType: 'empty', data: {} },
        200
      )
    }

    const baseUrl = trackInfo.uri?.endsWith('/')
      ? trackInfo.uri
      : `${trackInfo.uri}/`
    const meaningUrl = `${baseUrl}significado.html`
    const { body, statusCode, error } = await http1makeRequest(meaningUrl, {
      method: 'GET'
    }).catch((e) => ({ error: e }))

    if (error || statusCode !== 200 || !body) {
      return sendResponse(
        req,
        res,
        { loadType: 'empty', data: {} },
        200
      )
    }

    const meaning = extractMeaning(body)
    const omq = extractOmqLyric(body)
    const meaningMeta = extractOmqMeaning(body)
    const ogImage = extractMeta(body, 'og:image')
    const ogTitle = extractMeta(body, 'og:title')
    const ogDescription = extractMeta(body, 'og:description')

    let translated = null
    if (targetLang) {
      const sourceLang = 'pt'
      try {
        const translatedParagraphs = await translateMany(
          meaning.body,
          sourceLang,
          targetLang
        )
        const translatedTitle = meaning.title
          ? await translateText(meaning.title, sourceLang, targetLang)
          : null
        const translatedDescription = ogDescription
          ? await translateText(ogDescription, sourceLang, targetLang)
          : null
        translated = {
          language: {
            source: sourceLang,
            target: targetLang
          },
          title: translatedTitle?.translation || null,
          description: translatedDescription?.translation || null,
          paragraphs: translatedParagraphs
        }
      } catch (e) {
        logger('warn', 'Meaning', `Translate failed: ${e.message}`)
      }
    }

    return sendResponse(req, res, {
      loadType: meaning.body.length ? 'meaning' : 'empty',
      data: {
        title: meaning.title || ogTitle || null,
        description: ogDescription || null,
        paragraphs: meaning.body,
        translation: translated,
        url: meaningUrl,
        meaningMeta: {
          id: meaningMeta?.ID || null,
          localeId: meaningMeta?.LocaleID || null,
          origin: meaningMeta?.Origin || null,
          submittedBy: null,
          reviewedBy: null
        },
        song: {
          title: omq?.Name || trackInfo.title || null,
          artist: omq?.Artist || trackInfo.author || null,
          youtubeId: omq?.YoutubeID || null,
          letrasId: omq?.ID || null,
          artworkUrl: ogImage || trackInfo.artworkUrl || null
        }
      }
    }, 200)
  } catch (err) {
    logger('error', 'Meaning', `Failed to load meaning: ${err.message}`)
    return sendErrorResponse(
      req,
      res,
      500,
      'failed to load meaning',
      err.message || 'Failed to load meaning',
      parsedUrl.pathname,
      true
    )
  }
}

export default {
  handler
}
