import { sendResponse } from '../utils.ts'

function handler(nodelink, req, res) {
  if (!nodelink.connectionManager) {
    return sendResponse(
      req,
      res,
      {
        status: 'disabled',
        metrics: null,
        reason: 'connection_manager_unavailable_in_this_process'
      },
      200
    )
  }

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
