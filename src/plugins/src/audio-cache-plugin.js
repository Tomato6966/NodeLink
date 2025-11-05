import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'

function computeSha1Hex(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex')
}

async function ensureDirectoryExists(dir) {
  await fsp.mkdir(dir, { recursive: true }).catch(() => { })
}

function nowMilliseconds() {
  return Date.now()
}

export const pluginInfo = {
  name: 'audio-cache',
  description: 'Caches audio streams to disk with TTL and size limits',
  version: '1.0.0'
}

export default async function audioCachePlugin(nodelink, pluginApi) {
  const configuration = pluginApi.config?.plugins?.audioCache || {}
  const cacheDir = path.resolve(process.cwd(), configuration.dir || path.join('cache', 'audio'))
  const ttlDays = Number.isFinite(configuration.ttlDays) ? configuration.ttlDays : 7
  const cleanupIntervalHours = Number.isFinite(configuration.cleanupIntervalHours)
    ? configuration.cleanupIntervalHours
    : 12

  const maxSizeBytes = (() => {
    const value = configuration.maxSizeBytes ?? configuration.maxSize
    if (value == null) return null
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
    if (typeof value === 'string') {
      const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i)
      if (match) {
        const numberValue = parseFloat(match[1])
        const unit = (match[2] || 'b').toLowerCase()
        const multiplier = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
        return Math.max(0, Math.floor(numberValue * multiplier))
      }
    }
    return null
  })()

  const protectRecentMilliseconds = (() => {
    const minutes = configuration.protectRecentMinutes
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return Math.floor(minutes * 60 * 1000)
    return 0
  })()

  const allowExceedWhenAllRecent = Boolean(configuration.allowExceedWhenAllRecent)

  await ensureDirectoryExists(cacheDir)

  const inUse = new Map()

  function keyFor(track, url) {
    const t = track && typeof track === 'object' ? (track.info || track) : {}
    const idCandidate = t.identifier || t.uri || url || JSON.stringify(t)
    const source = t.sourceName || track?.sourceName || 'unknown'
    return `${source}-${computeSha1Hex(String(idCandidate))}`
  }

  function filePathForKey(key) {
    const shard = key.slice(0, 2)
    return path.join(cacheDir, shard, `${key}.dat`)
  }

  async function existsNonEmpty(p) {
    try {
      const st = await fsp.stat(p)
      return st.isFile() && st.size > 0
    } catch {
      return false
    }
  }

  function markUse(p, delta) {
    const cur = inUse.get(p) || 0
    const next = cur + delta
    if (next <= 0) inUse.delete(p)
    else inUse.set(p, next)
  }

  async function touch(p) {
    const now = new Date()
    try {
      await fsp.utimes(p, now, now)
    } catch { }
  }

  async function getStats() {
    let files = 0
    let bytes = 0
    async function walk(dir) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) {
          files++
          try {
            const st = await fsp.stat(p)
            bytes += st.size
          } catch { }
        }
      }
    }
    await walk(cacheDir)
    return { files, bytes, maxBytes: maxSizeBytes }
  }

  async function cleanup() {
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000
    const cutoff = nowMilliseconds() - ttlMs
    let removed = 0
    let bytesFreed = 0
    async function walk(dir) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(p)
          try {
            const left = await fsp.readdir(p)
            if (left.length === 0) await fsp.rmdir(p)
          } catch { }
        } else if (e.isFile()) {
          try {
            const st = await fsp.stat(p)
            const atime = st.atimeMs || st.mtimeMs || st.ctimeMs
            if (atime < cutoff && !inUse.has(p)) {
              await fsp.unlink(p)
              removed++
              bytesFreed += st.size || 0
            }
          } catch { }
        }
      }
    }
    await walk(cacheDir)
    pluginApi.logger('info', 'Plugin-Cache', `Cleanup finished. Removed ${removed} files, freed ${bytesFreed} bytes`)
    return { removed, bytesFreed }
  }

  async function currentFilesWithStats() {
    const out = []
    async function walk(dir) {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) {
          try {
            const st = await fsp.stat(p)
            out.push({ path: p, size: st.size || 0, atime: st.atimeMs || st.mtimeMs || st.ctimeMs })
          } catch { }
        }
      }
    }
    await walk(cacheDir)
    return out
  }

  async function trimToMax(reserveBytes = 0) {
    if (!maxSizeBytes || maxSizeBytes <= 0) return { removed: 0, bytesFreed: 0 }
    let files = await currentFilesWithStats()
    let total = files.reduce((acc, f) => acc + f.size, 0)
    const target = Math.max(0, maxSizeBytes - reserveBytes)
    if (total <= target) return { removed: 0, bytesFreed: 0 }

    // Build eviction candidates honoring in-use and recent-protection rules
    const now = nowMilliseconds()
    const notInUse = files.filter(f => !inUse.has(f.path))
    let candidates = notInUse
    if (protectRecentMilliseconds > 0) {
      candidates = candidates.filter(f => (f.atime || 0) < (now - protectRecentMilliseconds))
    }

    if (candidates.length === 0) {
      if (notInUse.length === 0) {
        pluginApi.logger('info', 'Plugin-Cache', `Trim skipped: all files in use; allowing overflow (total=${total}, target=${target})`)
        return { removed: 0, bytesFreed: 0 }
      }
      if (allowExceedWhenAllRecent) {
        pluginApi.logger('info', 'Plugin-Cache', `Trim skipped: all files are recent; allowing overflow (total=${total}, target=${target})`)
        return { removed: 0, bytesFreed: 0 }
      }
      files = notInUse
    } else {
      files = candidates
    }

    files.sort((a, b) => (a.atime || 0) - (b.atime || 0))
    let removed = 0
    let bytesFreed = 0
    for (const f of files) {
      if (total <= target) break
      if (inUse.has(f.path)) continue
      try {
        await fsp.unlink(f.path)
        removed++
        total -= f.size
        bytesFreed += f.size
      } catch { }
    }
    pluginApi.logger('info', 'Plugin-Cache', `Trimmed cache: removed ${removed}, freed ${bytesFreed} bytes, total~=${total}`)
    return { removed, bytesFreed }
  }

  pluginApi.addRoute('/v4/cache/stats', async (server, req, res, sendResponse) => {
    const s = await getStats()
    const cap = s.maxBytes || null
    const usage = cap ? Math.min(100, Math.round((s.bytes / cap) * 100)) : null
    sendResponse(req, res, { ok: true, files: s.files, bytes: s.bytes, maxBytes: cap, usagePercent: usage }, 200)
  })

  pluginApi.addRoute('/v4/cache/cleanup', async (server, req, res, sendResponse) => {
    const result = await cleanup()
    sendResponse(req, res, { ok: true, ...result }, 200)
  }, ['POST'])

  const intervalMs = cleanupIntervalHours * 60 * 60 * 1000
  const timer = setInterval(() => {
    cleanup()
      .then(() => trimToMax())
      .catch(() => { })
  }, intervalMs)
  timer.unref?.()

  pluginApi.registerStreamInterceptor(async (server, track, url, protocol, additionalData, next) => {
    const key = keyFor(track, url)
    const filePath = filePathForKey(key)
    await ensureDirectoryExists(path.dirname(filePath))

    if (await existsNonEmpty(filePath)) {
      pluginApi.logger('info', 'Plugin-Cache', `HIT key=${key} file=${filePath}`)
      await touch(filePath)
      markUse(filePath, 1)
      const readStream = fs.createReadStream(filePath)
      readStream.on('close', () => markUse(filePath, -1))
      readStream.once('end', () => readStream.emit('finishBuffering'))
      return { stream: readStream }
    }

    let original
    try {
      await trimToMax()
      original = await next()
    } catch (e) {
      throw e
    }

    try {
      pluginApi.logger('info', 'Plugin-Cache', `MISS key=${key} -> caching to ${filePath}`)
      try {
        const st0 = await fsp.stat(filePath)
        if (!st0 || st0.size === 0) await fsp.unlink(filePath).catch(() => { })
      } catch { }
      const teeStream = new PassThrough({ highWaterMark: 1 << 20 })
      const writeStream = fs.createWriteStream(filePath)
      let completed = false

      const originalStream = original?.stream || original
      originalStream.pipe(teeStream)
      teeStream.pipe(writeStream)

      originalStream.on?.('finishBuffering', () => {
        teeStream.emit('finishBuffering')
      })

      teeStream.on('close', async () => {
        try {
          const originalStream = original?.stream || original
          originalStream.destroy?.()
        } catch { }
        try {
          if (!completed) {
            const st = await fsp.stat(filePath).catch(() => null)
            if (!st || st.size === 0) await fsp.unlink(filePath).catch(() => { })
          }
        } catch { }
      })

      const cleanupOnError = (error) => {
        try { writeStream.destroy() } catch { }
        fsp.unlink(filePath).catch(() => { })
        if (!teeStream.destroyed && error) teeStream.destroy(error)
      }

      originalStream.on('error', cleanupOnError)
      teeStream.on('error', cleanupOnError)
      writeStream.on('error', cleanupOnError)

      writeStream.on('finish', async () => {
        completed = true
        touch(filePath).catch(() => { })
      })
      writeStream.on('close', async () => {
        if (!completed) {
          const st = await fsp.stat(filePath).catch(() => null)
          if (!st || st.size === 0) await fsp.unlink(filePath).catch(() => { })
        }
      })

      return { stream: teeStream, type: original?.type }
    } catch (e) {
      return original
    }
  })

  pluginApi.logger('info', 'Plugin-Cache', `audio-cache-plugin initialized at ${cacheDir} (ttlDays=${ttlDays})`)
}

// Attach metadata for discovery
audioCachePlugin.pluginInfo = pluginInfo
