import { getStats } from '../utils.js'

function handler(nodelink, req, res, sendResponse) {
  const payload = getStats(nodelink)
  sendResponse(req, res, payload, 200)
}

export default { handler }
