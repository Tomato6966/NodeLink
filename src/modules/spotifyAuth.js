import crypto from 'node:crypto'
import { http1makeRequest, logger } from '../utils.ts'

const ENCODED_SECRETS = [
  { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
  { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
  { secret: '{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH', version: 59 }
]

function decodeSecret(encoded) {
  const t = 33
  const n = 9

  const byteValues = encoded.split('').map((char, index) => {
    return char.charCodeAt(0) ^ ((index % t) + n)
  })

  const joined = byteValues.join('')
  const asciiBuffer = Buffer.from(joined, 'utf8')
  const hexString = asciiBuffer.toString('hex')

  return Buffer.from(hexString, 'hex')
}

let currentTotpSecret = null
let currentTotpVersion = null
let lastSecretFetchTime = 0
const SECRET_FETCH_INTERVAL = 60 * 60 * 1000

const SECRETS_URL =
  'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
const USER_AGENT_MOBILE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

async function ensureTotpSecrets() {
  const now = Date.now()
  if (currentTotpSecret && now - lastSecretFetchTime < SECRET_FETCH_INTERVAL)
    return

  try {
    const res = await http1makeRequest(SECRETS_URL, {
      headers: { Accept: 'application/json' }
    })
    if (res.statusCode !== 200 || !res.body)
      throw new Error('Failed to fetch secrets')

    const secrets =
      typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    const versions = Object.keys(secrets).map(Number)
    const newestVersion = Math.max(...versions).toString()

    const secretData = secrets[newestVersion]
    const mappedData = secretData.map(
      (value, index) => value ^ ((index % 33) + 9)
    )

    currentTotpSecret = Buffer.from(mappedData.join(''), 'utf8').toString('hex')
    currentTotpVersion = newestVersion
    lastSecretFetchTime = now
  } catch (e) {
    logger(
      'warn',
      'SpotifyAuth',
      `Error fetching TOTP secrets: ${e.message}. Using fallback.`
    )
    if (!currentTotpSecret) {
      const fallbackData = [
        99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95,
        75, 94, 49, 69, 36, 85, 64, 74, 60
      ]
      const mapped = fallbackData.map(
        (value, index) => value ^ ((index % 33) + 9)
      )
      currentTotpSecret = Buffer.from(mapped.join(''), 'utf8').toString('hex')
      currentTotpVersion = '19'
    }
  }
}

async function getServerTime(spDc) {
  try {
    const headers = { 'User-Agent': USER_AGENT_MOBILE }
    if (spDc) headers['Cookie'] = `sp_dc=${spDc}`

    const res = await http1makeRequest(
      'https://open.spotify.com/api/server-time',
      {
        headers
      }
    )
    if (res.statusCode !== 200 || !res.body)
      throw new Error('Failed to get time')
    const data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    return data.serverTime
  } catch {
    return Date.now()
  }
}

function generateTOTP(secretHex, timeSec, step = 30) {
  const counter = Math.floor(timeSec / step)
  const buf = Buffer.alloc(8)
  buf.writeBigInt64BE(BigInt(counter))

  const hmac = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex'))
  hmac.update(buf)
  const digest = hmac.digest()

  const offset = digest[digest.length - 1] & 0xf
  const code =
    (((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)) %
    1000000

  return code.toString().padStart(6, '0')
}

async function performTokenRequest(secret, version, spDc, productType) {
  const serverTimeMs = await getServerTime(spDc)
  const serverTimeSec = Math.floor(serverTimeMs / 1000)
  const localTimeSec = Math.floor(Date.now() / 1000)

  const totpLocal = generateTOTP(secret, localTimeSec, 30)
  const totpServer = generateTOTP(secret, serverTimeSec, 900)

  const url = new URL('https://open.spotify.com/api/token')
  url.searchParams.append('reason', 'init')
  url.searchParams.append('productType', productType)
  url.searchParams.append('totp', totpLocal)
  url.searchParams.append('totpVer', version)
  url.searchParams.append('totpServer', totpServer)

  const headers = {
    'User-Agent': USER_AGENT_MOBILE,
    Origin: 'https://open.spotify.com/',
    Referer: 'https://open.spotify.com/'
  }

  if (spDc) {
    headers['Cookie'] = `sp_dc=${spDc}`
  }

  const res = await http1makeRequest(url.toString(), {
    method: 'GET',
    headers
  })

  if (res.statusCode !== 200 || !res.body) {
    throw new Error(`Spotify Auth Error: ${res.statusCode}`)
  }

  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body
}

export async function getLocalToken(spDc, productType = 'mobile-web-player') {
  try {
    const nativeSecret = decodeSecret(ENCODED_SECRETS[0].secret).toString('hex')
    const nativeVersion = String(ENCODED_SECRETS[0].version)
    return await performTokenRequest(
      nativeSecret,
      nativeVersion,
      spDc,
      productType
    )
  } catch (e) {
    await ensureTotpSecrets()
    return await performTokenRequest(
      currentTotpSecret,
      currentTotpVersion || '19',
      spDc,
      productType
    )
  }
}
