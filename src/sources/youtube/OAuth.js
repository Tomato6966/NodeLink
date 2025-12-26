import { logger, makeRequest } from '../../utils.js'

const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT'
const SCOPES = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube'

export default class OAuth {
  constructor(nodelink) {
    this.nodelink = nodelink

    const clientSettings = this.nodelink.options.sources.youtube.clients.settings
    let foundToken = null
    if (clientSettings) {
      for (const clientName in clientSettings) {
        if (clientSettings[clientName].refreshToken) {
          foundToken = clientSettings[clientName].refreshToken
          break
        }
      }
    }

    this.refreshToken = foundToken ? (Array.isArray(foundToken) ? foundToken : [foundToken]) : []
    this.currentTokenIndex = 0
    this.accessToken = null
    this.tokenExpiry = 0
  }

  async getAccessToken() {
    if (!this.refreshToken.length || (this.refreshToken.length === 1 && this.refreshToken[0] === '')) {
      return null
    }

    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    const cachedToken = this.nodelink.credentialManager.get('yt_access_token')
    if (cachedToken) {
      this.accessToken = cachedToken
      this.tokenExpiry = Date.now() + 3500000 // Assume ~1h from now
      return this.accessToken
    }

    const maxTokenAttempts = this.refreshToken.length
    let tokensTried = 0

    while (tokensTried < maxTokenAttempts) {
      const currentToken = this.refreshToken[this.currentTokenIndex]
      if (!currentToken) {
        this.currentTokenIndex = (this.currentTokenIndex + 1) % this.refreshToken.length
        tokensTried++
        continue
      }

      let attempts = 0
      
      while (attempts < 3) {
        attempts++
        try {
          const { body, error, statusCode } = await makeRequest(
            'https://www.youtube.com/o/oauth2/token',
            {
              method: 'POST',
              body: {
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                refresh_token: currentToken,
                grant_type: 'refresh_token'
              }
            }
          )

          if (!error && statusCode === 200 && body.access_token) {
            this.accessToken = body.access_token
            this.tokenExpiry = Date.now() + body.expires_in * 1000 - 30000
            this.nodelink.credentialManager.set('yt_access_token', this.accessToken, body.expires_in * 1000 - 30000)
            return this.accessToken
          }
        } catch (e) {}
        
        await new Promise(r => setTimeout(r, 2000))
      }

      this.currentTokenIndex = (this.currentTokenIndex + 1) % this.refreshToken.length
      tokensTried++
    }

    this.accessToken = null
    this.tokenExpiry = 0
    return null
  }

  async validateCurrentTokens() {
    if (!this.refreshToken.length || (this.refreshToken.length === 1 && this.refreshToken[0] === '')) {
      return false
    }

    const token = await this.getAccessToken()
    if (token) {
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      logger('info', 'OAuth', '\x1b[1m\x1b[32mYOUR refreshtoken IS VALID :)\x1b[0m')
      logger('info', 'OAuth', '\x1b[37mPlease disable the \x1b[33mgetOAuthToken\x1b[37m option if you restarted by accident\x1b[0m')
      logger('info', 'OAuth', '\x1b[37mand didn\'t change it to \x1b[31mfalse\x1b[37m. If you want to get a second token\x1b[0m')
      logger('info', 'OAuth', '\x1b[37mfor fallback, follow the same steps and add \x1b[32m, ""\x1b[37m for this new token below.\x1b[0m')
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      return true
    }
    return false
  }

  async getAuthHeaders() {
    const token = await this.getAccessToken()
    if (!token) return {}

    return {
      Authorization: `Bearer ${token}`
    }
  }

  static async acquireRefreshToken() {
    const data = {
      client_id: CLIENT_ID,
      scope: SCOPES
    }

    try {
      const {
        body: response,
        error,
        statusCode
      } = await makeRequest('https://www.youtube.com/o/oauth2/device/code', {
        method: 'POST',
        body: data
      })

      if (error || statusCode !== 200 || response.error) {
        throw new Error(
          `Error obtaining device code: ${error?.message || response.error_description || 'Invalid response'}`
        )
      }

      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      logger('info', 'OAuth', '\x1b[1m\x1b[31m🚨 ALERT: DO NOT USE YOUR MAIN GOOGLE ACCOUNT! USE A SECONDARY OR BURNER ACCOUNT ONLY!\x1b[0m')
      logger('info', 'OAuth', '\x1b[36mTo authorize, visit the following URL in your browser:\x1b[0m')
      logger('info', 'OAuth', `\x1b[1m\x1b[32mURL: ${response.verification_url}\x1b[0m`)
      logger('info', 'OAuth', `\x1b[36mAnd enter the code: \x1b[1m\x1b[37m${response.user_code}\x1b[0m`)
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')

      const refreshToken = await OAuth.pollForToken(
        response.device_code,
        response.interval
      )

      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      logger('info', 'OAuth', '\x1b[1m\x1b[32mAuthorization granted successfully! :)\x1b[0m')
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      logger('info', 'OAuth', '\x1b[36mCopy your Refresh Token and paste it in your \x1b[1mconfig.js\x1b[36m:\x1b[0m')
      logger('info', 'OAuth', `\x1b[1m\x1b[37m${refreshToken}\x1b[0m`)
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m')
      logger('info', 'OAuth', '\x1b[1m\x1b[31mIMPORTANT:\x1b[0m')
      logger('info', 'OAuth', '\x1b[37mAfter pasting the token, you \x1b[1mMUST\x1b[37m set \x1b[33mgetOAuthToken\x1b[37m to \x1b[31mfalse\x1b[0m')
      logger('info', 'OAuth', '\x1b[37motherwise the server will keep trying to obtain a new token on every restart.\x1b[0m')
      logger('info', 'OAuth', '\x1b[33mExample JSON structure for your config.js:\x1b[0m')
      
      const exampleJson = JSON.stringify({
        sources: {
          youtube: {
            getOAuthToken: false,
            clients: {
              settings: {
                TV: {
                  refreshToken: [refreshToken]
                }
              }
            }
          }
        }
      }, null, 2)

      logger('info', 'OAuth', `\x1b[32m${exampleJson}\x1b[0m`)
      logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m\n')

      return refreshToken
    } catch (error) {
      throw error
    }
  }

  static async pollForToken(deviceCode, interval) {
    const data = {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: deviceCode,
      grant_type: 'http://oauth.net/grant_type/device/1.0'
    }

    return new Promise((resolve, reject) => {
      const poll = async () => {
        logger('info', 'OAuth', '\x1b[35m>>> AWAITING...\x1b[0m waiting for token :P')
        try {
          const {
            body: response,
            error,
            statusCode
          } = await makeRequest('https://www.youtube.com/o/oauth2/token', {
            method: 'POST',
            body: data
          })

          if (error || statusCode !== 200 || response.error) {
            if (response.error === 'authorization_pending') {
              setTimeout(poll, interval * 1000)
            } else if (response.error === 'slow_down') {
              setTimeout(poll, (interval + 5) * 1000)
            } else if (response.error === 'expired_token') {
              reject(new Error('Authorization code expired.'))
            } else if (response.error === 'access_denied') {
              reject(new Error('Access denied.'))
            } else {
              reject(new Error(`Error during polling: ${response.error_description}`))
            }
          } else {
            logger('info', 'OAuth', '>>> TOKEN RECEIVED :)')
            resolve(response.refresh_token)
          }
        } catch (error) {
          setTimeout(poll, interval * 1000)
        }
      }

      poll()
    })
  }
}