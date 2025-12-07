import myzod from 'myzod'
import OAuth from '../sources/youtube/OAuth.js'
import { logger, sendResponse, sendErrorResponse } from '../utils.js'

const configSchema = myzod.object({
  refreshToken: myzod.string().min(1).optional(),
  visitorData: myzod.string().min(1).optional()
}).allowUnknownKeys()

function maskString(str, visibleChars = 5) {
  if (!str) return null
  if (str.length <= visibleChars) return '***'
  return `${str.substring(0, visibleChars)}...[hidden]`
}

async function handler(nodelink, req, res, sendResponse, parsedUrl) {
  if (req.method === 'GET') {
    let currentRefreshToken = null
    let currentVisitorData = null

    if (nodelink.workerManager) {
      currentRefreshToken = nodelink.workerManager.liveYoutubeConfig.refreshToken
      currentVisitorData = nodelink.workerManager.liveYoutubeConfig.visitorData
      
      if (!currentRefreshToken) currentRefreshToken = nodelink.options.sources.youtube?.clients?.settings?.TV?.refreshToken
      if (!currentVisitorData) currentVisitorData = null
    } else {
      const youtube = nodelink.sources?.sources?.get('youtube')
      if (youtube) {
        currentRefreshToken = youtube.oauth?.refreshToken
        currentVisitorData = youtube.ytContext?.client?.visitorData
      }
    }

    let isValid = null
    if (parsedUrl.searchParams.get('validate') === 'true' && currentRefreshToken) {
      try {
        const validator = new OAuth(nodelink)
        validator.refreshToken = currentRefreshToken
        validator.accessToken = null
        validator.tokenExpiry = 0
        
        const token = await validator.getAccessToken()
        isValid = !!token
      } catch (e) {
        isValid = false
      }
    }

    const response = {
      refreshToken: currentRefreshToken ? maskString(currentRefreshToken, 7) : null,
      visitorData: currentVisitorData ? maskString(currentVisitorData, 10) : null,
      isConfigured: !!currentRefreshToken,
      isValid
    }

    return sendResponse(req, res, response, 200)
  }

  if (req.method === 'PATCH') {
    const result = configSchema.try(req.body)

    if (result instanceof myzod.ValidationError) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        result.message,
        parsedUrl.pathname
      )
    }

    const { refreshToken, visitorData } = result

    if (!refreshToken && !visitorData) {
      return sendErrorResponse(
        req,
        res,
        400,
        'Bad Request',
        'At least one field (refreshToken or visitorData) must be provided.',
        parsedUrl.pathname
      )
    }

    if (refreshToken) {
      logger('info', 'API', 'Sandboxing new YouTube refresh token for validation.')
      try {
        const sandboxOAuth = new OAuth(nodelink)
        sandboxOAuth.refreshToken = refreshToken
        sandboxOAuth.accessToken = null
        sandboxOAuth.tokenExpiry = 0

        const accessToken = await sandboxOAuth.getAccessToken()

        if (!accessToken) {
          throw new Error('Google rejected the refresh token (Invalid Grant or similar).')
        }
        logger('info', 'API', 'YouTube refresh token validated successfully in sandbox.')
      } catch (error) {
        logger('warn', 'API', `YouTube token validation failed: ${error.message}`)
        return sendErrorResponse(
          req,
          res,
          403,
          'Forbidden',
          `Token validation failed: ${error.message}. No changes were applied.`,
          parsedUrl.pathname
        )
      }
    }

    let updatedCount = 0
    const payload = { refreshToken, visitorData }

    try {
      if (nodelink.workerManager) {
        nodelink.workerManager.setLiveYoutubeConfig(payload)
        logger('info', 'API', 'Master LiveConfig updated for future workers.')

        logger('info', 'API', 'Propagating YouTube config to cluster workers.')
        
        const promises = nodelink.workerManager.workers
          .filter(w => w.isConnected())
          .map(worker => 
            nodelink.workerManager.execute(worker, 'updateYoutubeConfig', payload)
              .then(() => 1)
              .catch(err => {
                logger('error', 'API', `Failed to update worker ${worker.id}: ${err.message}`)
                return 0
              })
          )
        
        const results = await Promise.all(promises)
        updatedCount = results.reduce((a, b) => a + b, 0)
      } else {
        logger('info', 'API', 'Updating local YouTube source.')
        const youtube = nodelink.sources?.sources?.get('youtube')
        
        if (youtube) {
          if (refreshToken) {
            if (youtube.oauth) {
              youtube.oauth.refreshToken = refreshToken
              youtube.oauth.accessToken = null
              youtube.oauth.tokenExpiry = 0
              logger('info', 'YouTube', 'Local refresh token updated.')
            }
          }
          if (visitorData) {
            if (youtube.ytContext?.client) {
              youtube.ytContext.client.visitorData = visitorData
              logger('info', 'YouTube', 'Local visitor data updated.')
            }
          }
          updatedCount = 1
        }
      }

      return sendResponse(
        req,
        res,
        {
          message: 'YouTube configuration updated successfully.',
          workersUpdated: updatedCount,
          fieldsUpdated: Object.keys(payload).filter(k => payload[k] !== undefined)
        },
        200
      )

    } catch (err) {
      logger('error', 'API', `Critical error during config propagation: ${err.message}`)
      return sendErrorResponse(
        req,
        res,
        500,
        'Internal Server Error',
        'Failed to propagate configuration changes.',
        parsedUrl.pathname
      )
    }
  }
}

export default {
  handler,
  methods: ['GET', 'PATCH']
}
