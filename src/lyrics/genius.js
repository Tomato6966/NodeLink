import { makeRequest, logger } from '../utils.js'

export default class GeniusLyrics {
  constructor(nodelink) {
    this.nodelink = nodelink
  }

  async setup() {
    return true
  }

  async getLyrics(trackInfo) {
    const query = `${trackInfo.title} ${trackInfo.author}`
    logger('lyrics', 'debug', `Searching Genius for: ${query}`)

    try {
      const { body: searchData } = await makeRequest(`https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`, {
        method: 'GET'
      })

      const song = searchData.response.sections.find(s => s.type === 'song')?.hits[0]?.result

      if (!song) {
        return { loadType: 'empty', data: {} }
      }

      const { body: songPage } = await makeRequest(`https://genius.com${song.path}`, { method: 'GET' })

      const lyricsData = songPage.match(/JSON.parse\('(.*)'\);/)
      if (!lyricsData || !lyricsData[1]) {
        return { loadType: 'empty', data: {} }
      }

      const lyricsJson = JSON.parse(lyricsData[1].replace(/\\(.)/g, '$1'))
      const lyricsContent = lyricsJson.songPage.lyricsData.body.html

      const lines = lyricsContent
        .replace(/<br>/g, '\n')
        .replace(/<[^>]*>/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line)

      return {
        loadType: 'lyrics',
        data: {
          name: 'original',
          synced: false,
          lines: lines.map(text => ({ text, time: 0, duration: 0 }))
        }
      }
    } catch (e) {
      logger('lyrics', 'error', `Failed to fetch lyrics from Genius: ${e.message}`)
      return { loadType: 'error', data: { message: e.message, severity: 'fault' } }
    }
  }
}