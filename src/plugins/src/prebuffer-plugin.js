import { PassThrough } from 'node:stream'

function parseSize(input, fallback = 0) {
  if (input == null) return fallback
  if (typeof input === 'number' && Number.isFinite(input))
    return Math.max(0, input | 0)
  if (typeof input === 'string') {
    const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i)
    if (match) {
      const numberValue = parseFloat(match[1])
      const unit = (match[2] || 'b').toLowerCase()
      const multiplier =
        unit === 'gb'
          ? 1024 ** 3
          : unit === 'mb'
            ? 1024 ** 2
            : unit === 'kb'
              ? 1024
              : 1
      return Math.max(0, Math.floor(numberValue * multiplier))
    }
  }
  return fallback
}

export const pluginInfo = {
  name: 'prebuffer',
  description: 'Buffers initial bytes of non-live streams for smoother start',
  version: '1.0.0'
}

export default async function prebufferPlugin(nodelink, pluginApi) {
  const configuration = pluginApi.config?.plugins?.prebuffer || {}
  if (!configuration.enabled) {
    pluginApi.logger('info', 'Plugin-Prebuffer', 'Disabled by configuration')
    return
  }

  const targetBytes = parseSize(configuration.bytes, 512 * 1024)
  const timeoutMilliseconds =
    typeof configuration.timeoutMs === 'number' && configuration.timeoutMs > 0
      ? Math.floor(configuration.timeoutMs)
      : 0
  const highWaterMark =
    parseSize(configuration.highWaterMark, 1 << 20) || 1 << 20

  pluginApi.registerStreamInterceptor(
    async (server, track, url, protocol, additionalData, next) => {
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

      const output = new PassThrough({ highWaterMark })

      const release = () => {
        if (released) return
        released = true
        try {
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          for (const chunk of bufferChunks) {
            if (!output.destroyed) output.write(chunk)
          }
        } finally {
          bufferChunks.length = 0
        }
      }

      const startTimerIfNeeded = () => {
        if (timeoutMilliseconds > 0 && !timer) {
          timer = setTimeout(() => {
            release()
          }, timeoutMilliseconds)
          timer.unref?.()
        }
      }

      input.on('data', (chunk) => {
        if (released) {
          output.write(chunk)
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
        release()
        output.end()
        output.emit('finishBuffering')
      })

      input.on('close', () => {
        release()
        output.end()
      })

      input.on('error', (error) => {
        if (!output.destroyed) output.emit('error', error)
      })

      input.on?.('finishBuffering', () => {
        release()
        output.emit('finishBuffering')
      })

      output.on('close', () => {
        try {
          input.destroy?.()
        } catch {}
      })

      pluginApi.logger(
        'debug',
        'Plugin-Prebuffer',
        `Prebuffering up to ${targetBytes} bytes${timeoutMilliseconds ? ` or ${timeoutMilliseconds}ms` : ''} (highWaterMark=${highWaterMark})`
      )
      return { stream: output, type: original?.type }
    }
  )

  pluginApi.logger(
    'info',
    'Plugin-Prebuffer',
    `Initialized (bytes=${targetBytes}, timeoutMs=${timeoutMilliseconds}, highWaterMark=${highWaterMark})`
  )
}

// Attach metadata for discovery
prebufferPlugin.pluginInfo = pluginInfo
