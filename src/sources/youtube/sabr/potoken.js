import { Buffer } from 'node:buffer'
import { base64ToU8 } from './protor.js'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../../../utils.js'
import { JSDOM } from 'jsdom'

const TOKENS_LOG_PATH = path.join(process.cwd(), 'po_tokens.jsonl')

const PO_CONFIG = {
  apiKey: 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  ytBaseUrl: 'https://www.youtube.com',
  googBaseUrl: 'https://jnn-pa.googleapis.com'
}

const textEncoder = new TextEncoder()

class DeferredPromise {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

function u8ToBase64(u8, base64url = false) {
  if (!base64url) return Buffer.from(u8).toString('base64')

  if (Buffer.isEncoding?.('base64url')) {
    return Buffer.from(u8).toString('base64url')
  }
  let s = Buffer.from(u8)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
  const pad = s.indexOf('=')
  return pad === -1 ? s : s.slice(0, pad)
}

function buildURL(endpointName, useYouTubeAPI) {
  return `${useYouTubeAPI ? PO_CONFIG.ytBaseUrl : PO_CONFIG.googBaseUrl}/${useYouTubeAPI ? 'api/jnn/v1' : '$rpc/google.internal.waa.v1.Waa'}/${endpointName}`
}

class BotGuardClient {
  constructor(options) {
    this.deferredVmFunctions = new DeferredPromise()
    this.defaultTimeout = 3000
    this.vm = options.globalObj[options.globalName]
    this.program = options.program
  }

  static async create(options) {
    return await new BotGuardClient(options).load()
  }

  async load() {
    if (!this.vm) throw new Error('VM not found')
    if (!this.vm.a) throw new Error('VM init function not found')

    const vmFunctionsCallback = (
      asyncSnapshotFunction,
      shutdownFunction,
      passEventFunction,
      checkCameraFunction
    ) => {
      this.deferredVmFunctions.resolve({
        asyncSnapshotFunction,
        shutdownFunction,
        passEventFunction,
        checkCameraFunction
      })
    }

    try {
      this.syncSnapshotFunction = (
        await this.vm.a(
          this.program,
          vmFunctionsCallback,
          true,
          undefined,
          () => {},
          [[], []]
        )
      )[0]
    } catch (error) {
      throw new Error(`Could not load program: ${error.message}`)
    }

    return this
  }

  async snapshot(args, timeout = this.defaultTimeout) {
    const vmFunctions = await this.deferredVmFunctions.promise
    if (!vmFunctions.asyncSnapshotFunction)
      throw new Error('Asynchronous snapshot function not found')

    return await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('VM operation timed out')),
        timeout
      )
      if (t.unref) t.unref()

      vmFunctions.asyncSnapshotFunction(
        (response) => {
          clearTimeout(t)
          resolve(response)
        },
        [
          args.contentBinding,
          args.signedTimestamp,
          args.webPoSignalOutput,
          args.skipPrivacyBuffer
        ]
      )
    })
  }
}

class WebPoMinter {
  constructor(mintCallback) {
    this.mintCallback = mintCallback
  }

  static async create(integrityToken, webPoSignalOutput) {
    const getMinter = webPoSignalOutput[0]
    if (!getMinter) throw new Error('PMD:Undefined')
    if (!integrityToken) throw new Error('No integrity token provided')

    const mintCallback = await getMinter(base64ToU8(integrityToken))
    if (!(mintCallback instanceof Function)) throw new Error('APF:Failed')

    return new WebPoMinter(mintCallback)
  }

  async mintAsWebsafeString(identifier) {
    return u8ToBase64(await this.mint(identifier), true)
  }

  async mint(identifier) {
    const result = await this.mintCallback(textEncoder.encode(identifier))
    if (!result) throw new Error('YNJ:Undefined')
    if (!(result instanceof Uint8Array)) throw new Error('ODM:Invalid')
    return result
  }
}

export class PoTokenManager {
  constructor() {
    this.botguard = null
    this.minter = null
    this.visitorData = null
    this.integrityToken = null

    this._dom = null
    this._prevGlobals = null
  }

  _applyDomGlobals(dom) {
    if (!this._prevGlobals) {
      const g = globalThis
      this._prevGlobals = {
        window: g.window,
        document: g.document,
        location: g.location,
        origin: g.origin,
        hadNavigator: Reflect.has(g, 'navigator')
      }
    }

    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin
    })

    if (!this._prevGlobals.hadNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true
      })
    }
  }

  _cleanupDom() {
    if (this._dom) {
      this._dom.window.close()
      this._dom = null
    }

    const p = this._prevGlobals
    if (!p) return

    const g = globalThis
    for (const k of ['window', 'document', 'location', 'origin']) {
      if (p[k] === undefined) delete g[k]
      else g[k] = p[k]
    }
    if (!p.hadNavigator) delete g.navigator

    this._prevGlobals = null
  }

  async fetchVisitorData() {
    try {
      const response = await fetch('https://www.youtube.com', {
        headers: { 'user-agent': PO_CONFIG.userAgent }
      })
      const html = await response.text()

      const marker = '"VISITOR_DATA":"'
      const start = html.indexOf(marker)
      if (start !== -1) {
        const from = start + marker.length
        const end = html.indexOf('"', from)
        if (end !== -1) return html.slice(from, end)
      }

      throw new Error('Could not find visitorData in HTML')
    } catch (error) {
      logger(
        'error',
        'PoToken',
        `Failed to fetch visitorData: ${error.message}`
      )
      return ''
    }
  }

  async getAttestationChallenge(visitorData) {
    const response = await fetch(
      `${PO_CONFIG.ytBaseUrl}/youtubei/v1/att/get?key=${PO_CONFIG.apiKey}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': PO_CONFIG.userAgent,
          'x-goog-api-key': PO_CONFIG.apiKey,
          'x-youtube-client-name': '1',
          'x-youtube-client-version': '2.20260114.01.00'
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20260114.01.00',
              visitorData
            }
          },
          engagementType: 'ENGAGEMENT_TYPE_UNBOUND'
        })
      }
    )

    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(
        `Failed to parse attestation response (Status ${response.status}): ${text.slice(0, 500)}`
      )
    }

    if (!data.bgChallenge)
      throw new Error(`No bgChallenge in response: ${text.slice(0, 500)}`)

    return {
      bg_challenge: {
        program: data.bgChallenge.program,
        global_name: data.bgChallenge.globalName,
        interpreter_url: {
          private_do_not_access_or_else_trusted_resource_url_wrapped_value:
            data.bgChallenge.interpreterUrl
              .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue
        }
      }
    }
  }

  async initialize(existingVisitorData) {
    if (
      existingVisitorData &&
      this.visitorData &&
      existingVisitorData !== this.visitorData
    ) {
      logger(
        'debug',
        'PoToken',
        `VisitorData changed (old: ${this.visitorData.slice(0, 10)}..., new: ${existingVisitorData.slice(0, 10)}...). Resetting.`
      )
      this.reset()
    }

    if (this.botguard && this.minter) return

    logger('debug', 'PoToken', 'Initializing BotGuard...')

    if (existingVisitorData) {
      this.visitorData = existingVisitorData
    } else {
      this.visitorData = await this.fetchVisitorData()
    }
    logger(
      'debug',
      'PoToken',
      `VisitorData: ${this.visitorData?.slice(0, 20)}...`
    )

    this._cleanupDom()
    this._dom = new JSDOM(
      '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
      {
        url: 'https://www.youtube.com/',
        referrer: 'https://www.youtube.com/',
        userAgent: PO_CONFIG.userAgent
      }
    )
    this._applyDomGlobals(this._dom)

    logger('debug', 'PoToken', 'Fetching attestation challenge...')
    const challengeResponse = await this.getAttestationChallenge(
      this.visitorData
    )
    if (!challengeResponse.bg_challenge)
      throw new Error('Could not get challenge')

    const interpreterUrl =
      challengeResponse.bg_challenge.interpreter_url
        .private_do_not_access_or_else_trusted_resource_url_wrapped_value

    logger('debug', 'PoToken', `Fetching interpreter from: ${interpreterUrl}`)
    const bgScriptResponse = await fetch(`https:${interpreterUrl}`)
    const interpreterJavascript = await bgScriptResponse.text()
    if (!interpreterJavascript) throw new Error('Could not load BotGuard VM')

    new Function(interpreterJavascript)()

    logger('debug', 'PoToken', 'Creating BotGuard client...')
    this.botguard = await BotGuardClient.create({
      program: challengeResponse.bg_challenge.program,
      globalName: challengeResponse.bg_challenge.global_name,
      globalObj: globalThis
    })

    logger('debug', 'PoToken', 'Generating snapshot and creating minter...')
    const webPoSignalOutput = []
    const botguardResponse = await this.botguard.snapshot({ webPoSignalOutput })

    const requestKey = 'O43z0dpjhgX20SCx4KAo'
    const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: {
        'content-type': 'application/json+protobuf',
        'x-goog-api-key': PO_CONFIG.apiKey,
        'x-user-agent': 'grpc-web-javascript/0.1',
        'user-agent': PO_CONFIG.userAgent
      },
      body: JSON.stringify([requestKey, botguardResponse])
    })

    const response = await integrityTokenResponse.json()
    if (typeof response[0] !== 'string')
      throw new Error('Could not get integrity token')

    this.integrityToken = response[0]
    logger(
      'debug',
      'PoToken',
      `IntegrityToken retrieved. Length: ${this.integrityToken.length}`
    )

    this.minter = await WebPoMinter.create(
      this.integrityToken,
      webPoSignalOutput
    )
    logger('debug', 'PoToken', 'Initialization complete')
  }

  async generate(videoId, existingVisitorData) {
    try {
      logger(
        'debug',
        'PoToken',
        `Generating token for videoId: ${videoId} with existingVisitorData: ${!!existingVisitorData}`
      )

      await this.initialize(existingVisitorData)

      const contentPoToken = await this.minter.mintAsWebsafeString(videoId)
      logger(
        'debug',
        'PoToken',
        `ContentPoToken generated. Length: ${contentPoToken.length}`
      )

      const legacyPoToken = this.bindToken(
        this.integrityToken,
        this.visitorData
      )
      logger(
        'debug',
        'PoToken',
        `LegacyPoToken generated. Length: ${legacyPoToken.length}`
      )

      const entry = {
        ts: new Date().toISOString(),
        videoId,
        visitorData: this.visitorData,
        poToken: contentPoToken,
        legacyPoToken,
        integrityToken: this.integrityToken?.slice(0, 20) + '...'
      }

      await appendFile(TOKENS_LOG_PATH, JSON.stringify(entry) + '\n').catch(
        () => {}
      )

      return {
        poToken: contentPoToken,
        visitorData: this.visitorData,
        legacyPoToken
      }
    } catch (error) {
      const errEntry = {
        ts: new Date().toISOString(),
        videoId,
        error: error.message,
        stack: error.stack
      }

      logger(
        'error',
        'PoToken',
        `Failed to generate token for ${videoId}: ${error.message}`
      )
      await appendFile(TOKENS_LOG_PATH, JSON.stringify(errEntry) + '\n').catch(
        () => {}
      )

      this.botguard = null
      this.minter = null
      this._cleanupDom()

      return { poToken: null, visitorData: null, legacyPoToken: null }
    }
  }

  bindToken(integrityToken, visitorData) {
    const itU8 = base64ToU8(integrityToken)
    const it = Buffer.from(itU8.buffer, itU8.byteOffset, itU8.byteLength)
    const vd = Buffer.from(visitorData, 'utf8')

    const len = 10 + it.length + vd.length
    const buf = Buffer.allocUnsafe(len)

    buf[0] = 0x22
    buf[1] = len - 2

    buf[2] = 0x5a
    buf[3] = 0xb3
    buf[4] = 0x00
    buf[5] = 0x01

    buf.writeUInt32BE((Date.now() / 1000) | 0, 6)

    it.copy(buf, 10)
    vd.copy(buf, 10 + it.length)

    for (let i = 4; i < len; i++) {
      buf[i] ^= i & 1 ? 0xb3 : 0x5a
    }

    return u8ToBase64(buf, true)
  }

  async generateStreamingToken() {
    try {
      await this.initialize()
      const sessionPoToken = await this.minter.mintAsWebsafeString(
        this.visitorData
      )
      logger(
        'debug',
        'PoToken',
        `StreamingPoToken generated. Length: ${sessionPoToken.length}`
      )
      return sessionPoToken
    } catch (error) {
      logger(
        'error',
        'PoToken',
        `Failed to generate streaming token: ${error.message}`
      )
      this.botguard = null
      this.minter = null
      this._cleanupDom()
      return null
    }
  }

  generateColdStartToken(visitorData) {
    try {
      const identifier = visitorData || this.visitorData
      const encodedIdentifier = textEncoder.encode(identifier)
      if (encodedIdentifier.length > 118)
        throw new Error('Content binding is too long.')

      const ts = (Date.now() / 1000) | 0
      const k0 = (Math.random() * 256) | 0
      const k1 = (Math.random() * 256) | 0

      const packet = new Uint8Array(10 + encodedIdentifier.length)
      packet[0] = 34
      packet[1] = 8 + encodedIdentifier.length

      packet[2] = k0
      packet[3] = k1
      packet[4] = 0
      packet[5] = 1
      packet[6] = (ts >>> 24) & 255
      packet[7] = (ts >>> 16) & 255
      packet[8] = (ts >>> 8) & 255
      packet[9] = ts & 255

      packet.set(encodedIdentifier, 10)

      const payload = packet.subarray(2)
      for (let i = 2; i < payload.length; i++) payload[i] ^= payload[i & 1]

      return u8ToBase64(packet, true)
    } catch (error) {
      logger(
        'error',
        'PoToken',
        `Failed to generate cold start token: ${error.message}`
      )
      return null
    }
  }

  reset() {
    logger('debug', 'PoToken', 'Resetting PoTokenManager state')
    this.botguard = null
    this.minter = null
    this.visitorData = null
    this.integrityToken = null
    this._cleanupDom()
  }
}

export const poTokenManager = new PoTokenManager()
