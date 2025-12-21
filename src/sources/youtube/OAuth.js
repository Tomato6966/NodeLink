import { logger, makeRequest } from '../../utils.js'

const CLIENT_ID =
  '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com'
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT'
const SCOPES =
  'http://gdata.youtube.com https://www.googleapis.com/auth/youtube'

export default class OAuth {
  constructor(nodelink) {
    this.nodelink = nodelink

    const clientSettings =
      this.nodelink.options.sources.youtube.clients.settings
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
    if (!this.refreshToken.length) {
      logger(
        'debug',
        'YouTube-OAuth',
        'No refresh token configured. Skipping authentication.'
      )
      return null
    }

    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    logger('info', 'YouTube-OAuth', 'Refreshing access token...')

    const maxTokenAttempts = this.refreshToken.length
    let tokensTried = 0

    while (tokensTried < maxTokenAttempts) {
      const currentToken = this.refreshToken[this.currentTokenIndex]
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
            logger('info', 'YouTube-OAuth', `Successfully refreshed access token using token index ${this.currentTokenIndex}.`)
            return this.accessToken
          }

          logger('warn', 'YouTube-OAuth', `Token refresh failed (Attempt ${attempts}/3, Token Index ${this.currentTokenIndex}): ${error?.message || body?.error_description || statusCode}`)
        } catch (e) {
          logger('warn', 'YouTube-OAuth', `Token refresh exception (Attempt ${attempts}/3, Token Index ${this.currentTokenIndex}): ${e.message}`)
        }
        
        await new Promise(r => setTimeout(r, 2000))
      }

      logger('warn', 'YouTube-OAuth', `Failed to refresh access token with token index ${this.currentTokenIndex}. Trying next token if available.`)
      this.currentTokenIndex = (this.currentTokenIndex + 1) % this.refreshToken.length
      tokensTried++
    }

    logger('error', 'YouTube-OAuth', 'All refresh tokens failed.')
    this.accessToken = null
    this.tokenExpiry = 0
    return null
  }

  async getAuthHeaders() {
    const token = await this.getAccessToken()
    if (!token) return {}

    return {
      Authorization: `Bearer ${token}`
    }
  }

  static async acquireRefreshToken() {
    logger(
      'info',
      'YouTube-OAuth',
      'Step 1: Requesting device code from Google...'
    )
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

      logger(
        'info',
        'YouTube-OAuth',
        '=================================================================='
      )
      logger(
        'info',
        'YouTube-OAuth',
        '🚨 ALERT: DO NOT USE YOUR MAIN GOOGLE ACCOUNT! USE A SECONDARY OR BURNER ACCOUNT ONLY!'
      )
      logger(
        'info',
        'YouTube-OAuth',
        'To authorize, visit the following URL in your browser:'
      )
      logger('info', 'YouTube-OAuth', `URL: ${response.verification_url}`)
      logger(
        'info',
        'YouTube-OAuth',
        `And enter the code: ${response.user_code}`
      )
      logger(
        'info',
        'YouTube-OAuth',
        '=================================================================='
      )
      logger('info', 'YouTube-OAuth', 'Waiting for authorization...')

      const refreshToken = await OAuth.pollForToken(
        response.device_code,
        response.interval
      )

      logger(
        'info',
        'YouTube-OAuth',
        '=================================================================='
      )
      logger('info', 'YouTube-OAuth', 'Authorization granted successfully!')
      logger(
        'info',
        'YouTube-OAuth',
        '=================================================================='
      )
      logger(
        'info',
        'YouTube-OAuth',
        'Refresh Token (use this to obtain new Access Tokens in the future):'
      )
      logger('info', 'YouTube-OAuth', refreshToken)
      logger(
        'info',
        'YouTube-OAuth',
        'Save your Refresh Token in a secure place!'
      )
      logger(
        'info',
        'YouTube-OAuth',
        '=================================================================='
      )

      return refreshToken
    } catch (error) {
      logger('error', 'YouTube-OAuth', `Failed in Step 1: ${error.message}`)
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
              logger(
                'error',
                'YouTube-OAuth',
                'Authorization code expired. Please run the script again.'
              )
              reject(new Error('Authorization code expired.'))
            } else if (response.error === 'access_denied') {
              logger(
                'error',
                'YouTube-OAuth',
                'Access denied. Authorization was cancelled.'
              )
              reject(new Error('Access denied.'))
            } else {
              logger(
                'error',
                'YouTube-OAuth',
                `Error during polling: ${response.error_description}`
              )
              reject(
                new Error(`Error during polling: ${response.error_description}`)
              )
            }
          } else {
            resolve(response.refresh_token)
          }
        } catch (error) {
          logger(
            'error',
            'YouTube-OAuth',
            `Failed in Step 2 (Polling): ${error.message}`
          )
          setTimeout(poll, interval * 1000)
        }
      }

      setTimeout(poll, interval * 1000)
    })
  }
}
