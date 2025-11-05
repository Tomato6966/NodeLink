import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PATH_VERSION } from '../constants.js'
import { sendResponse } from '../utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function listBuiltinRoutes() {
  const files = await fs.readdir(__dirname)
  const builtin = { static: [], dynamic: [] }

  for (const file of files) {
    if (file === 'index.js' || !file.endsWith('.js')) continue
    const routeName = file.replace('.js', '').toLowerCase()
    let pathnameOrRegex

    if (routeName === 'version') {
      pathnameOrRegex = '/version'
    } else if (routeName.includes('.')) {
      const parts = routeName
        .split('.')
        .map((part) => (part === 'id' ? '(?:id|[A-Za-z0-9]+)' : part))
        .join('/')
      pathnameOrRegex = new RegExp(
        `^/${PATH_VERSION}/${parts}(?:/[A-Za-z0-9]+)?/?$`
      )
    } else {
      pathnameOrRegex = `/${PATH_VERSION}/${routeName}`
    }

    // Try to get methods from module, default to ['GET']
    let methods = ['GET']
    try {
      const filePath = join(__dirname, file)
      const mod = await import(pathToFileURL(filePath))
      const exported = mod?.default
      if (exported?.methods && Array.isArray(exported.methods))
        methods = exported.methods
    } catch {}

    if (pathnameOrRegex instanceof RegExp) {
      builtin.dynamic.push({ pattern: String(pathnameOrRegex), methods })
    } else {
      builtin.static.push({ path: pathnameOrRegex, methods })
    }
  }

  return builtin
}

async function handler(nodelink, req, res) {
  const builtin = await listBuiltinRoutes()
  const pr = nodelink?.pluginManager?.getRoutes?.()
  const plugins = {
    static: pr
      ? Array.from(pr.static.entries()).map(([path, data]) => ({
          path,
          methods: data.methods || ['GET']
        }))
      : [],
    dynamic: pr
      ? pr.dynamic.map(([regex, data]) => ({
          pattern: String(regex),
          methods: data.methods || ['GET']
        }))
      : []
  }

  return sendResponse(req, res, { builtin, plugins }, 200)
}

export default {
  handler,
  methods: ['GET']
}
