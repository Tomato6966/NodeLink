import { decodeTrack, sendResponse } from '../utils.js'

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  const encodedTrack = parsedUrl.searchParams.get('encodedTrack')
  if (!encodedTrack) {
    return sendResponse(req, res, {
      timestamp: Date.now(),
      status: 400,
      error: 'Bad Request',
      message: 'Missing encodedTrack parameter.',
      path: parsedUrl.pathname
    }, 400)
  }

  try {
    const decodedTrack = decodeTrack(encodedTrack)
    if (!decodedTrack) {
      return sendResponse(req, res, {
        timestamp: Date.now(),
        status: 400,
        error: 'Bad Request',
        message: 'The provided track is invalid.',
        path: parsedUrl.pathname
      }, 400)
    }

    const lyricsData = await nodelink.lyrics.loadLyrics(decodedTrack)

    sendResponse(req, res, lyricsData, 200)
  } catch (error) {
    sendResponse(req, res, {
      timestamp: Date.now(),
      status: 500,
      error: 'Internal Server Error',
      message: error.message || 'Failed to load lyrics.',
      trace: new Error().stack,
      path: parsedUrl.pathname
    }, 500)
  }
}

export default {
  handler
}
