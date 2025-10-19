import { sendResponse } from '../utils.js'

function handler(nodelink, req, res) {
  const status = nodelink.connectionManager.status
  const metrics = nodelink.connectionManager.metrics

  const response = {
    status,
    metrics
  }

  sendResponse(req, res, response, 200)
}

export default {
  handler
}
