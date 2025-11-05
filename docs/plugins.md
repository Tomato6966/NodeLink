# NodeLink Plugin
## Table of Contents

1. [Introduction](#introduction)
    - [What is a Plugin?](#what-is-a-plugin)
    - [Why Use Plugins?](#why-use-plugins)
    - [What Can Plugins Do?](#what-can-plugins-do)
2. [Core Concepts](#core-concepts)
    - [Plugin Lifecycle](#plugin-lifecycle)
    - [Plugin Structure](#plugin-structure)
3. [Getting Started](#getting-started)
    - [Creating Your First Plugin](#creating-your-first-plugin)
      - [Step 1: Choose Your Development Method](#step-1-choose-your-development-method)
        - [Option A: Local Development](#option-a-local-development)
        - [Option B: Package Development](#option-b-package-development)
      - [Step 2: Write Your Plugin](#step-2-write-your-plugin)
      - [Step 3: Test Your Plugin](#step-3-test-your-plugin)
4. [Plugin API Reference](#plugin-api-reference)
    - [Entry Point Formats](#entry-point-formats)
      - [Format 1: Default Export Function (Recommended)](#format-1-default-export-function-recommended)
      - [Format 2: Object with register Method](#format-2-object-with-register-method)
      - [Format 3: Object with init Method](#format-3-object-with-init-method)
    - [Parameters Explained](#parameters-explained)
      - [nodelink - The NodeLink Instance](#nodelink---the-nodelink-instance)
      - [pluginApi - The Plugin API](#pluginapi---the-plugin-api)
5. [Advanced Features](#advanced-features)
    - [Accessing NodeLink Internals](#accessing-nodelink-internals)
    - [Error Handling](#error-handling)
    - [Async Operations](#async-operations)
6. [Configuration](#configuration)
    - [Plugin Configuration Structure](#plugin-configuration-structure)
    - [Accessing Configuration in Plugins](#accessing-configuration-in-plugins)
    - [Environment Variables](#environment-variables)
7. [Best Practices](#best-practices)
    - [1. Naming Conventions](#1-naming-conventions)
    - [2. Logging](#2-logging)
    - [3. Performance](#3-performance)
    - [4. Metadata Best Practices](#4-metadata-best-practices)
8. [Troubleshooting](#troubleshooting)
    - [Plugin Not Loading](#plugin-not-loading)
    - [Routes Not Working](#routes-not-working)
    - [Stream Interceptor Not Firing](#stream-interceptor-not-firing)
    - [Configuration Not Loading](#configuration-not-loading)
    - [Memory Leaks](#memory-leaks)

---

## Introduction

### What is a Plugin?

A NodeLink plugin is a JavaScript module that extends NodeLink's functionality without modifying its core codebase. Plugins receive access to the NodeLink instance and a specialized API (`pluginApi`) that provides safe, structured methods for integration.

### Why Use Plugins?

- **Extend functionality** without forking the codebase
- **Keep updates simple** by separating custom logic from core
- **Share integrations** easily via npm packages
- **Maintain compatibility** across NodeLink versions

### What Can Plugins Do?

- **Add HTTP endpoints** for custom API routes
- **Register audio sources** for new content providers (SoundCloud, custom APIs, etc.)
- **Provide lyrics** from alternative services
- **Intercept audio streams** for caching, monitoring, or transformation
- **Hook into playback** to apply filters or execute pre-play logic

---

## Core Concepts

### Plugin Lifecycle

1. **Discovery**: NodeLink scans for plugins in local directories and npm packages
2. **Loading**: Each plugin module is imported
3. **Registration**: NodeLink calls your plugin's entry function with `nodelink` and `pluginApi`
4. **Runtime**: Your registered hooks, routes, and sources become active

### Plugin Structure

Every plugin needs:

1. **Entry point**: A function that NodeLink calls during initialization
2. **Metadata** (optional but recommended): Information about your plugin
3. **Registration code**: Calls to `pluginApi` methods to register functionality

---

## Getting Started

### Creating Your First Plugin

#### Step 1: Choose Your Development Method

**Option A: Local Development**
- Create a file in `src/plugins/src/`
- Best for: Testing, experimentation, private plugins
- Example: `src/plugins/src/my-first-plugin.js`

**Option B: Package Development**
- Create an npm package named `nodelink-plugin-<name>`
- Best for: Sharing, production use, version control
- Example: `nodelink-plugin-health-check`

#### Step 2: Write Your Plugin

Create a new file with this basic structure:

```javascript
// Define plugin metadata
export const pluginInfo = {
  name: 'health-check',
  description: 'Adds a simple health check endpoint',
  version: '1.0.0',
  author: 'Your Name'
}

// Main plugin function
export default async function healthCheckPlugin(nodelink, pluginApi) {
  // Register a simple HTTP route
  pluginApi.addRoute('/v4/health', (server, req, res, sendResponse) => {
    sendResponse(req, res, {
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: Date.now()
    }, 200)
  }, ['GET'])
  
  // Log that your plugin loaded
  pluginApi.logger('info', 'Health-Check-Plugin', '[HealthCheck] Plugin loaded successfully')
}
```

#### Step 3: Test Your Plugin

1. Start NodeLink
2. Check the logs for your plugin's initialization message
3. Test your endpoint: `curl http://localhost:2333/v4/health`
4. Verify plugin appears in: `GET /v4/info`

---

## Plugin API Reference

### Entry Point Formats

NodeLink supports three entry point formats:

#### Format 1: Default Export Function (Recommended)

```javascript
export default async function myPlugin(nodelink, pluginApi) {
  // Your initialization code
}
```

#### Format 2: Object with `register` Method

```javascript
export default {
  async register(nodelink, pluginApi) {
    // Your initialization code
  }
}
```

#### Format 3: Object with `init` Method

```javascript
export default {
  async init(nodelink, pluginApi) {
    // Your initialization code
  }
}
```

### Parameters Explained

#### `nodelink` - The NodeLink Instance

The main server instance with access to:

```javascript
{
  config: {...},           // Configuration object
  logger: {...},           // Logging methods (debug, info, warn, error)
  players: Map,            // Active player instances
  sources: {...},          // Registered audio sources
  // ... other internal components
}
```

#### `pluginApi` - The Plugin API

Specialized methods for safe plugin integration:

```javascript
{
  addRoute,                      // Register HTTP endpoints
  registerSource,                // Add audio sources
  registerLyricsSource,          // Add lyrics providers
  registerStreamInterceptor,     // Intercept audio streams
  registerBeforePlay             // Hook before playback starts
}
```

---

## Plugin API Methods

### API Summary

| Method | Signature | Description |
| --- | --- | --- |
| [addRoute](#1-http-routes-addroute) | `addRoute(pattern, handler, methods = ['GET'])` | Register custom HTTP endpoints under NodeLink's API. |
| [registerSource](#2-audio-sources-registersource) | `registerSource(name, sourceImplementation)` | Add a custom audio source that can search/resolve tracks and provide streams. |
| [registerLyricsSource](#3-lyrics-providers-registerlyricssource) | `registerLyricsSource(name, lyricsImplementation)` | Add a lyrics provider for fetching song lyrics. |
| [registerStreamInterceptor](#4-stream-interceptors-registerstreaminterceptor) | `registerStreamInterceptor(interceptorFunction)` | Intercept/modify audio streams before they reach the player. |
| [registerBeforePlay](#5-before-play-hook-registerbeforeplay) | `registerBeforePlay(hookFunction)` | Run logic just before a track starts playing. |

### 1. HTTP Routes: `addRoute()`

Register custom HTTP endpoints under NodeLink's API.

#### Signature

```javascript
pluginApi.addRoute(pattern, handler, methods = ['GET'])
```

#### Handler Function Signature

```javascript
function handler(nodelink, req, res, sendResponse, parsedUrl) {
  // nodelink: NodeLink instance
  // req: Node.js IncomingMessage
  // res: Node.js ServerResponse
  // sendResponse: Helper function for responses
  // parsedUrl: Parsed URL object
}
```

#### Handler Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| nodelink | object | NodeLink instance with config, logger, players, etc. |
| req | IncomingMessage | Node.js HTTP request object. |
| res | ServerResponse | Node.js HTTP response object. |
| sendResponse | function | Helper to send JSON responses with proper headers and CORS. |
| parsedUrl | URL | Parsed URL object of the incoming request. |

#### The `sendResponse` Helper

```javascript
sendResponse(req, res, data, statusCode = 200, headers = {})
```

This helper automatically:
- Serializes `data` to JSON
- Sets appropriate `Content-Type` headers
- Handles CORS if configured
- Sends the response

#### Example: Static Route

```javascript
pluginApi.addRoute('/v4/plugins/status', (server, req, res, sendResponse) => {
  sendResponse(req, res, {
    active: true,
    version: '1.0.0'
  }, 200)
}, ['GET'])
```

#### Example: Dynamic Route with Parameters

```javascript
// Match: /v4/plugins/user/12345
pluginApi.addRoute(/\/v4\/plugins\/user\/([\w-]+)/, 
  (server, req, res, sendResponse, url) => {
    const userId = url.pathname.split('/').pop()
    
    sendResponse(req, res, {
      userId,
      found: true
    }, 200)
  }, 
  ['GET']
)
```

#### Example: POST Route with Body Parsing

```javascript
pluginApi.addRoute('/v4/plugins/data', async (server, req, res, sendResponse) => {
  // Parse request body
  let body = ''
  for await (const chunk of req) {
    body += chunk
  }
  
  try {
    const data = JSON.parse(body)
    // Process data...
    
    sendResponse(req, res, { success: true, received: data }, 200)
  } catch (error) {
    sendResponse(req, res, { error: 'Invalid JSON' }, 400)
  }
}, ['POST'])
```

### Route Resolution Priority

When multiple routes could match a URL, NodeLink checks in this order:

1. Built-in static routes (exact string matches)
2. Plugin static routes
3. Built-in dynamic routes (regex patterns)
4. Plugin dynamic routes

This ensures plugins cannot accidentally override critical system endpoints.

---

### 2. Audio Sources: `registerSource()`

Add custom audio providers that NodeLink can search and play from.

#### Signature

```javascript
pluginApi.registerSource(name, sourceImplementation)
```

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| name | string | Yes | — | Unique source name used in `track.info.sourceName`. |
| sourceImplementation | object | Yes | — | Implementation with lifecycle and data methods (see below). |

#### Source Implementation Interface

```javascript
{
  async setup() {
    // Optional: Initialize API clients, validate credentials, etc.
    // Return true on success, false on failure
    return true
  },
  
  async search(query, options) {
    // Search for tracks matching query
    // Return: { loadType, data: [...tracks] }
  },
  
  async resolve(url) {
    // Resolve a specific URL to track(s)
    // Return: { loadType, data: track | [tracks] | playlist }
  },
  
  async loadStream(track, url, protocol, additionalData) {
    // Return a readable stream for the audio
    // Return: ReadableStream | { stream: ReadableStream, type: string }
  }
}
```

#### Implementation Methods

| Method | Parameters | Expected Return | Description |
| --- | --- | --- | --- |
| setup | — | `boolean` | Optional initializer. Return `true` to enable, `false` to skip registering the source. |
| search | `(query: string, options?: object)` | `{ loadType, data: Track[] }` | Search for tracks matching a query string. |
| resolve | `(url: string)` | `{ loadType, data: Track OR Track[] OR Playlist }` | Resolve a URL to a track, list of tracks, or playlist. |
| loadStream | `(track, url, protocol, additionalData)` | `ReadableStream` or `{ stream: ReadableStream, type?: string }` | Provide the playable audio stream (optionally with a content type). |

#### Example: Custom Audio Source

```javascript
pluginApi.registerSource('custom-music-api', {
  async setup() {
    // Verify API key is configured
    const apiKey = nodelink.config.plugins?.customMusic?.apiKey
    if (!apiKey) {
      pluginApi.logger('error', 'CustomMusic', 'API key not configured')
      return false
    }
    
    pluginApi.logger('info', 'CustomMusic', 'Source initialized')
    return true
  },
  
  async search(query) {
    const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}`)
    const results = await response.json()
    
    return {
      loadType: 'search',
      data: results.tracks.map(track => ({
        encoded: Buffer.from(track.id).toString('base64'),
        info: {
          identifier: track.id,
          title: track.title,
          author: track.artist,
          length: track.duration * 1000,
          uri: track.url,
          sourceName: 'custom-music-api'
        }
      }))
    }
  },
  
  async resolve(url) {
    // Extract track ID from URL
    const trackId = url.split('/').pop()
    
    const response = await fetch(`https://api.example.com/tracks/${trackId}`)
    const track = await response.json()
    
    return {
      loadType: 'track',
      data: {
        encoded: Buffer.from(track.id).toString('base64'),
        info: {
          identifier: track.id,
          title: track.title,
          author: track.artist,
          length: track.duration * 1000,
          uri: url,
          sourceName: 'custom-music-api'
        }
      }
    }
  },
  
  async loadStream(track, url, protocol, additionalData) {
    const streamUrl = await fetch(`https://api.example.com/stream/${track.info.identifier}`)
      .then(r => r.json())
      .then(data => data.streamUrl)
    
    const response = await fetch(streamUrl)
    return {
      stream: response.body,
      type: 'arbitrary' // or 'ogg/opus', 'webm/opus', etc.
    }
  }
})
```

---

### 3. Lyrics Providers: `registerLyricsSource()`

Add custom lyrics fetching services.

#### Signature

```javascript
pluginApi.registerLyricsSource(name, lyricsImplementation)
```

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| name | string | Yes | — | Unique lyrics source name. |
| lyricsImplementation | object | Yes | — | Implementation that fetches lyrics (see below). |

#### Lyrics Implementation Interface

```javascript
{
  async setup() {
    // Optional: Initialize API, check credentials
    return true
  },
  
  async getLyrics(trackInfo) {
    // Fetch lyrics for the given track
    // Return: { text: string } | { lines: [...] } | null
  }
}
```

#### Implementation Methods

| Method | Parameters | Expected Return | Description |
| --- | --- | --- | --- |
| setup | — | `boolean` | Optional initializer. Return `true` to enable, `false` to disable. |
| getLyrics | `(trackInfo: { title: string, author?: string, ... })` | `{ text: string }` or `{ lines: Line[] }` or `null` | Fetch lyrics for the given track; `null` if not found. |

#### Example: Custom Lyrics Provider

```javascript
pluginApi.registerLyricsSource('genius-lyrics', {
  async setup() {
    const token = nodelink.config.plugins?.genius?.token
    if (!token) {
      pluginApi.logger('warn', 'Genius', 'No API token configured')
      return false
    }
    return true
  },
  
  async getLyrics(trackInfo) {
    const { title, author } = trackInfo
    const query = `${title} ${author}`
    
    try {
      // Search for song
      const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`
      const searchResponse = await fetch(searchUrl, {
        headers: { 'Authorization': `Bearer ${nodelink.config.plugins.genius.token}` }
      })
      const searchData = await searchResponse.json()
      
      if (!searchData.response.hits.length) {
        return null
      }
      
      const songUrl = searchData.response.hits[0].result.url
      
      // Scrape lyrics from page (simplified)
      const pageResponse = await fetch(songUrl)
      const html = await pageResponse.text()
      
      // Extract lyrics (you'd use a proper HTML parser here)
      const lyrics = extractLyricsFromHtml(html)
      
      return {
        text: lyrics,
        source: 'Genius'
      }
    } catch (error) {
      pluginApi.logger('error', 'Genius', `Failed to fetch lyrics: ${error}`)
      return null
    }
  }
})
```

---

### 4. Stream Interceptors: `registerStreamInterceptor()`

Intercept and modify audio streams before they reach the player.

#### Signature

```javascript
pluginApi.registerStreamInterceptor(interceptorFunction)
```

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| interceptorFunction | function | Yes | — | Async function to intercept streams; must call `next()` to get the original stream. |

#### Interceptor Function Signature

```javascript
async function interceptor(nodelink, track, url, protocol, additionalData, next) {
  // nodelink: NodeLink instance
  // track: Track object being played
  // url: Stream URL
  // protocol: Protocol type ('http', 'https', etc.)
  // additionalData: Extra data from source
  // next: Function to call the next interceptor/source
  
  const originalStream = await next()
  
  // Return modified stream or original
  return originalStream
}
```

#### Interceptor Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| nodelink | object | NodeLink instance with config, logger, players, etc. |
| track | Track | Track object being played (`track.info.*`). |
| url | string | Stream URL provided by the source. |
| protocol | string | Protocol of the stream (e.g., `http`, `https`). |
| additionalData | any | Extra data returned by the source (implementation-specific). |
| next | function | Call to obtain the next stream in the chain. Returns a stream or `{ stream, type }`. |

#### Example: Caching Interceptor

```javascript
pluginApi.registerStreamInterceptor(async (nodelink, track, url, protocol, additionalData, next) => {
  const cacheKey = track.info.identifier
  const cachePath = `./cache/${cacheKey}.audio`
  
  // Check if cached
  if (fs.existsSync(cachePath)) {
    pluginApi.logger('debug', 'Cache', `Serving from cache: ${track.info.title}`)
    return {
      stream: fs.createReadStream(cachePath),
      type: 'arbitrary'
    }
  }
  
  // Get original stream
  const original = await next()
  const input = original?.stream || original
  
  if (!input?.on) {
    return original
  }
  
  // Create cache file and pipe to it
  const cacheStream = fs.createWriteStream(cachePath)
  const passthrough = new PassThrough()
  
  input.pipe(passthrough)
  input.pipe(cacheStream)
  
  pluginApi.logger('debug', 'Cache', `Caching: ${track.info.title}`)
  
  return {
    stream: passthrough,
    type: original?.type || 'arbitrary'
  }
})
```

#### Example: Monitoring Interceptor

```javascript
pluginApi.registerStreamInterceptor(async (nodelink, track, url, protocol, additionalData, next) => {
  const original = await next()
  const input = original?.stream || original
  
  if (!input?.on) {
    return original
  }
  
  let bytesStreamed = 0
  const startTime = Date.now()
  
  input.on('data', (chunk) => {
    bytesStreamed += chunk.length
  })
  
  input.on('end', () => {
    const duration = Date.now() - startTime
    pluginApi.logger('info', 'Monitor', `Streamed ${bytesStreamed} bytes in ${duration}ms for: ${track.info.title}`)
  })
  
  return original
})
```

---

### 5. Before-Play Hook: `registerBeforePlay()`

Execute code just before a track starts playing.

#### Signature

```javascript
pluginApi.registerBeforePlay(hookFunction)
```

#### Parameters

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| hookFunction | function | Yes | — | Async function invoked before playback begins. |

#### Hook Function Signature

```javascript
async function hook(nodelink, player, context) {
  // nodelink: NodeLink instance
  // player: Player instance about to play
  // context: Playback context (guildId, track, etc.)
}
```

#### Hook Parameters

| Parameter | Type | Description |
| --- | --- | --- |
| nodelink | object | NodeLink instance with config, logger, players, etc. |
| player | Player | Player instance that will play the track. |
| context | object | Playback context including `guildId`, `track`, and other metadata. |

#### Example: Auto-Normalize Volume

```javascript
pluginApi.registerBeforePlay(async (nodelink, player, context) => {
  const track = context.track
  
  // Apply normalization for specific sources
  if (track.info.sourceName === 'youtube') {
    player.setVolume(85) // YouTube tends to be louder
  } else {
    player.setVolume(100)
  }
  
  pluginApi.logger('debug', 'Volume', `Adjusted volume for ${track.info.sourceName}`)
})
```

#### Example: Apply Dynamic Filters

```javascript
pluginApi.registerBeforePlay(async (nodelink, player, context) => {
  const guildId = context.guildId
  const guildSettings = await getGuildSettings(guildId)
  
  if (guildSettings.bassBoost) {
    player.setFilters({
      filters: {
        equalizer: [
          { band: 0, gain: 0.25 },
          { band: 1, gain: 0.15 }
        ]
      }
    })
  }
  
  if (guildSettings.nightcore) {
    player.setFilters({
      filters: {
        timescale: { speed: 1.2, pitch: 1.2 }
      }
    })
  }
})
```

---

## Advanced Features

### Accessing NodeLink Internals

While plugins receive the `nodelink` instance, be cautious when accessing internals:

```javascript
// Safe and recommended
pluginApi.logger('info', 'MyPlugin', 'Message')
nodelink.config.plugins.myPlugin

// Use with caution (may change between versions)
nodelink.players.get(guildId)
nodelink.sources['youtube']
```

### Error Handling

Always handle errors gracefully:

```javascript
export default async function myPlugin(nodelink, pluginApi) {
  try {
    pluginApi.addRoute('/v4/risky', async (server, req, res, sendResponse) => {
      try {
        const data = await someRiskyOperation()
        sendResponse(req, res, { data }, 200)
      } catch (error) {
        pluginApi.logger('error', 'MyPlugin', `Route error: ${error}`)
        sendResponse(req, res, { error: 'Internal error' }, 500)
      }
    })
  } catch (error) {
    pluginApi.logger('error', 'MyPlugin', `Initialization failed: ${error}`)
  }
}
```

### Async Operations

Plugins support async/await throughout:

```javascript
export default async function myPlugin(nodelink, pluginApi) {
  // Wait for external service
  await initializeExternalService()
  
  // Register async route handler
  pluginApi.addRoute('/v4/async', async (server, req, res, sendResponse) => {
    const result = await fetchExternalData()
    sendResponse(req, res, result, 200)
  })
}
```

---

## Configuration

### Plugin Configuration Structure

Add plugin settings to `config.js` under the `plugins` key:

```javascript
export default {
  // ... other NodeLink config
  
  plugins: {
    myPlugin: {
      enabled: true,
      apiKey: 'your-key-here',
      customOption: 'value'
    },
    
    audioCache: {
      enabled: true,
      directory: 'cache/audio',
      ttlDays: 7,
      maxSize: '1 GB'
    }
  }
}
```

### Accessing Configuration in Plugins

```javascript
export default async function myPlugin(nodelink, pluginApi) {
  // Get plugin-specific config
  const config = nodelink.config?.plugins?.myPlugin || {}
  
  // Check if enabled
  if (!config.enabled) {
    pluginApi.logger('info', 'MyPlugin', 'Disabled in config')
    return
  }
  
  // Use config values
  const apiKey = config.apiKey
  if (!apiKey) {
    pluginApi.logger('error', 'MyPlugin', 'API key not configured')
    return
  }
  
  // Continue initialization...
}
```

### Environment Variables

For sensitive data, use environment variables:

```javascript
const apiKey = process.env.MY_PLUGIN_API_KEY || nodelink.config?.plugins?.myPlugin?.apiKey

if (!apiKey) {
  throw new Error('API key required')
}
```

---

## Best Practices

### 1. Naming Conventions

**Plugin Files**
- Local: `my-feature-plugin.js`
- Package: `nodelink-plugin-my-feature`

**Route Paths**
- Use plugin name as prefix: `/v4/my-plugin/...`
- Keep paths lowercase with hyphens: `/v4/custom-source/search`

**Variable Names**
- Be descriptive: `pluginApi` not `pa`
- Use camelCase: `trackInfo`, `streamUrl`

### 2. Logging

Use appropriate log levels:

```javascript
// Detailed debugging information
pluginApi.logger('debug', 'MyPlugin', `Processing request for track: ${trackId}`)

// General information about plugin state
pluginApi.logger('info', 'MyPlugin', 'Successfully loaded 45 cached tracks')

// Recoverable issues
pluginApi.logger('warn', 'MyPlugin', 'API rate limit hit, using fallback')

// Critical problems
pluginApi.logger('error', 'MyPlugin', `Failed to initialize: ${error}`)
```

### 3. Performance

**Avoid Blocking Operations**
```javascript
// Bad: Synchronous file read
const data = fs.readFileSync('./large-file.json')

// Good: Asynchronous
const data = await fs.promises.readFile('./large-file.json', 'utf8')
```

**Use Streams for Large Data**
```javascript
// Bad: Loading entire file into memory
const audio = await fs.promises.readFile('./track.mp3')
return audio

// Good: Streaming
return fs.createReadStream('./track.mp3')
```

### 4. Metadata Best Practices

Always provide complete metadata:

```javascript
export const pluginInfo = {
  name: 'my-plugin',
  description: 'Clear, concise description of what this does',
  version: '1.2.3',
  author: 'Your Name',
  homepage: 'https://github.com/yourusername/nodelink-plugin-my-plugin'
}
```

---

## Troubleshooting

### Plugin Not Loading

**Problem**: Plugin doesn't appear in `/v4/info`

**Solutions**:
1. Check file location: Must be in `src/plugins/src/` or named `nodelink-plugin-*`
2. Verify export format: Must export a default function or object with `register`/`init`
3. Check for syntax errors: Look at NodeLink startup logs
4. Ensure `pluginInfo` is properly exported

```javascript
// Correct
export const pluginInfo = { name: 'my-plugin', ... }
export default function myPlugin() { ... }

// Also correct
function myPlugin() { ... }
myPlugin.pluginInfo = { name: 'my-plugin', ... }
export default myPlugin
```

### Routes Not Working

**Problem**: Requests to plugin routes return 404

**Solutions**:
1. Verify route prefix: Must start with `/v4/`
2. Check HTTP method: Default is `['GET']`, specify others explicitly
3. Test route pattern: Use simple string first, then regex
4. Check logs for registration errors

```javascript
// Debug registration
pluginApi.addRoute('/v4/test', (server, req, res, sendResponse) => {
  pluginApi.logger('info', 'Test', 'Route called!')
  sendResponse(req, res, { ok: true }, 200)
}, ['GET'])
```

### Stream Interceptor Not Firing

**Problem**: Interceptor function never executes

**Solutions**:
1. Ensure source actually loads streams (not all sources use `loadStream`)
2. Check if track is from a source that supports streaming
3. Add logging to verify interceptor registration:

```javascript
pluginApi.registerStreamInterceptor(async (nodelink, track, url, protocol, additionalData, next) => {
  pluginApi.logger('info', 'Interceptor', `Called for: ${track.info.title}`)
  return await next()
})
```

### Configuration Not Loading

**Problem**: Plugin config is undefined

**Solutions**:
1. Verify `config.js` syntax: Must be valid JavaScript
2. Check nesting: `plugins.myPlugin.option`
3. Use fallback values:

```javascript
const config = nodelink.config?.plugins?.myPlugin || {}
const apiKey = config.apiKey || 'default-key'
```

### Memory Leaks

**Problem**: NodeLink memory usage grows over time

**Solutions**:
1. Clear caches periodically
2. Remove event listeners when done
3. Close streams properly:

```javascript
stream.on('end', () => {
  stream.destroy()
})

stream.on('error', (err) => {
  stream.destroy()
})
```

---

## Example Plugins

### Complete Example: Analytics Plugin

```javascript
// nodelink-plugin-analytics.js

export const pluginInfo = {
  name: 'analytics',
  description: 'Tracks playback statistics and provides analytics endpoints',
  version: '1.0.0',
  author: 'Your Name'
}

const stats = {
  totalPlays: 0,
  trackPlays: new Map(),
  sourceStats: new Map()
}

export default async function analyticsPlugin(nodelink, pluginApi) {
  const config = nodelink.config?.plugins?.analytics || {}
  
  if (!config.enabled) {
    return
  }
  
  // Hook into playback
  pluginApi.registerBeforePlay(async (nodelink, player, context) => {
    const track = context.track
    
    // Increment counters
    stats.totalPlays++
    
    const trackId = track.info.identifier
    stats.trackPlays.set(trackId, (stats.trackPlays.get(trackId) || 0) + 1)
    
    const source = track.info.sourceName
    stats.sourceStats.set(source, (stats.sourceStats.get(source) || 0) + 1)
    
    pluginApi.logger('debug', 'Analytics', `Tracked play: ${track.info.title}`)
  })
  
  // Endpoint: Get overall stats
  pluginApi.addRoute('/v4/analytics/stats', (server, req, res, sendResponse) => {
    sendResponse(req, res, {
      totalPlays: stats.totalPlays,
      uniqueTracks: stats.trackPlays.size,
      sources: Object.fromEntries(stats.sourceStats)
    }, 200)
  })
  
  // Endpoint: Get top tracks
  pluginApi.addRoute('/v4/analytics/top-tracks', (server, req, res, sendResponse) => {
    const sorted = Array.from(stats.trackPlays.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, plays]) => ({ trackId: id, plays }))
    
    sendResponse(req, res, sorted, 200)
  })
  
  // Endpoint: Reset stats
  pluginApi.addRoute('/v4/analytics/reset', (server, req, res, sendResponse) => {
    stats.totalPlays = 0
    stats.trackPlays.clear()
    stats.sourceStats.clear()
    
    pluginApi.logger('info', 'Analytics', 'Stats reset')
    sendResponse(req, res, { success: true }, 200)
  }, ['POST'])
  
  pluginApi.logger('info', 'Analytics', 'Plugin loaded')
}
```

---

## Additional Resources

### API Endpoints for Plugin Discovery

- **`GET /v4/plugins`**: Lists all registered plugin routes
- **`GET /v4/info`**: Shows loaded plugins with metadata

### Reference Implementation

Check the example plugin included with NodeLink:
```
src/plugins/src/example-plugin.js
```
