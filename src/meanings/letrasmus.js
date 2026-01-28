import { translateMany, translateText } from '../modules/googleTranslate.js'
import { getBestMatch, http1makeRequest, logger } from '../utils.js'

const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/'

const cleanText = (text) => {
  if (!text) return ''
  return text
    .replace(/\s*\([^)]*\)/g, ' ')
    .replace(/\s*\[[^\]]*\]/g, ' ')
    .replace(
      /\b(official|video|audio|mv|visualizer|live|session|ao vivo|lyric|lyrics|hd|4k|remix|edit|cover|acoustic|instrumental)\b/gi,
      ' '
    )
    .replace(/feat\.?/gi, ' ')
    .replace(/ft\.?/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const buildSearchCandidates = (trackInfo) => {
  const candidates = new Set()
  const rawTitle = trackInfo?.title || ''
  const rawAuthor = trackInfo?.author || ''

  const cleanedTitle = cleanText(rawTitle)
  const cleanedAuthor = cleanText(rawAuthor)

  const pushCandidate = (title, author) => {
    const t = cleanText(title)
    const a = cleanText(author)
    const combined = [t, a].filter(Boolean).join(' ').trim()
    if (combined) candidates.add(combined)
  }

  const rawTitleLower = rawTitle.toLowerCase()
  const rawAuthorLower = rawAuthor.toLowerCase()

  if (cleanedTitle || cleanedAuthor) {
    pushCandidate(cleanedTitle, cleanedAuthor)
  }

  if (cleanedTitle) candidates.add(cleanedTitle)

  const splitTitle = (title, sep) => {
    if (!title.includes(sep)) return null
    const parts = title.split(sep).map((part) => part.trim())
    if (parts.length < 2) return null
    return [parts[0], parts.slice(1).join(sep).trim()]
  }

  const dashSplit = splitTitle(rawTitle, ' - ')
  if (dashSplit) {
    const [left, right] = dashSplit
    const leftClean = cleanText(left)
    const rightClean = cleanText(right)

    if (rightClean) {
      pushCandidate(rightClean, cleanedAuthor || leftClean)
      candidates.add(rightClean)
    }

    if (leftClean && rightClean) {
      pushCandidate(rightClean, leftClean)
    }
  }

  const pipeSplit = splitTitle(rawTitle, ' | ')
  if (pipeSplit) {
    const [left, right] = pipeSplit
    const leftClean = cleanText(left)
    const rightClean = cleanText(right)
    if (leftClean) candidates.add(leftClean)
    if (rightClean) candidates.add(rightClean)
    if (leftClean && cleanedAuthor) pushCandidate(leftClean, cleanedAuthor)
  }

  if (rawAuthorLower && rawTitleLower.includes(rawAuthorLower)) {
    const stripped = cleanText(rawTitle.replace(new RegExp(rawAuthor, 'ig'), ''))
    if (stripped) {
      pushCandidate(stripped, cleanedAuthor)
      candidates.add(stripped)
    }
  }

  if (cleanedAuthor) {
    pushCandidate(cleanedTitle, cleanedAuthor)
    candidates.add(cleanedAuthor)
  }

  return Array.from(candidates)
}

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

  let out = text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

  out = out.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number(dec)
    if (!Number.isFinite(code)) return _
    return String.fromCodePoint(code)
  })

  out = out.replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    const code = parseInt(hex, 16)
    if (!Number.isFinite(code)) return _
    return String.fromCodePoint(code)
  })

  return out
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
    this.priority = 70
  }

  async setup() {
    return true
  }

  async getMeaning(trackInfo, language) {
    try {
      let candidates = []
      if (trackInfo.sourceName === 'letrasmus') {
        candidates = [{ info: trackInfo }]
      } else {
        const searchCandidates = buildSearchCandidates(trackInfo)
        let results = []

        for (const query of searchCandidates) {
          results = await searchLetras(query, 12)
          if (results.length) break
        }

        if (results.length) {
          const matchTarget = {
            ...trackInfo,
            title: cleanText(trackInfo.title),
            author: cleanText(trackInfo.author)
          }
          const best = getBestMatch(results, matchTarget)
          const ordered = []
          if (best?.info) ordered.push(best)
          for (const item of results) {
            if (!best || item.info.uri !== best.info?.uri) ordered.push(item)
          }
          candidates = ordered
        }
      }

      if (!candidates.length) {
        return { loadType: 'empty', data: {} }
      }

      let body = null
      let meaningUrl = null
      let resolvedTrack = null

      for (const candidate of candidates) {
        const letrasTrack = candidate.info
        if (!letrasTrack?.uri || letrasTrack.sourceName !== 'letrasmus') continue

        const baseUrl = letrasTrack.uri.endsWith('/')
          ? letrasTrack.uri
          : `${letrasTrack.uri}/`
        const url = `${baseUrl}significado.html`
        const { body: fetchedBody, statusCode, error } =
          await http1makeRequest(url, { method: 'GET' })

        if (error || statusCode !== 200 || !fetchedBody) continue

        const meaningCheck = extractMeaning(fetchedBody)
        if (!meaningCheck.body.length) continue

        body = fetchedBody
        meaningUrl = url
        resolvedTrack = letrasTrack
        break
      }

      if (!body || !meaningUrl || !resolvedTrack) {
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
            meaning.body.map(decodeHtml),
            sourceLang,
            language
          )
          const translatedTitle = meaning.title
            ? await translateText(decodeHtml(meaning.title), sourceLang, language)
            : null
          const translatedDescription = ogDescription
            ? await translateText(decodeHtml(ogDescription), sourceLang, language)
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
            title: omq?.Name || resolvedTrack.title || null,
            artist: omq?.Artist || resolvedTrack.author || null,
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
