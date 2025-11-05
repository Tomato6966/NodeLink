import test from 'node:test'
import assert from 'node:assert/strict'

import requestHandler from '../src/api/index.js'
import PluginManager from '../src/plugins/pluginManager.js'
import examplePlugin from '../src/plugins/src/example-plugin.js'
import audioCachePlugin from '../src/plugins/src/audio-cache-plugin.js'

function createMockServer(password = 'test-pass') {
  const nodelink = {
    options: { server: { password }, filters: { enabled: {} }, plugins: {} },
    statsManager: { incrementApiRequest: () => {} },
    dosProtectionManager: { check: () => ({ allowed: true }) },
    rateLimitManager: { check: () => true },
    version: 'test-0.0.0',
    gitInfo: { commitTime: Date.now(), branch: 'test', commit: 'test' }
  }
  nodelink.pluginManager = new PluginManager(nodelink)

  const api = {
    addRoute: (pathnameOrRegex, handler, methods) =>
      nodelink.pluginManager.addRoute(pathnameOrRegex, handler, methods),
    registerStreamInterceptor: () => {},
    registerBeforePlay: () => {},
    logger: () => {},
    config: nodelink.options,
    version: 'test'
  }

  return { nodelink, api }
}

function invoke(
  nodelink,
  { method = 'GET', path = '/', body = undefined, headers = {} } = {}
) {
  return new Promise((resolve) => {
    const req = new (class {
      constructor() {
        this.method = method
        this.url = path
        this.headers = {
          host: 'localhost:3000',
          authorization: nodelink.options.server.password,
          'user-agent': 'node-test',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        }
        this.socket = { remoteAddress: '127.0.0.1', remotePort: 12345 }
        this._listeners = {}
        // For non-GET, simulate data/end events after handler attaches listeners
        if (method !== 'GET') {
          process.nextTick(() => {
            if (body !== undefined) {
              const payload =
                typeof body === 'string' ? body : JSON.stringify(body)
              this._emit('data', Buffer.from(payload))
            }
            this._emit('end')
          })
        }
      }
      on(event, fn) {
        this._listeners[event] = this._listeners[event] || []
        this._listeners[event].push(fn)
      }
      _emit(event, ...args) {
        for (const fn of this._listeners[event] || []) fn(...args)
      }
    })()

    let status = 0
    let resHeaders = {}
    let bodyBufs = []
    const res = {
      writeHead(code, headers) {
        status = code
        resHeaders = headers || {}
      },
      end(chunk) {
        if (chunk)
          bodyBufs.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          )
        const raw = Buffer.concat(bodyBufs).toString('utf8')
        let json = null
        try {
          json = raw ? JSON.parse(raw) : null
        } catch {
          /* not json */
        }
        resolve({ status, headers: resHeaders, raw, json })
      }
    }

    // Fire handler
    // eslint-disable-next-line promise/prefer-await-to-then
    Promise.resolve(requestHandler(nodelink, req, res)).catch((err) => {
      // If handler throws, surface as test failure
      resolve({
        status: status || 500,
        headers: resHeaders,
        raw: String(err),
        json: null
      })
    })
  })
}

test('plugin static route (example-plugin) responds with ok', async () => {
  const { nodelink, api } = createMockServer()
  await examplePlugin(nodelink, api)

  const res = await invoke(nodelink, {
    method: 'GET',
    path: '/v4/example-plugin/ping'
  })
  assert.equal(res.status, 200)
  assert.ok(res.json && res.json.ok === true)
  assert.equal(res.json.plugin, 'example-plugin')
})

test('plugin dynamic route via RegExp matches and responds', async () => {
  const { nodelink, api } = createMockServer()
  // Register a simple dynamic route
  api.addRoute(
    /^\/v4\/custom\/item\/\d+$/,
    (server, req, res, sendResponse) => {
      sendResponse(req, res, { matched: true }, 200)
    },
    ['GET']
  )

  const ok = await invoke(nodelink, {
    method: 'GET',
    path: '/v4/custom/item/42'
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { matched: true })

  const notFound = await invoke(nodelink, {
    method: 'GET',
    path: '/v4/custom/item/abc'
  })
  assert.equal(notFound.status, 404)
})

test('audio-cache plugin: GET /v4/cache/stats returns payload', async () => {
  const { nodelink, api } = createMockServer()
  await audioCachePlugin(nodelink, api)

  const res = await invoke(nodelink, { method: 'GET', path: '/v4/cache/stats' })
  assert.equal(res.status, 200)
  assert.ok(res.json && res.json.ok === true)
  assert.ok('files' in res.json)
  assert.ok('bytes' in res.json)
})

test('audio-cache plugin: method enforcement on /v4/cache/cleanup', async () => {
  const { nodelink, api } = createMockServer()
  await audioCachePlugin(nodelink, api)

  const res = await invoke(nodelink, {
    method: 'GET',
    path: '/v4/cache/cleanup'
  })
  assert.equal(res.status, 405)
  assert.ok(res.json && res.json.status === 405)
})

test('info endpoint includes plugin metadata when initialized via manager', async () => {
  const { nodelink } = createMockServer()
  // Load via manager to record metadata
  await nodelink.pluginManager.initialize(examplePlugin, 'example-plugin.js')
  await nodelink.pluginManager.initialize(
    audioCachePlugin,
    'audio-cache-plugin.js'
  )

  const res = await invoke(nodelink, { method: 'GET', path: '/v4/info' })
  assert.equal(res.status, 200)
  const plugins = res.json?.plugins || []
  const map = new Map(plugins.map((p) => [p.name, p]))
  assert.ok(map.has('example-plugin'))
  assert.equal(map.get('example-plugin').version, '1.0.0')
  assert.ok(map.has('audio-cache'))
  assert.equal(map.get('audio-cache').version, '1.0.0')
})
