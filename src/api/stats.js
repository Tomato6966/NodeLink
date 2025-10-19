import { getStats } from '../utils.js'

function handler(nodelink, req, res, sendResponse) {
  const payload = getStats(nodelink)
  const detailedStats = nodelink.statsManager.getSnapshot()

  const finalPayload = {
    ...payload,
    detailedStats
  }

  sendResponse(req, res, finalPayload, 200)
}

export default { handler }
