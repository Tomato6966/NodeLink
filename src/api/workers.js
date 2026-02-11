import { sendErrorResponse, sendResponse } from '../utils.ts'

const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function getEndpointConfig(nodelink) {
  const endpoint = nodelink.options?.cluster?.endpoint || {}
  const code =
    typeof endpoint.code === 'string' && endpoint.code.length > 0
      ? endpoint.code
      : 'CAPYBARA'

  return {
    patchEnabled: endpoint.patchEnabled === true,
    allowExternalPatch: endpoint.allowExternalPatch === true,
    code
  }
}

function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function resolveWorkerId(manager, payload) {
  const clusterId = normalizeNumber(payload.clusterId)
  if (clusterId !== null && manager.workersById.has(clusterId)) {
    return clusterId
  }

  const uniqueId = normalizeNumber(payload.id)
  if (uniqueId !== null) {
    for (const [id, workerUniqueId] of manager.workerUniqueId.entries()) {
      if (workerUniqueId === uniqueId) return id
    }
  }

  const pid = normalizeNumber(payload.pid)
  if (pid !== null) {
    const worker = manager.workers.find((entry) => entry?.process?.pid === pid)
    if (worker) return worker.id
  }

  return null
}

function handleGet(nodelink, req, res) {
  const manager = nodelink.workerManager
  if (!manager) return sendResponse(req, res, [], 200)

  const metrics = manager.getWorkerMetrics()
  const workers = Object.entries(metrics).map(([id, data]) => ({
    id: Number(id),
    ...data
  }))

  return sendResponse(req, res, workers, 200)
}

function handlePatch(nodelink, req, res, parsedUrl) {
  const manager = nodelink.workerManager
  if (!manager) {
    return sendErrorResponse(
      req,
      res,
      409,
      'Conflict',
      'Cluster workers are not enabled.',
      parsedUrl.pathname
    )
  }

  const endpointConfig = getEndpointConfig(nodelink)
  if (!endpointConfig.patchEnabled) {
    return sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'Workers patch endpoint is disabled.',
      parsedUrl.pathname
    )
  }

  const remoteAddress = req.socket?.remoteAddress || ''
  if (!endpointConfig.allowExternalPatch && !LOOPBACKS.has(remoteAddress)) {
    return sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'External access to the workers patch endpoint is blocked.',
      parsedUrl.pathname
    )
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {}
  if (payload.code !== endpointConfig.code) {
    return sendErrorResponse(
      req,
      res,
      403,
      'Forbidden',
      'Invalid workers patch code.',
      parsedUrl.pathname
    )
  }

  const workerId = resolveWorkerId(manager, payload)
  if (!workerId) {
    return sendErrorResponse(
      req,
      res,
      400,
      'Bad Request',
      'Worker identifier is required.',
      parsedUrl.pathname
    )
  }

  const worker = manager.workersById.get(workerId)
  if (!worker) {
    return sendErrorResponse(
      req,
      res,
      404,
      'Not Found',
      'Worker not found.',
      parsedUrl.pathname
    )
  }

  const uniqueId = manager.workerUniqueId.get(workerId) || workerId
  const pid = worker.process?.pid || null

  manager.removeWorker(workerId)

  return sendResponse(
    req,
    res,
    {
      killed: true,
      id: uniqueId,
      clusterId: workerId,
      pid
    },
    200
  )
}

function handler(nodelink, req, res, _sendResponse, parsedUrl) {
  if (req.method === 'GET') return handleGet(nodelink, req, res)
  if (req.method === 'PATCH') return handlePatch(nodelink, req, res, parsedUrl)

  return sendErrorResponse(
    req,
    res,
    405,
    'Method Not Allowed',
    'Method must be GET or PATCH.',
    parsedUrl.pathname
  )
}

export default {
  handler,
  methods: ['GET', 'PATCH']
}
