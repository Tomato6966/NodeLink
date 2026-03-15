import { logger, makeRequest } from '../utils.ts'

export default class WikipediaMeaning {
  constructor(nodelink) {
    this.nodelink = nodelink
    this.priority = 90
  }

  async setup() {
    return true
  }

  _cleanText(text) {
    if (!text) return ''
    return text.replace(/<!--[\s\S]*?-->/g, '').trim()
  }

  async getMeaning(trackInfo, language) {
    const lang = language || 'en'
    const queries = []

    if (trackInfo.title) {
      queries.push({ type: 'track', query: `${trackInfo.title} (song)` })
      queries.push({ type: 'track', query: trackInfo.title })
    }

    if (trackInfo.author) {
      queries.push({ type: 'artist', query: trackInfo.author })
    }

    for (const item of queries) {
      const { type, query } = item
      const encodedQuery = encodeURIComponent(query)
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|description&titles=${encodedQuery}&redirects=1&explaintext=1`

      try {
        const { body, statusCode } = await makeRequest(url, { method: 'GET' })

        if (statusCode !== 200 || !body || !body.query || !body.query.pages) {
          continue
        }

        const pages = body.query.pages
        const pageId = Object.keys(pages)[0]

        if (pageId === '-1') continue

        const page = pages[pageId]
        const extract = this._cleanText(page.extract)

        if (extract && extract.length > 0 && extract !== '\n') {
          return {
            loadType: 'meaning',
            data: {
              title: page.title,
              description: page.description || null,
              paragraphs: extract
                .split('\n')
                .filter((line) => line.trim().length > 0),
              url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
              provider: 'wikipedia',
              type: type
            }
          }
        }
      } catch (e) {
        logger(
          'debug',
          'WikipediaMeaning',
          `Failed to fetch for query "${query}": ${e.message}`
        )
      }
    }

    return { loadType: 'empty', data: {} }
  }
}
