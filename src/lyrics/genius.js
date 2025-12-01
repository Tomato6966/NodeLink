import { logger, makeRequest } from '../utils.js'

const CLEAN_PATTERNS = [
  /\s*\([^)]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^)]*\)/gi,
  /\s*\[[^\]]*(?:official|lyrics?|video|audio|mv|visualizer|color\s*coded|hd|4k|prod\.)[^\]]*\]/gi,
  /\s*-\s*Topic$/i,
  /VEVO$/i
]

export default class GeniusLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  async getLyrics(trackInfo) {
    let title = trackInfo.title
    let author = trackInfo.author

    for (const pattern of CLEAN_PATTERNS) {
      title = title.replace(pattern, '')
      author = author.replace(pattern, '')
    }

    title = title.trim()
    author = author.trim()

    let query
    if (title.toLowerCase().startsWith(author.toLowerCase())) {
      query = title
    } else {
      query = `${title} ${author}`
    }

    logger('debug', 'Lyrics', `Searching Genius for: ${query}`)

    try {
      const { body: searchData } = await makeRequest(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`,
        {
          method: 'GET'
        }
      )

      const song = searchData.response.sections.find((s) => s.type === 'song')
        ?.hits[0]?.result

      if (!song) {
        return { loadType: 'empty', data: {} }
      }

      const { body: songPage } = await makeRequest(
        `https://genius.com${song.path}`,
        { method: 'GET' }
      )

      const lyricsData = songPage.match(
        /window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\('(.*)'\);/
      )
      if (!lyricsData || !lyricsData[1]) {
        return { loadType: 'empty', data: {} }
      }

      const lyricsJson = JSON.parse(lyricsData[1].replace(/\\(.)/g, '$1'))
      const lyricsContent = lyricsJson.songPage?.lyricsData?.body?.html
      if (!lyricsContent) {
        return { loadType: 'empty', data: {} }
      }

      const lines = lyricsContent
        .replace(/<br>/g, '\n')
        .replace(/<[^>]*>/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line)

      return {
        loadType: 'lyrics',
        data: {
          name: 'original',
          synced: false,
          lines: lines.map((text) => ({ text, time: 0, duration: 0 }))
        }
      }
    } catch (e) {
      logger(
        'error',
        'Lyrics',
        `Failed to fetch lyrics from Genius: ${e.message}`
      )
      return {
        loadType: 'error',
        data: { message: e.message, severity: 'fault' }
      }
    }
  }
}
