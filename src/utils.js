import util from 'node:util'
import zlib from 'node:zlib'
import { execSync } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }

const semverPattern =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

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
  const match = semverPattern.exec(version)
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

function verifyMethod(req, res, expected) {
  const methods = Array.isArray(expected) ? expected : [expected]
  // biome-ignore format: off
  if (!methods.includes(req.method)) {
    sendResponse(req, res, {
        timestamp: Date.now(),
        status: 405,
        error: 'Method Not Allowed',
        message: `Method must be one of ${methods.join(', ')}`
      }, 405)
    return false
  }
  return true
}

export { validateProperty, logger, getVersion, parseSemver, getGitInfo, verifyMethod }
