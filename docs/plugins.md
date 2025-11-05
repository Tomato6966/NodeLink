# 🧩 NodeLink Plugin Guide (Detailed Edition)
NodeLink supports a **modular plugin system** that lets you extend its core behavior without modifying the main source.
You can add new endpoints, register audio sources, intercept audio streams, and even inject logic before a song starts playing.

This guide explains every part of the system clearly and in depth, with real examples.

---

## 🧠 Overview: What Plugins Are
A **plugin** in NodeLink is a small piece of JavaScript code that runs when the NodeLink server starts.
It interacts with the system through a provided API called `pluginApi`.

You can use it to:
| Capability              | Description                          | Example Use Case                                   |
| ----------------------- | ------------------------------------ | -------------------------------------------------- |
| **HTTP routes**         | Add custom endpoints under `/v4/...` | Create a `/v4/status` route to check server health |
| **Audio sources**       | Integrate new content providers      | Add a custom SoundCloud, TikTok, or S3 source      |
| **Lyrics providers**    | Supply your own lyric fetcher        | Pull lyrics from a private API                     |
| **Stream interceptors** | Modify or monitor audio streams      | Cache audio, tag metadata, pre-buffer tracks       |
| **Before-play hooks**   | Run logic before playback            | Normalize volume or apply dynamic filters          |

Plugins allow developers to expand NodeLink’s behavior without touching its internals — keeping updates simple and compatibility strong.

---

## ⚙️ How Plugins Are Loaded
NodeLink automatically loads plugins from **two sources**: local files and npm packages.

### 1. Local Plugins (for development)
If you’re experimenting or writing your own plugin:
* Create a file in `src/plugins/src/`.
* Example:
  ```
  src/plugins/src/my-plugin.js
  ```
* NodeLink automatically loads any `.js` file in this directory.

You can look at the built-in reference:
```
src/plugins/src/example-plugin.js
```
This example demonstrates the minimal setup for defining metadata and adding routes.

---

### 2. Package Plugins (for sharing or production)
If you want to share your plugin or install one written by someone else:

* Install it like a normal npm package.
* It **must** be named with this pattern:
  ```
  nodelink-plugin-<something>
  ```
* NodeLink scans installed packages and automatically loads any matching ones.
This makes distribution seamless — just `npm install` and restart NodeLink.

---

## 🧱 Writing Your First Plugin
Below is a simple example plugin that adds a `/v4/my-plugin/health` endpoint.
```js
// src/plugins/src/my-plugin.js
export const pluginInfo = {
  name: 'my-plugin',
  description: 'Shows a health route',
  version: '1.0.0'
}

export default async function myPlugin(nodelink, pluginApi) {
  pluginApi.addRoute('/v4/my-plugin/health', (_server, req, res, sendResponse) => {
    sendResponse(req, res, { status: 'ok' }, 200)
  })
}

// Optional alternative way to attach metadata
myPlugin.pluginInfo = pluginInfo
```

### How It Works
* The `pluginInfo` object provides metadata shown in `/v4/info`.
* The exported function (`default`) is called when NodeLink starts.
* You get two parameters:

  * `nodelink`: The main NodeLink instance
  * `pluginApi`: The helper API for registering routes, hooks, etc.
* Inside the function, you register your behavior — in this case, a simple health route returning `{ status: 'ok' }`.

---

## 🧩 Supported Export Shapes
NodeLink is flexible — it can load your plugin in different ways.
| Format                     | Example                                                    | Description                            |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| **Function**               | `export default function (nodelink, pluginApi) { ... }`    | Most common and straightforward        |
| **Object with `register`** | `export default { register(nodelink, pluginApi) { ... } }` | Useful for class-like structures       |
| **Object with `init`**     | `export default { init(nodelink, pluginApi) { ... } }`     | Same idea, different naming preference |

If NodeLink finds any of these forms, it will call the function and initialize the plugin.

---

## 🌐 Adding HTTP Routes
Plugins can register new HTTP endpoints that appear under NodeLink’s built-in API.
These can serve JSON, perform internal actions, or even forward requests to external services.

### Static Route Example
```js
pluginApi.addRoute('/v4/example/ping', (_server, req, res, sendResponse) => {
  sendResponse(req, res, { ok: true }, 200)
}, ['GET'])
```
This creates a `GET /v4/example/ping` endpoint returning `{ ok: true }`.

### Dynamic Route Example (with Regex)
```js
pluginApi.addRoute(/\/v4\/example\/item\/([\w-]+)/, (_server, req, res, sendResponse, url) => {
  const id = url.pathname.split('/').pop()
  sendResponse(req, res, { id }, 200)
}, ['GET'])
```
This matches any path like `/v4/example/item/abc123`.

### Route Handler Signature
```js
(nodelink, req, res, sendResponse, parsedUrl)
```

To send a response:
```js
sendResponse(req, res, data, statusCode)
```

**Tip:** Keep routes simple — avoid heavy blocking operations and move complex logic into helpers.

---

## 🎧 Stream Interceptors
Stream interceptors let you **modify, wrap, or monitor audio streams** before they reach users.

### Example: Stream Interceptor
```js
pluginApi.registerStreamInterceptor(async (nodelink, track, url, protocol, additionalData, next) => {
  const original = await next()                 // Get original stream
  const input = original?.stream || original
  if (!input?.on) return original               // Skip if invalid stream

  // Here, you could measure data, cache it, or re-encode it.
  return { stream: input, type: original?.type }
})
```

### What You Can Do
* **Prebuffering:** Download the first few seconds before playback.
* **Caching:** Store downloaded audio to disk for faster replays.
* **Monitoring:** Count bytes streamed or log duration.
* **Transforming:** Apply audio filters or compression.

**Important:**
Always return `{ stream, type }` if you modify the stream — otherwise NodeLink might not detect the format correctly.
Some streams emit `finishBuffering` when they’re ready to play, so you can hook into that event if needed.

---

## 🎚️ Before-Play Hook
Runs just before playback begins — after the source resolves but before the audio pipeline is built.
It’s perfect for automatic filter adjustments, normalization, or analytics.
```js
pluginApi.registerBeforePlay(async (_nodelink, player, context) => {
  player.setFilters({
    filters: {
      compressor: { threshold: -18, ratio: 3, attack: 10, release: 120, gain: 6 }
    }
  })
})
```

You can access:
* `player`: The current player instance
* `context`: Metadata about what’s being played (guild ID, track info, etc.)

---

## 🎵 Custom Sources & Lyrics Providers
You can add your own **audio source** or **lyrics provider** that NodeLink can use alongside YouTube, Spotify, etc.

### Audio Source Example
```js
pluginApi.registerSource('my-source', {
  async setup() { return true },              // Optional initialization
  async search(query) { /* search API logic */ },
  async resolve(url) { /* resolve a track URL */ },
  async loadStream(track, url, protocol, additionalData) { /* return readable stream */ }
})
```

### Lyrics Provider Example
```js
pluginApi.registerLyricsSource('my-lyrics', {
  async setup() { return true },
  async getLyrics(trackInfo) { /* fetch or parse lyrics */ }
})
```
Each method gives you control over how NodeLink interacts with your service.

---

## ⚙️ Plugin Configuration
Each plugin can have its own settings under the `plugins` key in `config.js`.
Here’s an example using built-in plugins:
```js
export default {
  plugins: {
    audioCache: {
      enabled: true,
      directory: 'cache/audio',
      ttlDays: 7,
      cleanupIntervalHours: 12,
      maxSize: '1 GB',
      protectRecentMinutes: 60,
      allowExceedWhenAllRecent: true
    },
    prebuffer: {
      enabled: true,
      bytes: '512 KB',
      timeoutMs: 2000,
      highWaterMark: '1 MB'
    }
  }
}
```

### Explanation
* `audioCache`: Controls caching of audio files.
  * Cleans up every 12 hours, deletes old files after 7 days.
  * Can protect recently used files.
* `prebuffer`: Defines how much data is downloaded before playback starts.
You can define your own plugin’s config under this same structure, e.g.:
```js
plugins: {
  myPlugin: {
    enabled: true,
    logRequests: false
  }
}
```

Access it in your plugin via:
```js
const cfg = nodelink.config?.plugins?.myPlugin || {}
```

---

## 🔍 Route Resolution Order
When multiple routes overlap, NodeLink resolves them in this order:
1. Built-in static routes
2. Plugin static routes
3. Built-in dynamic routes
4. Plugin dynamic routes

This means plugin routes won’t override critical core endpoints unless explicitly designed to.

---

## 🧾 Discovering Plugins at Runtime
NodeLink exposes API endpoints to help you inspect loaded plugins.
| Endpoint          | Description                                                 |
| ----------------- | ----------------------------------------------------------- |
| `GET /v4/plugins` | Lists all plugin route registrations                        |
| `GET /v4/info`    | Displays plugin metadata (`name`, `description`, `version`) |

Use these to verify that your plugin loaded correctly.

---

## 📦 Packaging & Publishing
If you want to publish your plugin for others:
1. **Name your package**:
   `nodelink-plugin-yourname`
2. **Export** one of the supported shapes (`default`, `register`, or `init`).
3. **Provide metadata**:

   ```js
   export const pluginInfo = { name, description, version }
   ```

   or:

   ```js
   myPlugin.pluginInfo = pluginInfo
   ```
4. Publish to npm, or share via GitHub.
NodeLink will auto-detect it when installed.

---

## 💡 Best Practices
* **Use clear names:** prefer `pluginApi` over `pa`.
* **Keep route handlers short.** Extract logic into functions if needed.
* **Use async I/O** — avoid blocking code or `sync` filesystem calls.
* **Log responsibly:**
  * `debug` → fine-grained details
  * `info` → lifecycle events
  * `warn` → recoverable issues
  * `error` → real problems

---

## 🧰 Troubleshooting
| Problem                               | Likely Cause                          | Fix                                                            |
| ------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Route doesn’t appear                  | Wrong directory or missing prefix     | Place in `src/plugins/src` or name package `nodelink-plugin-*` |
| Plugin metadata missing in `/v4/info` | `pluginInfo` not exported or attached | Add `export const pluginInfo = {...}`                          |
| Stream interceptor never fires        | Source didn’t trigger `loadStream`    | Test using an actual playback source                           |
| Plugin config ignored                 | Typo or missing `enabled: true`       | Check your `config.js` structure                               |
