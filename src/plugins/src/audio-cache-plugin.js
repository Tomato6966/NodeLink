import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'

function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex')
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true }).catch(() => { })
}

function nowMs() {
  return Date.now()
}

export default async function audioCachePlugin(nodelink, api) {
  const cfg = api.config?.plugins?.audioCache || {}
  const cacheDir = path.resolve(process.cwd(), cfg.dir || path.join('cache', 'audio'))
  const ttlDays = Number.isFinite(cfg.ttlDays) ? cfg.ttlDays : 7
  const cleanupIntervalHours = Number.isFinite(cfg.cleanupIntervalHours)
    ? cfg.cleanupIntervalHours
    : 12

  // Optional maximum cache size (bytes). Accepts number or string like '10GB'.
  const maxSizeBytes = (() => {
    const v = cfg.maxSizeBytes ?? cfg.maxSize
    if (v == null) return null
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    if (typeof v === 'string') {
      const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i)
      if (m) {
        const num = parseFloat(m[1])
        const unit = (m[2] || 'b').toLowerCase()
        const mul = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
        return Math.max(0, Math.floor(num * mul))
      }
    }
    return null
  })()

  // Optional: protect recently used files from eviction (minutes)
  const protectRecentMs = (() => {
    const v = cfg.protectRecentMinutes
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v * 60 * 1000)
    return 0
  })()

  // Optional: if all files are in-use or recently used, allow exceeding the cap
  const allowExceedWhenAllRecent = Boolean(cfg.allowExceedWhenAllRecent)

  await ensureDir(cacheDir)

  const inUse = new Map()

  function keyFor(track, url) {
    const t = track && typeof track === 'object' ? (track.info || track) : {}
    const idCandidate = t.identifier || t.uri || url || JSON.stringify(t)
    const source = t.sourceName || track?.sourceName || 'unknown'
    return `${source}-${sha1(String(idCandidate))}`
  }

  function filePathForKey(key) {
    const shard = key.slice(0, 2)
    return path.join(cacheDir, shard, `${key}.dat`)
  }

  async function exists(p) {
    try {
      await fsp.access(p)
      return true
    } catch {
      return false
    }
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
    const cutoff = nowMs() - ttlMs
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
    api.logger('info', 'Plugin-Cache', `Cleanup finished. Removed ${removed} files, freed ${bytesFreed} bytes`)
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
    const now = nowMs()
    const notInUse = files.filter(f => !inUse.has(f.path))
    let candidates = notInUse
    if (protectRecentMs > 0) {
      candidates = candidates.filter(f => (f.atime || 0) < (now - protectRecentMs))
    }

    if (candidates.length === 0) {
      if (notInUse.length === 0) {
        api.logger('info', 'Plugin-Cache', `Trim skipped: all files in use; allowing overflow (total=${total}, target=${target})`)
        return { removed: 0, bytesFreed: 0 }
      }
      if (allowExceedWhenAllRecent) {
        api.logger('info', 'Plugin-Cache', `Trim skipped: all files are recent; allowing overflow (total=${total}, target=${target})`)
        return { removed: 0, bytesFreed: 0 }
      }
      // Enforce cap by evicting least-recent not-in-use files (even if within protect window)
      files = notInUse
    } else {
      files = candidates
    }

    files.sort((a, b) => (a.atime || 0) - (b.atime || 0)) // oldest first
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
    api.logger('info', 'Plugin-Cache', `Trimmed cache: removed ${removed}, freed ${bytesFreed} bytes, totalâ‰ˆ${total}`)
    return { removed, bytesFreed }
  }

  api.addRoute('/v4/cache/stats', async (server, req, res, sendResponse) => {
    const s = await getStats()
    const cap = s.maxBytes || null
    const usage = cap ? Math.min(100, Math.round((s.bytes / cap) * 100)) : null
    sendResponse(req, res, { ok: true, files: s.files, bytes: s.bytes, maxBytes: cap, usagePercent: usage }, 200)
  })

  api.addRoute('/v4/cache/cleanup', async (server, req, res, sendResponse) => {
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

  api.registerStreamInterceptor(async (server, track, url, protocol, additionalData, next) => {
    const key = keyFor(track, url)
    const filePath = filePathForKey(key)
    await ensureDir(path.dirname(filePath))

    if (await existsNonEmpty(filePath)) {
      api.logger('info', 'Plugin-Cache', `HIT key=${key} file=${filePath}`)
      await touch(filePath)
      markUse(filePath, 1)
      const rs = fs.createReadStream(filePath)
      rs.on('close', () => markUse(filePath, -1))
      rs.once('end', () => rs.emit('finishBuffering'))
      return { stream: rs }
    }

    let original
    try {
      // Try to enforce cap before starting a new write
      await trimToMax()
      original = await next()
    } catch (e) {
      throw e
    }

    try {
      api.logger('info', 'Plugin-Cache', `MISS key=${key} -> caching to ${filePath}`)
      try {
        const st0 = await fsp.stat(filePath)
        if (!st0 || st0.size === 0) await fsp.unlink(filePath).catch(() => { })
      } catch { }
      const tee = new PassThrough({ highWaterMark: 1 << 20 })
      const ws = fs.createWriteStream(filePath)
      let completed = false

      const origStream = original?.stream || original
      origStream.pipe(tee)
      tee.pipe(ws)

      origStream.on?.('finishBuffering', () => {
        tee.emit('finishBuffering')
      })

      tee.on('close', async () => {
        try {
          const origStream = original?.stream || original
          origStream.destroy?.()
        } catch { }
        try {
          if (!completed) {
            const st = await fsp.stat(filePath).catch(() => null)
            if (!st || st.size === 0) await fsp.unlink(filePath).catch(() => { })
          }
        } catch { }
      })

      const cleanupOnError = (err) => {
        try { ws.destroy() } catch { }
        fsp.unlink(filePath).catch(() => { })
        if (!tee.destroyed && err) tee.destroy(err)
      }

      origStream.on('error', cleanupOnError)
      tee.on('error', cleanupOnError)
      ws.on('error', cleanupOnError)

      ws.on('finish', async () => {
        completed = true
        touch(filePath).catch(() => { })
      })
      ws.on('close', async () => {
        if (!completed) {
          const st = await fsp.stat(filePath).catch(() => null)
          if (!st || st.size === 0) await fsp.unlink(filePath).catch(() => { })
        }
      })

      return { stream: tee, type: original?.type }
    } catch (e) {
      return original
    }
  })

  api.logger('info', 'Plugin-Cache', `audio-cache-plugin initialized at ${cacheDir} (ttlDays=${ttlDays})`)
}
