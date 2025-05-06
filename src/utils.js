import util from 'node:util'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { SEMVER_PATTERN, DISCORD_ID_REGEX } from './constants.js'
import packageJson from '../package.json' with { type: 'json' }

const verifyDiscordID = id => DISCORD_ID_REGEX.test(String(id))

function validateProperty(property, validator, errorMessage) {
  if (!validator(property)) {
    throw new Error(errorMessage)
  }
}

function logger(level, ...args) {
  const levels = {
    info: { label: 'INFO', color: '\x1b[1m\x1b[32m' },
    warn: { label: 'WARN', color: '\x1b[1m\x1b[33m' },
    error: { label: 'ERROR', color: '\x1b[1m\x1b[31m' },
    debug: { label: 'DEBUG', color: '\x1b[1m\x1b[34m' }
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
  const headers = { 'Nodelink-Api-Version': '4' }

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
          res.writeHead(500, { 'Nodelink-Api-Version': '4' })
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
  verifyDiscordID
}
