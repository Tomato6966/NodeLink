import crypto from 'node:crypto'
import { http1makeRequest, logger } from '../utils.js'

let currentTotpSecret = null
let currentTotpVersion = null
let lastSecretFetchTime = 0
const SECRET_FETCH_INTERVAL = 60 * 60 * 1000

const SECRETS_URL = 'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json'
const USER_AGENT_MOBILE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'

async function ensureTotpSecrets() {
  const now = Date.now()
  if (currentTotpSecret && (now - lastSecretFetchTime < SECRET_FETCH_INTERVAL)) return

  try {
    const res = await http1makeRequest(SECRETS_URL, { headers: { Accept: 'application/json' } })
    if (res.statusCode !== 200 || !res.body) throw new Error('Failed to fetch secrets')
    
    const secrets = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    const versions = Object.keys(secrets).map(Number)
    const newestVersion = Math.max(...versions).toString()
    
    const secretData = secrets[newestVersion]
    const mappedData = secretData.map((value, index) => value ^ ((index % 33) + 9))
    
    currentTotpSecret = Buffer.from(mappedData.join(''), 'utf8').toString('hex')
    currentTotpVersion = newestVersion
    lastSecretFetchTime = now
  } catch (e) {
    logger('warn', 'SpotifyAuth', `Error fetching TOTP secrets: ${e.message}. Using fallback.`)
    if (!currentTotpSecret) {
      const fallbackData = [99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95, 75, 94, 49, 69, 36, 85, 64, 74, 60]
      const mapped = fallbackData.map((value, index) => value ^ ((index % 33) + 9))
      currentTotpSecret = Buffer.from(mapped.join(''), 'utf8').toString('hex')
      currentTotpVersion = '19'
    }
  }
}

async function getServerTime(spDc) {
  try {
    const res = await http1makeRequest('https://open.spotify.com/api/server-time', {
      headers: {
        'User-Agent': USER_AGENT_MOBILE,
        'Cookie': `sp_dc=${spDc}`
      }
    })
    if (res.statusCode !== 200 || !res.body) throw new Error('Failed to get time')
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
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % 1000000

  return code.toString().padStart(6, '0')
}

export async function getLocalToken(spDc, productType = 'mobile-web-player') {
  await ensureTotpSecrets()
  const serverTimeMs = await getServerTime(spDc)
  const serverTimeSec = Math.floor(serverTimeMs / 1000)
  const localTimeSec = Math.floor(Date.now() / 1000)

  // Standard 30s window for 'totp'
  const totpLocal = generateTOTP(currentTotpSecret, localTimeSec, 30)
  // 15-minute (900s) window for 'totpServer' (30 * 30 = 900)
  const totpServer = generateTOTP(currentTotpSecret, serverTimeSec, 900)

  const url = new URL('https://open.spotify.com/api/token')
  url.searchParams.append('reason', 'init')
  url.searchParams.append('productType', productType)
  url.searchParams.append('totp', totpLocal)
  url.searchParams.append('totpVer', currentTotpVersion || '19')
  url.searchParams.append('totpServer', totpServer)

  const res = await http1makeRequest(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT_MOBILE,
      'Origin': 'https://open.spotify.com/',
      'Referer': 'https://open.spotify.com/',
      'Cookie': `sp_dc=${spDc}`
    }
  })

  if (res.statusCode !== 200 || !res.body) {
    throw new Error(`Spotify Auth Error: ${res.statusCode}`)
  }

  return typeof res.body === 'string' ? JSON.parse(res.body) : res.body
}
