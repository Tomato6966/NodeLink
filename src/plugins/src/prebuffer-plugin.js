import { PassThrough } from 'node:stream'

function parseSize(input, fallback = 0) {
  if (input == null) return fallback
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input | 0)
  if (typeof input === 'string') {
    const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i)
    if (m) {
      const num = parseFloat(m[1])
      const unit = (m[2] || 'b').toLowerCase()
      const mul = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1
      return Math.max(0, Math.floor(num * mul))
    }
  }
  return fallback
}

export default async function prebufferPlugin(nodelink, api) {
  const cfg = api.config?.plugins?.prebuffer || {}
  if (!cfg.enabled) {
    api.logger('info', 'Plugin-Prebuffer', 'Disabled by config')
    return
  }

  const targetBytes = parseSize(cfg.bytes, 512 * 1024)
  const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? Math.floor(cfg.timeoutMs) : 0
  const highWaterMark = parseSize(cfg.highWaterMark, 1 << 20) || (1 << 20)

  api.registerStreamInterceptor(async (server, track, url, protocol, additionalData, next) => {
    // Skip obvious live/continuous streams to avoid extra latency
    const isLive = Boolean(track?.info?.isStream)
    if (isLive || targetBytes <= 0) {
      return next()
    }

    const original = await next()
    const input = original?.stream || original
    if (!input || typeof input.on !== 'function') return original

    let released = false
    let bufferedBytes = 0
    let timer = null
    const bufferChunks = []

    const out = new PassThrough({ highWaterMark })

    const release = () => {
      if (released) return
      released = true
      try {
        if (timer) { clearTimeout(timer); timer = null }
        for (const chunk of bufferChunks) {
          if (!out.destroyed) out.write(chunk)
        }
      } finally {
        bufferChunks.length = 0
      }
    }

    const startTimerIfNeeded = () => {
      if (timeoutMs > 0 && !timer) {
        timer = setTimeout(() => {
          release()
        }, timeoutMs)
        timer.unref?.()
      }
    }

    // Wire events
    input.on('data', (chunk) => {
      if (released) {
        out.write(chunk)
        return
      }
      bufferChunks.push(chunk)
      bufferedBytes += chunk.length || 0
      if (bufferedBytes >= targetBytes) {
        release()
      } else {
        startTimerIfNeeded()
      }
    })

    input.on('end', () => {
      // Flush anything we have and close
      release()
      out.end()
      out.emit('finishBuffering')
    })

    input.on('close', () => {
      // Make sure to flush and end if closed before end
      release()
      out.end()
    })

    input.on('error', (err) => {
      // Propagate error
      if (!out.destroyed) out.emit('error', err)
    })

    // Forward finishBuffering marker from upstream if any
    input.on?.('finishBuffering', () => {
      // If upstream indicates done buffering, ensure we release
      release()
      out.emit('finishBuffering')
    })

    // If consumer destroys our out stream, stop reading
    out.on('close', () => {
      try { input.destroy?.() } catch {}
    })

    api.logger('debug', 'Plugin-Prebuffer', `Prebuffering up to ${targetBytes} bytes${timeoutMs ? ` or ${timeoutMs}ms` : ''} (hwm=${highWaterMark})`)
    return { stream: out, type: original?.type }
  })

  api.logger('info', 'Plugin-Prebuffer', `Initialized (bytes=${targetBytes}, timeoutMs=${timeoutMs}, hwm=${highWaterMark})`)
}

