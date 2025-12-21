import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATH_VERSION } from '../constants.js'
import {
  logger,
  sendResponse,
  verifyMethod,
  sendErrorResponse
} from '../utils.js'

let apiRegistry
try {
  const mod = await import('../registry.js')
  apiRegistry = mod.apiRegistry
} catch {}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function loadRoutes() {
  const staticRoutes = new Map()
  const dynamicRoutes = []
  let routeModules = []

  if (apiRegistry) {
    routeModules = Object.entries(apiRegistry).map(
      ([file, mod]) => ({
        file,
        module: mod.default || mod
      })
    )
  }

  if (routeModules.length === 0) {
    try {
      const routeFiles = await fs.readdir(__dirname)
      for (const file of routeFiles) {
        if (file !== 'index.js' && file.endsWith('.js')) {
          const filePath = join(__dirname, file)
          const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
          const routeModule = await import(fileUrl)
          routeModules.push({ file, module: routeModule.default })
        }
      }
    } catch {}
  }

  for (const { file, module } of routeModules) {
    const routeName = file.replace('.js', '').toLowerCase()
    let pathname

    if (routeName === 'version') {
      pathname = '/version'
    } else if (routeName.includes('.')) {
      const parts = routeName.split('.')
      const basePattern = parts
        .map((part) => (part === 'id' ? '(?:id|[A-Za-z0-9]+)' : part))
        .join('/')
      pathname = new RegExp(
        `^/${PATH_VERSION}/${basePattern}(?:/[A-Za-z0-9]+)?/?$`
      )
    } else {
      pathname = `/${PATH_VERSION}/${routeName}`
    }

    const routeData = {
      handler: module.handler,
      methods: module.methods || ['GET']
    }

    if (pathname instanceof RegExp) {
      dynamicRoutes.push([pathname, routeData])
    } else {
      staticRoutes.set(pathname, routeData)
    }
  }

  dynamicRoutes.sort((a, b) => b[0].source.length - a[0].source.length)

  return { staticRoutes, dynamicRoutes }
}

const routesPromise = loadRoutes()

async function requestHandler(nodelink, req, res) {
  const startTime = Date.now()
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`)

  const middlewares = nodelink.extensions?.middlewares
  if (middlewares && Array.isArray(middlewares)) {
    for (const middleware of middlewares) {
      const result = await middleware(nodelink, req, res, parsedUrl)
      if (result === true) return 
    }
  }

  nodelink.statsManager.incrementApiRequest(parsedUrl.pathname)
  const trace = parsedUrl.searchParams.get('trace') === 'true'
  const remoteAddress = req.socket.remoteAddress
  const isInternal = ['127.0.0.1', '::1', 'localhost'].includes(remoteAddress)
  const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${req.socket.remotePort})`

  const originalEnd = res.end
  res.end = function(...args) {
    const duration = Date.now() - startTime
    nodelink.statsManager.recordHttpRequestDuration(
      parsedUrl.pathname,
      req.method,
      res.statusCode,
      duration
    )
    originalEnd.apply(res, args)
  }

  const isMetricsEndpoint = parsedUrl.pathname === `/${PATH_VERSION}/metrics`
  if (isMetricsEndpoint) {
    const metricsConfig = nodelink.options.metrics || {}
    if (!metricsConfig.enabled) {
      logger(
        'warn',
        'Metrics',
        `Metrics endpoint disabled - ${clientAddress} attempted to access ${parsedUrl.pathname}`
      )
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
      return
    }

    const authConfig = metricsConfig.authorization || {}
    let authType = authConfig.type;
    if(!['Bearer', 'Basic'].includes(authType)) {
      logger('warn',`Config: metrics authorization.type SHOULD BE one of 'Bearer', 'Basic'.... Defaulting to 'Bearer'!`);
      authType = 'Bearer';
    }
    
    const metricsPassword = authConfig.password || nodelink.options.server.password

    const authHeader = req.headers?.authorization
    const isValidAuth =
      authHeader === metricsPassword
      || (authType === 'Bearer' && authHeader === `${authType} ${metricsPassword}`)
      || (authType === 'Basic' && authHeader === `${authType} ${atob(authHeader.slice(authType.length))}`)

    if (!isValidAuth) {
      logger(
        'warn',
        'Metrics',
        `Unauthorized metrics access attempt from ${clientAddress} - Invalid password provided`
      )
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('Unauthorized')
      return
    }
  }

  const dosCheck = nodelink.dosProtectionManager.check(req)
  if (!dosCheck.allowed) {
    logger(
      'warn',
      'DosProtection',
      `DoS protection triggered for ${clientAddress} on ${parsedUrl.pathname}`
    )
    nodelink.statsManager.incrementDosProtectionBlock(
      remoteAddress,
      dosCheck.message
    )
    sendErrorResponse(
      req,
      res,
      dosCheck.status,
      dosCheck.message,
      dosCheck.message,
      parsedUrl.pathname,
      trace
    )
    return
  }
  if (dosCheck.delay) {
    await new Promise((resolve) => setTimeout(resolve, dosCheck.delay))
  }

  if (!nodelink.rateLimitManager.check(req, parsedUrl)) {
    logger(
      'warn',
      'RateLimit',
      `Rate limit exceeded for ${clientAddress} on ${parsedUrl.pathname}`
    )
    nodelink.statsManager.incrementRateLimitHit(
      parsedUrl.pathname,
      remoteAddress
    )
    sendErrorResponse(
      req,
      res,
      429,
      'Too Many Requests',
      'You are sending too many requests. Please try again later.',
      parsedUrl.pathname,
      trace
    )
    return
  }

  if (!isMetricsEndpoint) {
    if (
      !req.headers ||
      req.headers.authorization !== nodelink.options.server.password &&
      req.headers.authorization !== `Bearer ${nodelink.options.server.password}`
    ) {
      logger(
        'warn',
        'Server',
        `Unauthorized connection attempt from ${clientAddress} - Invalid password provided`
      )

      res.writeHead(401, { 'Content-Type': 'text/plain' })
      res.end('Unauthorized')
      return
    }
  }

  let body = ''
  if (req.method !== 'GET') {
    await new Promise((resolve) => {
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          if (
            req.headers['content-type']?.includes('application/json') &&
            body
          ) {
            body = JSON.parse(body)
          }
        } catch (error) {
          logger(
            'error',
            'Server',
            `Failed to parse JSON body: ${error.message}. Path: ${parsedUrl.pathname}, Content-Type: ${req.headers['content-type'] || 'N/A'}, Raw Body: '${body}', Headers: ${JSON.stringify(req.headers)}`
          )
          sendErrorResponse(
            req,
            res,
            400,
            'Invalid JSON',
            error.message || 'Failed to parse JSON body',
            parsedUrl.pathname,
            trace
          )
          return
        }
        resolve()
      })
    })
  }
  req.body = body

  req.headers.authorization = '[REDACTED]'
  req.headers.host = '[REDACTED]'
  if (!isMetricsEndpoint) {
    logger(
      'info',
      'Request',
      `${req.method} | ${clientAddress} [${req.headers['user-agent']}] - ${parsedUrl.pathname} ${JSON.stringify(req.headers)}${req.body ? `\nBody: ${JSON.stringify(req.body)}` : ''}`
    )
  }

  const { staticRoutes, dynamicRoutes } = await routesPromise

  const staticRoute = staticRoutes.get(parsedUrl.pathname)
  if (staticRoute) {
    if (
      !verifyMethod(
        parsedUrl,
        req,
        res,
        staticRoute.methods,
        clientAddress,
        trace
      )
    )
      return
    staticRoute.handler(nodelink, req, res, sendResponse, parsedUrl)
    return
  }

  const customRoutes = nodelink.extensions?.routes
  if (customRoutes && Array.isArray(customRoutes)) {
    const customRoute = customRoutes.find(
      (r) => r.path === parsedUrl.pathname
    )

    if (customRoute) {
      if (
        !verifyMethod(
          parsedUrl,
          req,
          res,
          customRoute.method ? [customRoute.method] : ['GET'],
          clientAddress,
          trace
        )
      )
        return

      customRoute.handler(nodelink, req, res, sendResponse, parsedUrl)
      return
    }
  }

  for (const [regex, route] of dynamicRoutes) {
    if (regex.test(parsedUrl.pathname)) {
      if (
        !verifyMethod(parsedUrl, req, res, route.methods, clientAddress, trace)
      )
        return
      route.handler(nodelink, req, res, sendResponse, parsedUrl)
      return
    }
  }

  logger(
    'warn',
    'Request',
    `${req.method} | ${clientAddress} - ${parsedUrl.pathname} not found (response 404)`
  )
  sendErrorResponse(
    req,
    res,
    404,
    'Not Found',
    'The requested route was not found.',
    parsedUrl.pathname,
    trace
  )
}

export default requestHandler
