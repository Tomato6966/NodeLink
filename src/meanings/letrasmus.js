import { translateMany, translateText } from '../modules/googleTranslate.js'
import {
  getBestMatch,
  http1makeRequest,
  logger
} from '../utils.js'

const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/'

const parseJsonp = (body) => {
  if (!body) return null
  const trimmed = body.trim()
  if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
    return JSON.parse(trimmed.slice('LetrasSug('.length, -1))
  }
  const start = trimmed.indexOf('(')
  const end = trimmed.lastIndexOf(')')
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start + 1, end))
  }
  return JSON.parse(trimmed)
}

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
  const title = titleMatch
    ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, ''))
    : null
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

const buildLetrasTrackInfo = (doc) => {
  const uri = `https://www.letras.mus.br/${doc.dns}/${doc.url}/`
  return {
    title: doc.txt || 'Unknown',
    author: doc.art || 'Unknown',
    length: 0,
    uri,
    sourceName: 'letrasmus'
  }
}

const searchLetras = async (query, limit = 10) => {
  const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`
  const { body, statusCode, error } = await http1makeRequest(url, {
    method: 'GET'
  })
  if (error || statusCode !== 200 || !body) return []
  const parsed = parseJsonp(body)
  const docs = parsed?.response?.docs || []
  return docs
    .filter((doc) => doc?.t === '2' && doc?.dns && doc?.url)
    .slice(0, limit)
    .map((doc) => ({ info: buildLetrasTrackInfo(doc) }))
}

export default class LetrasMusMeaning {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  async getMeaning(trackInfo, language) {
    try {
      let letrasTrack = trackInfo
      if (trackInfo.sourceName !== 'letrasmus') {
        const query = `${trackInfo.title} ${trackInfo.author}`.trim()
        const results = await searchLetras(query, 10)
        if (results.length) {
          const best = getBestMatch(results, trackInfo)
          if (best?.info) {
            letrasTrack = best.info
          }
        }
      }

      if (!letrasTrack?.uri || letrasTrack.sourceName !== 'letrasmus') {
        return { loadType: 'empty', data: {} }
      }

      const baseUrl = letrasTrack.uri.endsWith('/')
        ? letrasTrack.uri
        : `${letrasTrack.uri}/`
      const meaningUrl = `${baseUrl}significado.html`
      const { body, statusCode, error } = await http1makeRequest(meaningUrl, {
        method: 'GET'
      })
      if (error || statusCode !== 200 || !body) {
        return { loadType: 'empty', data: {} }
      }

      const meaning = extractMeaning(body)
      const omq = extractOmqLyric(body)
      const meaningMeta = extractOmqMeaning(body)
      const ogImage = extractMeta(body, 'og:image')
      const ogTitle = extractMeta(body, 'og:title')
      const ogDescription = extractMeta(body, 'og:description')

      let translated = null
      if (language) {
        const sourceLang = 'pt'
        try {
          const translatedParagraphs = await translateMany(
            meaning.body,
            sourceLang,
            language
          )
          const translatedTitle = meaning.title
            ? await translateText(meaning.title, sourceLang, language)
            : null
          const translatedDescription = ogDescription
            ? await translateText(ogDescription, sourceLang, language)
            : null
          translated = {
            language: {
              source: sourceLang,
              target: language
            },
            title: translatedTitle?.translation || null,
            description: translatedDescription?.translation || null,
            paragraphs: translatedParagraphs
          }
        } catch (e) {
          logger('warn', 'Meaning', `Translate failed: ${e.message}`)
        }
      }

      return {
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
            title: omq?.Name || letrasTrack.title || null,
            artist: omq?.Artist || letrasTrack.author || null,
            youtubeId: omq?.YoutubeID || null,
            letrasId: omq?.ID || null,
            artworkUrl: ogImage || null
          }
        }
      }
    } catch (e) {
      logger('error', 'Meaning', `Letras meaning error: ${e.message}`)
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
