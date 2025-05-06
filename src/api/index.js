import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { logger, sendResponse, verifyMethod } from '../utils.js'
import fs from 'node:fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function loadRoutes() {
  const routeFiles = await fs.readdir(__dirname)
  const routeMap = new Map()

  for (const file of routeFiles) {
    if (file !== 'index.js' && file.endsWith('.js')) {
      const routeName = file.replace('.js', '')
      let pathname

      if (routeName === 'version') {
        pathname = '/version'
      } else if (routeName.includes('.')) {
        const parts = routeName.split('.')
        pathname = new RegExp(
          `^/v4/${parts.map(part => (part === 'id' ? '[A-Za-z0-9]+' : part)).join('/')}$`
        )
      } else {
        pathname = `/v4/${routeName}`
      }

      const filePath = join(__dirname, file)
      const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`)
      const routeModule = await import(fileUrl)

      routeMap.set(pathname, {
        handler: routeModule.default.handler,
        methods: routeModule.default.methods || ['GET']
      })
    }
  }

  return routeMap
}

const routeMapPromise = loadRoutes()

async function requestHandler(nodelink, req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`)
  const remoteAddress = req.socket.remoteAddress
  const isInternal = ['127.0.0.1', '::1', 'localhost'].includes(remoteAddress)
  const clientAddress = `${isInternal ? '[Internal]' : '[External]'} (${remoteAddress}:${req.socket.remotePort})`

  if (!req.headers || req.headers.authorization !== nodelink.options.server.password) {
    logger(
      'warn',
      'Server',
      `Unauthorized connection attempt from ${clientAddress} - Invalid password provided`
    )
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Nodelink-Api-Version': '4' })
    res.end('Unauthorized')
    return
  }

  logger(
    'info',
    'Request',
    `${req.method} | ${clientAddress} [${req.headers['user-agent']}] - ${parsedUrl.pathname} ${JSON.stringify(req.headers)}`
  )

  const routeMap = await routeMapPromise

  const route = routeMap.get(parsedUrl.pathname)

  if (route) {
    if (!verifyMethod(req, res, route.methods)) return
    route.handler(nodelink, req, res, sendResponse)
    return
  }

  for (const [pathname, route] of routeMap) {
    if (pathname instanceof RegExp && pathname.test(parsedUrl.pathname)) {
      if (!verifyMethod(parsedUrl, req, res, route.methods, sendResponse)) return
      route.handler(nodelink, req, res, sendResponse)
      return
    }
  }

  logger('warn', 'Server', `Route not found: ${parsedUrl.pathname}`)
  // biome-ignore format: off
  sendResponse(req, res, {
    timestamp: Date.now(),
    status: 404,
    error: 'Not Found',
    trace: new Error().stack,
    message: 'The requested route was not found.',
    path: parsedUrl.pathname
  }, 404)
}

export default requestHandler
