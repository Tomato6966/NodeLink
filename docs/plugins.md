Plugin System

Overview
- NodeLink exposes a lightweight plugin system so others can extend the server without changing core files.
- Plugins can:
  - Register HTTP routes (static path or RegExp).
  - Register custom audio sources.
  - Register custom lyrics sources.
  - Intercept audio streams or run hooks before playback.

Where Plugins Live
- Local (recommended for development): place files in `src/plugins/src/*.js`.
  - Example: `src/plugins/src/example-plugin.js` is included and registers a `/v4/example-plugin/ping` route.
- Packages (publishable): install NPM packages whose name starts with `nodelink-plugin-` and they will be auto-loaded.

Exports
- A plugin may export one of the following as its default export:
  - `export default function (nodelink, api) { /* ... */ }`
  - `export default { register(nodelink, api) { /* ... */ } }`
  - `export default { init(nodelink, api) { /* ... */ } }`

Metadata (name, description, version)
- Plugins can provide metadata that appears in `/v4/info` under `plugins`.
- Provide it in one of these ways (in order of precedence):
  - Attach to the default function: `myPlugin.pluginInfo = { name, description, version }`
  - Export a named value: `export const pluginInfo = { name, description, version }`
  - Export an object with fields: `export default { name, description, version, register() { ... } }`

Example with function export:
```js
export const pluginInfo = {
  name: 'my-plugin',
  description: 'Short summary of what it does',
  version: '1.2.3'
}

export default async function myPlugin(nodelink, api) {
  api.addRoute('/v4/my-plugin/health', (server, req, res, sendResponse) => {
    sendResponse(req, res, { status: 'ok' }, 200)
  })
}

// Optional: also attach to the function (supported as well)
myPlugin.pluginInfo = pluginInfo
```

Plugin API
- `api.addRoute(pathOrRegex, handler, methods = ['GET'])`
  - `pathOrRegex`: string like `/v4/your/route` or a `RegExp` to match dynamic paths.
  - `handler(nodelink, req, res, sendResponse, parsedUrl)`:
    - Use `sendResponse(req, res, data, status)` to reply JSON.
- `api.registerSource(name, instance)`
  - Registers an audio source instance. The instance should follow the same interface as built-in sources:
    - `setup(): Promise<boolean>`, `search(query)`, `resolve(url)`, `loadStream(track, url, protocol, additionalData)`, etc.
    - Optionally provide `searchTerms: string[]`, `patterns: RegExp[]`, and `priority: number`.
- `api.registerLyricsSource(name, instance)`
  - Registers a lyrics provider with methods like `setup()` and `getLyrics(trackInfo)`.
- `api.registerStreamInterceptor(fn)`
  - Intercepts audio stream loading. Useful for caching, metering, or transformation.
  - Signature: `(nodelink, track, url, protocol, additionalData, next) => (Readable|{ stream: Readable, type?: string }) | Promise<...>`
  - Call `await next()` to get the original stream (or `{ stream, type }`), then return your wrapped stream.
  - If you need to preserve the detected format, return `{ stream, type }`.
- `api.registerBeforePlay(fn)`
  - Runs right before playback starts for a track, after the server resolves the stream URL but before the audio pipeline is created.
  - Signature: `(nodelink, player, context) => void|Promise<void>`
    - `player`: the Player instance; you can call `player.setFilters(...)` or read `player.volumePercent`.
    - `context.info`: the decoded track info object.
    - `context.urlData`: `{ url, protocol, format?, additionalData?, newTrack? }` as returned by the source.
  - Use cases: enable filters (e.g., compressor), tag telemetry, or adjust internal state. Best practice: do not override user volume unless your plugin explicitly requires it.
- `api.logger(level, category?, message)`
- `api.config` — resolved server config.
- `api.version` — server version string.

Route Matching Order
1) Built-in routes
2) Plugin static routes
3) Built-in dynamic routes
4) Plugin dynamic routes

Example Plugin (Local)
```js
// src/plugins/src/my-plugin.js
export default async function (nodelink, api) {
  api.addRoute('/v4/my-plugin/health', (server, req, res, sendResponse) => {
    sendResponse(req, res, { status: 'ok' }, 200)
  })

  api.logger('info', 'Plugin', 'my-plugin loaded')
}
```

Audio Cache Example
```js
// src/plugins/src/audio-cache-plugin.js
// Intercepts streams and caches them on disk; see repository version for a full implementation.
export default async function (nodelink, api) {
  api.registerStreamInterceptor(async (server, track, url, protocol, additionalData, next) => {
    const original = await next()
    // Return original or a PassThrough tee into a file
    return original
  })
}
```

Before-Play Hook Example (Normalization)
```js
// src/plugins/src/audio-normalizer-plugin.js
export default async function (nodelink, api) {
  // Gentle compressor to even out loudness; do not change user volume
  const compressor = { threshold: -18, ratio: 3, attack: 10, release: 120, gain: 6 }

  api.registerBeforePlay(async (_server, player, { info, urlData }) => {
    // Enable compressor prior to pipeline creation
    player.setFilters({ filters: { compressor } })
    // Respect the user's chosen volume: avoid calling player.volume(...)
  })
}
```

Package Plugin Skeleton
```js
// index.js in an npm package named: nodelink-plugin-hello
export default {
  name: 'nodelink-plugin-hello',
  description: 'Hello demo routes',
  version: '0.1.0',
  async register(nodelink, api) {
    api.addRoute(/\/v4\/hello\/?.*/, (server, req, res, sendResponse, url) => {
      sendResponse(req, res, { route: url.pathname }, 200)
    })
  }
}
```

Notes
- Plugins load after built-in sources and lyrics in single-process mode and in worker processes.
- If a plugin registers sources/lyrics, it can be used immediately for requests.
- If you need more hooks, open an issue or contribute a PR to extend the plugin API.

Introspection
- The `/v4/info` endpoint lists loaded plugins with their `name`, `description`, and `version`.
- The server also logs `Loaded plugin: <file-or-package>` on successful initialization.

