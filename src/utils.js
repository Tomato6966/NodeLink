import util from 'node:util'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import zlib from 'node:zlib'
import { URL } from 'node:url'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import {
  SEMVER_PATTERN,
  DISCORD_ID_REGEX,
  DEFAULT_MAX_REDIRECTS,
  REDIRECT_STATUS_CODES,
  HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT
} from './constants.js'
import packageJson from '../package.json' with { type: 'json' }
const verifyDiscordID = id => DISCORD_ID_REGEX.test(String(id))

function validateProperty(property, validator, errorMessage) {
  if (!validator(property)) {
    throw new Error(errorMessage)
  }
}

function logger(level, ...args) {
  const levels = {
    info: { label: 'INFO', color: '\x1b[1m\x1b[3;42m' },
    warn: { label: 'WARN', color: '\x1b[1m\x1b[3;43m' },
    error: { label: 'ERROR', color: '\x1b[1m\x1b[3;41m' },
    debug: { label: 'DEBUG', color: '\x1b[1m\x1b[3;45m' },
    sources: { label: 'SOURCES', color: '\x1b[1m\x1b[3;46m' },
    started: { label: 'STARTED', color: '\x1b[1m\x1b[3;44m' }
  }

  const resetColor = '\x1b[0m'
  const time = new Date().toISOString().slice(11, 23)
  const lvl = levels[level] || levels.info
  // biome-ignore lint: no-unused-vars
  const prefix = args.length > 1 ? args[0] + ':' : ''
  const msg = args.length > 1 ? util.format(...args.slice(1)) : util.format(...args)

  console.log(`[${time}] ${lvl.color}[${lvl.label}]${resetColor} ${prefix} ${msg}`)
}

function parseSemver(version) {
  const match = SEMVER_PATTERN.exec(version)
  if (!match) return null
  const { major, minor, patch, prerelease, build } = match.groups
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
    build: build ? build.split('.') : []
  }
}

function getVersion(type = 'string') {
  if (type === 'object') {
    return parseSemver(packageJson.version)
  }
  if (type === 'string') {
    return packageJson.version
  }
}

export function sendResponse(req, res, data, status) {
  const headers = {}

  if (!data) {
    res.writeHead(status, headers)
    res.end()
    return
  }

  headers['Content-Type'] = 'application/json'
  const jsonData = JSON.stringify(data)

  const encoding = req.headers['accept-encoding'] || ''
  const compressions = [
    { type: 'br', method: zlib.brotliCompress },
    { type: 'gzip', method: zlib.gzip },
    { type: 'deflate', method: zlib.deflate }
  ]

  for (const { type, method } of compressions) {
    if (encoding.includes(type)) {
      headers['Content-Encoding'] = type
      method(jsonData, (err, result) => {
        if (err) {
          res.writeHead(500, {})
          res.end()
          return
        }
        res.writeHead(status, headers)
        res.end(result)
      })
      return
    }
  }

  res.writeHead(status, headers)
  res.end(jsonData)
}

function getGitInfo() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const commitTime =
      Number.parseInt(execSync('git log -1 --format=%ct', { encoding: 'utf8' }).trim(), 10) * 1000

    return {
      branch,
      commit,
      commitTime
    }
  } catch (error) {
    logger('warn', 'Git', 'Unable to retrieve git information. %s', error.message)
    return {
      branch: 'unknown',
      commit: 'unknown',
      commitTime: -1
    }
  }
}

function verifyMethod(parsedUrl, req, res, expected, clientAddress) {
  const methods = Array.isArray(expected) ? expected : [expected]
  // biome-ignore format: off
  if (!methods.includes(req.method)) {
    logger(
      'warn',
      'Server',
      `Method not allowed: ${req.method} ${parsedUrl.pathname} from ${clientAddress}`
    )
    sendResponse(req, res, {
        timestamp: Date.now(),
        status: 405,
        error: 'Method Not Allowed',
        message: `Method must be one of ${methods.join(', ')}`,
        path: parsedUrl.pathname,
      }, 405)
    return false
  }
  return true
}

function decodeTrack(encoded) {
  const buffer = Buffer.from(encoded, 'base64')
  let position = 0

  const read = {
    byte: () => buffer[position++],
    ushort: () => {
      const value = buffer.readUInt16BE(position)
      position += 2
      return value
    },
    int: () => {
      const value = buffer.readInt32BE(position)
      position += 4
      return value
    },
    long: () => {
      const value = buffer.readBigInt64BE(position)
      position += 8
      return value
    },
    utf: () => {
      const length = read.ushort()
      const value = buffer.toString('utf8', position, position + length)
      position += length
      return value
    }
  }

  const firstInt = read.int()
  const isVersioned = ((firstInt & 0xc0000000) >> 30) & 1
  const version = isVersioned ? read.byte() : 1

  return {
    encoded: encoded,
    info: {
      title: read.utf(),
      author: read.utf(),
      length: Number(read.long()),
      identifier: read.utf(),
      isSeekable: true,
      isStream: !!read.byte(),
      uri: version >= 2 && read.byte() ? read.utf() : null,
      artworkUrl: version === 3 && read.byte() ? read.utf() : null,
      isrc: version === 3 && read.byte() ? read.utf() : null,
      sourceName: read.utf(),
      position: Number(read.long())
    },
    pluginInfo: {},
    userData: {}
  }
}

function encodeTrack(track) {
  const bufferArray = []

  function write(type, value) {
    if (type === 'byte') bufferArray.push(Buffer.from([value]))
    if (type === 'ushort') {
      const buf = Buffer.alloc(2)
      buf.writeUInt16BE(value)
      bufferArray.push(buf)
    }
    if (type === 'int') {
      const buf = Buffer.alloc(4)
      buf.writeInt32BE(value)
      bufferArray.push(buf)
    }
    if (type === 'long') {
      const buf = Buffer.alloc(8)
      buf.writeBigInt64BE(BigInt(value))
      bufferArray.push(buf)
    }
    if (type === 'utf') {
      const strBuf = Buffer.from(value, 'utf8')
      write('ushort', strBuf.length)
      bufferArray.push(strBuf)
    }
  }

  const version = track.artworkUrl || track.isrc ? 3 : track.uri ? 2 : 1

  const isVersioned = version > 1 ? 1 : 0
  const firstInt = isVersioned << 30
  write('int', firstInt)

  if (isVersioned) {
    write('byte', version)
  }

  write('utf', track.title)
  write('utf', track.author)
  write('long', track.length)
  write('utf', track.identifier)
  write('byte', track.isStream ? 1 : 0)

  if (version >= 2) {
    write('byte', track.uri ? 1 : 0)
    if (track.uri) write('utf', track.uri)
  }

  if (version === 3) {
    write('byte', track.artworkUrl ? 1 : 0)
    if (track.artworkUrl) write('utf', track.artworkUrl)

    write('byte', track.isrc ? 1 : 0)
    if (track.isrc) write('utf', track.isrc)
  }

  write('utf', track.sourceName)
  write('long', track.position)

  return Buffer.concat(bufferArray).toString('base64')
}

const generateRandomLetters = l =>
  Array.from(crypto.randomBytes(l), b =>
    String.fromCharCode((b % 52) + (b % 52 < 26 ? 65 : 71))
  ).join('')

function parseClient(agent) {
  if (typeof agent !== 'string' || !agent.trim()) return null

  const [core, metaPart] = agent.trim().split(' ', 2)
  const [name, version] = core.split('/')
  if (!name) return null

  const info = { name }
  if (version) info.version = version
  // biome-ignore lint: uses-unsafe-optional-chaining
  if (metaPart && metaPart.startsWith('(') && metaPart.endsWith(')')) {
    const meta = metaPart.slice(1, -1)
    if (meta.startsWith('http')) {
      info.url = meta
    } else {
      const [tag, date] = meta.split('/')
      if (tag) info.codename = tag
      if (date) info.releaseDate = date
    }
  }

  return info
}

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

async function http1makeRequest(urlString, options = {}) {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeout = 30000,
    streamOnly = false,
    disableBodyCompression = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    _redirectsFollowed = 0
  } = options

  if (_redirectsFollowed >= maxRedirects) {
    throw new Error(`Too many redirects (${maxRedirects}) for ${urlString}`)
  }

  const currentUrl = new URL(urlString)
  const isHttps = currentUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const agent = isHttps ? httpsAgent : httpAgent

  const reqHeaders = {
    'Accept-Encoding': 'br, gzip, deflate',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ...customHeaders
  }

  let payloadBuffer = null
  if (body != null && !['GET', 'HEAD'].includes(method)) {
    reqHeaders['Content-Type'] = reqHeaders['Content-Type'] || 'application/json'
    const rawPayload = typeof body === 'string' ? body : JSON.stringify(body)

    if (disableBodyCompression) {
      payloadBuffer = Buffer.from(rawPayload)
    } else {
      reqHeaders['Content-Encoding'] = 'gzip'
      payloadBuffer = zlib.gzipSync(rawPayload)
    }
  }

  const reqOptions = {
    method,
    agent,
    timeout,
    hostname: currentUrl.hostname,
    port: currentUrl.port || (isHttps ? 443 : 80),
    path: currentUrl.pathname + currentUrl.search,
    headers: reqHeaders
  }

  return new Promise((resolve, reject) => {
    const req = lib.request(reqOptions, res => {
      const { statusCode, headers: respHeaders } = res

      if (REDIRECT_STATUS_CODES.includes(statusCode) && respHeaders.location) {
        res.resume()
        const nextUrl = new URL(respHeaders.location, currentUrl).href
        const isGetRedirect = [301, 302, 303].includes(statusCode)
        const nextOptions = {
          ...options,
          _redirectsFollowed: _redirectsFollowed + 1,
          method: isGetRedirect ? 'GET' : method,
          body: isGetRedirect ? undefined : body
        }
        resolve(http1makeRequest(nextUrl, nextOptions))
        return
      }

      let finalStream = res
      const encoding = (respHeaders['content-encoding'] || '').toLowerCase()
      if (encoding === 'br') {
        finalStream = res.pipe(zlib.createBrotliDecompress())
      } else if (encoding === 'gzip') {
        finalStream = res.pipe(zlib.createGunzip())
      } else if (encoding === 'deflate') {
        finalStream = res.pipe(zlib.createInflate())
      }

      res.on('error', err => reject(new Error(`Response error for ${urlString}: ${err.message}`)))
      if (finalStream !== res) {
        finalStream.on('error', err =>
          reject(new Error(`Decompression error for ${urlString}: ${err.message}`))
        )
      }

      if (streamOnly) {
        resolve({ statusCode, headers: respHeaders, stream: finalStream })
        return
      }

      const chunks = []
      finalStream.on('data', chunk => chunks.push(chunk))
      finalStream.on('end', () => {
        try {
          const responseBuffer = Buffer.concat(chunks)
          const text = responseBuffer.toString('utf8')
          const isJson = (respHeaders['content-type'] || '')
            .toLowerCase()
            .startsWith('application/json')
          const responseBody = isJson && text ? JSON.parse(text) : text
          resolve({ statusCode, headers: respHeaders, body: responseBody })
        } catch (err) {
          reject(new Error(`Error processing response body for ${urlString}: ${err.message}`))
        }
      })
    })

    req.on('error', err => reject(new Error(`Request error for ${urlString}: ${err.message}`)))
    req.on('timeout', () =>
      req.destroy(new Error(`Request timed out after ${timeout}ms for ${urlString}`))
    )

    if (payloadBuffer) {
      req.end(payloadBuffer)
    } else {
      req.end()
    }
  })
}
async function makeRequest(urlString, options = {}) {
  const {
    method = 'GET',
    headers: customHeaders = {},
    body,
    timeout = 30000,
    streamOnly = false,
    disableBodyCompression = false,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    _redirectsFollowed = 0
  } = options
  if (_redirectsFollowed >= maxRedirects) {
    return Promise.reject(new Error(`Too many redirects (${maxRedirects}) for ${urlString}`))
  }

  return new Promise((resolve, reject) => {
    let session
    let sessionClosed = false
    let currentUrl

    const fallbackToHttp1 = () => {
      if (!sessionClosed && session) {
        sessionClosed = true
        session.close()
      }
      resolve(http1makeRequest(urlString, options))
    }

    try {
      currentUrl = new URL(urlString)
      session = http2.connect(currentUrl.origin)

      const closeSessionGracefully = () => {
        if (session && !session.closed && !session.destroyed && !sessionClosed) {
          sessionClosed = true
          session.close()
        }
      }

      session.on('error', fallbackToHttp1)
      session.on('goaway', closeSessionGracefully)

      const h2Headers = {
        ':method': method,
        ':path': currentUrl.pathname + currentUrl.search,
        ':scheme': currentUrl.protocol.slice(0, -1),
        ':authority': currentUrl.host,
        'accept-encoding': 'br, gzip, deflate',
        'user-agent': 'Mozilla/5.0 (Node.js Http2Client)',
        dnt: '1',
        ...customHeaders
      }

      if (body && !['GET', 'HEAD'].includes(method)) {
        headers['Content-Type'] =
          typeof body === 'object' ? 'application/json' : headers['Content-Type']
        if (!disableBodyCompression) h2Headers['content-encoding'] = 'gzip'
      }

      const req = session.request(h2Headers)
      let reqClosed = false

      if (timeout) {
        req.setTimeout(timeout, () => {
          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_CANCEL)
          }
          closeSessionGracefully()
          reject(new Error(`HTTP/2 request timeout for ${urlString}`))
        })
      }

      req.on('error', err => {
        if (!reqClosed) reqClosed = true
        closeSessionGracefully()
        reject(new Error(`HTTP/2 request error for ${urlString}: ${err.message}`))
      })

      req.on('response', async headers => {
        const statusCode = headers[':status']

        if (REDIRECT_STATUS_CODES.includes(statusCode) && headers.location) {
          const newLocation = new URL(headers.location, urlString).href
          let nextMethod = method
          let nextBody = body
          if (
            (statusCode === 301 || statusCode === 302) &&
            ['POST', 'PUT', 'DELETE'].includes(method)
          ) {
            nextMethod = 'GET'
            nextBody = undefined
          } else if (statusCode === 303) {
            nextMethod = 'GET'
            nextBody = undefined
          }

          if (!reqClosed) {
            reqClosed = true
            req.close(http2.constants.NGHTTP2_NO_ERROR)
          }
          closeSessionGracefully()
          return resolve(
            makeRequest(newLocation, {
              ...options,
              method: nextMethod,
              body: nextBody,
              _redirectsFollowed: _redirectsFollowed + 1,
              disableBodyCompression: nextBody ? disableBodyCompression : undefined
            })
          )
        }

        let responseStream = req
        const encoding = headers['content-encoding']
        if (encoding === 'br') responseStream = req.pipe(zlib.createBrotliDecompress())
        else if (encoding === 'gzip') responseStream = req.pipe(zlib.createGunzip())
        else if (encoding === 'deflate') responseStream = req.pipe(zlib.createInflate())

        if (method === 'HEAD') {
          closeSessionGracefully()
          return resolve({ statusCode, headers })
        }

        if (streamOnly) {
          responseStream.on('end', closeSessionGracefully)
          responseStream.on('error', closeSessionGracefully)
          responseStream.on('close', closeSessionGracefully)
          return resolve({ statusCode, headers, stream: responseStream })
        }

        try {
          const chunks = []
          for await (const chunk of responseStream) chunks.push(chunk)
          const text = Buffer.concat(chunks).toString()
          const isJson = (headers['content-type'] || '')
            .toLowerCase()
            .startsWith('application/json')
          resolve({
            statusCode,
            headers,
            body: isJson && text ? JSON.parse(text) : text
          })
        } catch (err) {
          resolve({ statusCode, headers, error: err.message })
        } finally {
          if (!streamOnly) closeSessionGracefully()
        }
      })

      if (body && !['GET', 'HEAD'].includes(method)) {
        const payload = JSON.stringify(body)
        if (disableBodyCompression || h2Headers['content-encoding'] !== 'gzip') {
          req.end(payload)
        } else {
          zlib.gzip(payload, (err, data) => {
            if (err) {
              req.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
              closeSessionGracefully()
              return reject(new Error(`Gzip error for ${urlString}: ${err.message}`))
            }
            req.end(data)
          })
        }
      } else {
        req.end()
      }
    } catch (err) {
      if (session && !session.closed && !session.destroyed && !sessionClosed) {
        session.close()
      }
      fallbackToHttp1()
    }
  })
}
function loadHLS(url, stream, onceEnded = false, shouldEnd = true) {
  //biome-ignore lint: no-promise-executor-return
  return new Promise(async resolve => {
    try {
      const res = await http1makeRequest(url, { method: 'GET' })
      const lines = res.body
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

      if (!lines.some(l => l.startsWith('#EXTINF'))) {
        const seg = await http1makeRequest(url, { method: 'GET', streamOnly: true })
        seg.stream.pipe(stream, { end: shouldEnd })
        return resolve(!shouldEnd)
      }

      const base = new URL(url)
      const segs = []
      let sawEnd = false

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF')) {
          const uri = lines[i + 1]
          if (uri && !uri.startsWith('#')) {
            segs.push(new URL(uri, base).toString())
          }
        }
        if (lines[i].startsWith('#EXT-X-ENDLIST')) sawEnd = true
      }

      const downloadPromises = []

      const writeChunksToStream = async chunks => {
        for (const chunk of chunks) {
          if (!stream.write(chunk)) {
            await new Promise(ok => stream.once('drain', ok))
          }
        }
      }

      for (const segUrl of segs) {
        if (stream.destroyed) break

        const downloadPromise = http1makeRequest(segUrl, { method: 'GET', streamOnly: true })
          .then(s => {
            return new Promise((res, rej) => {
              const chunks = []
              s.stream.on('data', chunk => chunks.push(chunk))
              s.stream.on('end', () => res(chunks))
              s.stream.on('error', rej)
            })
          })
          .catch(err => {
            if (!stream.destroyed) {
              console.error('[HLS] Error downloading segment', err.code || err.message)
              stream.destroy(err)
            }
            return Promise.reject(err)
          })

        downloadPromises.push(downloadPromise)

        if (downloadPromises.length >= HLS_SEGMENT_DOWNLOAD_CONCURRENCY_LIMIT) {
          if (stream.destroyed) break
          try {
            const chunks = await downloadPromises.shift()
            await writeChunksToStream(chunks)
          } catch (e) {
            break
          }
        }
      }

      while (downloadPromises.length > 0) {
        if (stream.destroyed) break
        try {
          const chunks = await downloadPromises.shift()
          await writeChunksToStream(chunks)
        } catch (e) {
          break
        }
      }

      if (stream.destroyed) {
        return resolve(false)
      }

      if (!sawEnd) {
        resolve(true)
      } else {
        shouldEnd && stream.emit('finishBuffering')
        resolve(false)
      }
    } catch (e) {
      console.error('[HLS] ERR →', e.code || e.message)
      if (!stream.destroyed) {
        shouldEnd && stream.emit('finishBuffering')
      }
      resolve(false)
    }
  })
}

async function loadHLSPlaylist(url, stream) {
  try {
    const res = await http1makeRequest(url, { method: 'GET' })
    const lines = res.body
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)

    if (lines.some(l => l.startsWith('#EXTINF'))) {
      return loadHLS(url, stream, false, true)
    }

    const audioTags = lines.filter(
      l => l.startsWith('#EXT-X-MEDIA') && l.includes('TYPE=AUDIO') && l.includes('URI="')
    )
    if (audioTags.length) {
      const defaultTag = audioTags.find(l => /DEFAULT=YES/.test(l))
      const pickTag = defaultTag || audioTags[audioTags.length - 1]
      const uri = pickTag.match(/URI="([^"]+)"/)[1]
      const audioUrl = new URL(uri, url).toString()
      return loadHLS(audioUrl, stream, false, true)
    }

    return loadHLS(url, stream, false, true)
  } catch (e) {
    console.error('[HLS-AUDIO] ERR →', e.code || e.message)
    stream.emit('finishBuffering')
    return stream
  }
}

export {
  validateProperty,
  logger,
  getVersion,
  parseSemver,
  getGitInfo,
  verifyMethod,
  decodeTrack,
  encodeTrack,
  generateRandomLetters,
  parseClient,
  verifyDiscordID,
  makeRequest,
  http1makeRequest,
  loadHLSPlaylist,
  loadHLS
}
