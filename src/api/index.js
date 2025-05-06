import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { logger, sendResponse, verifyMethod } from '../utils.js'
import { PATH_VERSION } from '../constants.js'
import fs from 'node:fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function loadRoutes() {
  const routeFiles = await fs.readdir(__dirname)
  const routeMap = new Map()

  for (const file of routeFiles) {
    if (file !== 'index.js' && file.endsWith('.js')) {
      const routeName = file.replace('.js', '').toLowerCase()
      let pathname

      if (routeName === 'version') {
        pathname = '/version'
      } else if (routeName.includes('.')) {
        const parts = routeName.split('.')
        pathname = new RegExp(
          `^/${PATH_VERSION}/${parts.map(part => (part === 'id' ? '[A-Za-z0-9]+' : part)).join('/')}$`
        )
      } else {
        pathname = `/${PATH_VERSION}/${routeName}`
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

  let body = ''
  if (req.method !== 'GET') {
    await new Promise(resolve => {
      req.on('data', chunk => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          if (req.headers['content-type']?.includes('application/json')) {
            body = JSON.parse(body)
          }
        } catch (error) {
          logger('error', 'Server', `Failed to parse JSON body: ${error.message}`)
          // biome-ignore format: off
          sendResponse(req, res, {
            timestamp: Date.now(),
            status: 400,
            error: 'Invalid JSON',
            message: error.message || 'Failed to parse JSON body',
            trace: new Error().stack,
            path: parsedUrl.pathname
          }, 400)
          return
        }
        resolve()
      })
    })
  }
  req.body = body

  logger(
    'info',
    'Request',
    `${req.method} | ${clientAddress} [${req.headers['user-agent']}] - ${parsedUrl.pathname} ${JSON.stringify(req.headers)}${req.body ? `\nBody: ${JSON.stringify(req.body)}` : ''}`
  )

  const routeMap = await routeMapPromise

  const route = routeMap.get(parsedUrl.pathname)

  if (route) {
    if (!verifyMethod(parsedUrl, req, res, route.methods, clientAddress)) return
    route.handler(nodelink, req, res, sendResponse, parsedUrl)
    return
  }

  for (const [pathname, route] of routeMap) {
    if (pathname instanceof RegExp && pathname.test(parsedUrl.pathname)) {
      if (!verifyMethod(parsedUrl, req, res, route.methods, sendResponse, clientAddress)) return
      route.handler(nodelink, req, res, sendResponse, parsedUrl)
      return
    }
  }

  logger(
    'warn',
    'Request',
    `${req.method} | ${clientAddress} - ${parsedUrl.pathname} not found (response 404)`
  )
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
