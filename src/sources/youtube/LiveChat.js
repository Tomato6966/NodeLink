import { logger, makeRequest } from '../../utils.ts'
import Web from './clients/Web.js'

class LiveChat {
  constructor(nodelink, source) {
    this.nodelink = nodelink
    this.source = source
    this.webClient = new Web(nodelink, null)
    this.apiKey = 'AIzaSyAO_FJ2SlqI87oz4cl9Sdr_LRIPvS6S8'
    this.activeChats = new Map()
  }

  async getLiveChat(videoId) {
    const _context = {
      client: { hl: 'en', gl: 'US' }
    }

    try {
      const { body: data, statusCode } = await this.webClient._makeNextRequest(
        videoId,
        this.source.ytContext,
        {}
      )

      if (statusCode !== 200 || !data) {
        logger(
          'error',
          'YouTube-LiveChat',
          `Failed to get next data for ${videoId}: Status ${statusCode}`
        )
        return null
      }

      const chatRenderer =
        data.contents?.twoColumnWatchNextResults?.conversationBar
          ?.liveChatRenderer
      let continuation =
        chatRenderer?.continuations?.[0]?.reloadContinuationData?.continuation

      if (!continuation) {
        logger(
          'warn',
          'YouTube-LiveChat',
          `No live chat continuation found for ${videoId}`
        )
        return null
      }

      const apiKey =
        data?.responseContext?.serviceTrackingParams?.[0]?.serviceInfo?.[0]
          ?.value || this.apiKey

      return {
        poll: async () => {
          if (!continuation) return null

          const { body: chatResponse, statusCode } = await makeRequest(
            `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: {
                context: this.source.ytContext,
                continuation
              },
              disableBodyCompression: true,
              proxy: this.source.getProxy()
            }
          )

          if (statusCode !== 200 || !chatResponse) {
            logger(
              'warn',
              'YouTube-LiveChat',
              `Polling failed for ${videoId}: Status ${statusCode}`
            )
            return null
          }

          const chatCont =
            chatResponse.continuationContents?.liveChatContinuation
          if (!chatCont) return null

          const nextContData =
            chatCont.continuations?.[0]?.invalidationContinuationData ||
            chatCont.continuations?.[0]?.timedContinuationData

          if (nextContData) {
            continuation = nextContData.continuation
          } else {
            continuation = null
          }

          return {
            actions: this.parseActions(chatCont.actions || []),
            timeoutMs: nextContData?.timeoutMs || 5000
          }
        }
      }
    } catch (e) {
      logger(
        'error',
        'YouTube-LiveChat',
        `Error initializing chat for ${videoId}: ${e.message}`
      )
      return null
    }
  }

  parseActions(actions) {
    const parsed = []
    for (const action of actions) {
      if (action.addChatItemAction) {
        const item = action.addChatItemAction.item
        const renderer =
          item.liveChatTextMessageRenderer ||
          item.liveChatPaidMessageRenderer ||
          item.liveChatMembershipItemRenderer ||
          item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer

        if (renderer) {
          parsed.push({
            type: item.liveChatTextMessageRenderer
              ? 'text'
              : item.liveChatPaidMessageRenderer
                ? 'paid'
                : item.liveChatMembershipItemRenderer
                  ? 'membership'
                  : 'gift',
            id: renderer.id,
            timestamp: renderer.timestampUsec,
            author: {
              name:
                renderer.authorName?.simpleText ||
                renderer.headerPrimaryText?.runs?.map((r) => r.text).join(''),
              id: renderer.authorExternalChannelId,
              photo: renderer.authorPhoto?.thumbnails?.pop()?.url,
              badges: renderer.authorBadges?.map(
                (b) => b.liveChatAuthorBadgeRenderer?.tooltip
              )
            },
            message:
              renderer.message?.runs?.map((r) => r.text).join('') ||
              renderer.headerSubtext?.simpleText ||
              renderer.headerSubtext?.runs?.map((r) => r.text).join(''),
            amount: renderer.purchaseAmountText?.simpleText
          })
        }
      }
    }
    return parsed
  }

  async handleLiveChat(videoId) {
    return this.getLiveChat(videoId)
  }

  async handleConnection(socket, videoId) {
    logger(
      'info',
      'YouTube-LiveChat',
      `Starting live chat for video: ${videoId}`
    )

    try {
      const chat = await this.getLiveChat(videoId)
      if (!chat) {
        socket.close(1008, 'Could not initialize live chat')
        return
      }

      const chatKey = `${videoId}-${Date.now()}`
      this.activeChats.set(chatKey, true)

      const cleanup = () => {
        this.activeChats.delete(chatKey)
        if (socket.readyState === 1) socket.close()
      }

      socket.on('close', () => this.activeChats.delete(chatKey))
      socket.on('error', cleanup)

      while (this.activeChats.has(chatKey)) {
        try {
          const result = await chat.poll()
          if (!result) break

          const { actions, timeoutMs } = result

          if (actions.length > 0) {
            socket.send(JSON.stringify({ op: 'actions', actions }))
          }

          await new Promise((resolve) => setTimeout(resolve, timeoutMs || 5000))
        } catch (e) {
          logger('error', 'YouTube-LiveChat', `Polling error: ${e.message}`)
          break
        }
      }

      cleanup()
    } catch (e) {
      logger('error', 'YouTube-LiveChat', `Failed to connect: ${e.message}`)
      socket.close(1011, 'Internal error during initialization')
    }
  }
}

export default LiveChat
