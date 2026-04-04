/**
 * YouTube Client Shared Type Definitions
 *
 * Shared interfaces and types used across all YouTube innertube client
 * implementations (Web, Android, TV, IOS, Music, etc.).
 *
 * @packageDocumentation
 * @module YouTubeClientTypes
 */

import type { HttpProxyConfig } from '../utils.types.ts'
import type {
  LiveChatPollResult,
  SourceResult,
  WorkerNodeLink
} from './source.types.ts'
import type {
  IOAuth,
  ProxySnapshot,
  YouTubeClientContext,
  YouTubeContext
} from './youtube.types.ts'

/**
 * Configuration for a YouTube innertube client constructor.
 *
 * Each client receives these shared dependencies from the YouTube source
 * during initialization.
 *
 * @public
 */
export interface YouTubeClientConfig {
  /** NodeLink worker instance providing access to options, sources, and logging */
  nodelink: WorkerNodeLink
  /** OAuth manager for authenticated requests, or null if unauthenticated */
  oauth: IOAuth | null
}

/**
 * Search-capable YouTube client contract used for client-to-client delegation.
 *
 * Some clients, such as IOS, delegate search support to another initialized
 * client instance instead of implementing their own endpoint-specific search
 * parser.
 *
 * @public
 */
export interface YouTubeSearchCapableClient {
  /**
   * Searches YouTube using the delegated client implementation.
   *
   * @param query - Search query string.
   * @param type - Search type hint.
   * @param context - Shared YouTube innertube context.
   * @returns Search result returned by the delegated client.
   */
  search(
    query: string,
    type: string,
    context: YouTubeContext
  ): Promise<SourceResult>
}

/**
 * Minimal source-manager view exposing instantiated YouTube clients.
 *
 * @internal
 */
export interface YouTubeClientRegistry {
  /** Instantiated YouTube clients keyed by class name, such as `Web` or `IOS`. */
  clients?: Record<string, YouTubeSearchCapableClient | undefined>
}

/**
 * Minimal proxy-aware YouTube source contract used by helper modules.
 *
 * This interface is intentionally smaller than the full source implementation
 * so helper classes such as the cipher manager can depend on stable behavior
 * without importing the main `YouTubeSource` class directly.
 *
 * @example
 * ```typescript
 * const runtime: YouTubeSourceProxyRuntime = {
 *   getProxy: () => ({ url: 'http://127.0.0.1:8080', type: 'forward', failures: 0, lastFailure: 0, activeRequests: 0, score: 100, latency: 0 }),
 *   reportProxyStatus: (proxy, success, status) => {
 *     console.log(proxy?.url, success, status);
 *   }
 * };
 * ```
 *
 * @internal
 */
export interface YouTubeSourceProxyRuntime {
  /**
   * Returns the healthiest proxy snapshot currently available.
   *
   * @param rotate - Whether the selection should be rotated before returning.
   * @returns Best available proxy snapshot, or `undefined` when no proxy exists.
   */
  getProxy?: (rotate?: boolean) => ProxySnapshot | undefined

  /**
   * Reports the outcome of a proxied request back to the source runtime.
   *
   * @param proxy - Proxy snapshot used for the request.
   * @param success - Whether the request succeeded.
   * @param status - HTTP status code associated with the result.
   * @param latency - Measured request latency in milliseconds.
   * @returns Nothing. Implementations update proxy health as a side effect.
   */
  reportProxyStatus?: (
    proxy: ProxySnapshot | undefined,
    success: boolean,
    status: number,
    latency?: number
  ) => void
}

/**
 * Configuration for the remote YouTube cipher service integration.
 *
 * @example
 * ```typescript
 * const config: YouTubeCipherConfig = {
 *   url: 'https://cipher.example.com',
 *   token: 'Bearer abc123'
 * };
 * ```
 *
 * @internal
 */
export interface YouTubeCipherConfig {
  /** Base URL of the remote cipher service. */
  url?: string
  /** Optional authorization token forwarded to the cipher service. */
  token?: string
}

/**
 * Response returned by the remote YouTube cipher service.
 *
 * Different endpoints populate different fields:
 * `/get_sts` returns `sts`, while `/resolve_url` returns `resolved_url`.
 *
 * @internal
 */
export interface YouTubeCipherServiceResponse {
  /** Signature timestamp extracted by the cipher service. */
  sts?: string
  /** Fully resolved playback URL returned by the cipher service. */
  resolved_url?: string
  /** Error message returned by the remote service. */
  message?: string
}

/**
 * Credential-manager shape required by the YouTube OAuth helper.
 *
 * @internal
 */
export interface YouTubeOAuthCredentialManager {
  /**
   * Reads a cached credential value.
   *
   * @param key - Storage key to look up.
   * @returns Cached value when present, otherwise `null`/`undefined`.
   */
  get(key: string): string | null | undefined

  /**
   * Writes a cached credential value with a TTL.
   *
   * @param key - Storage key to write.
   * @param value - Token or secret to cache.
   * @param ttlMs - Cache lifetime in milliseconds.
   * @returns Nothing. The credential store is updated as a side effect.
   */
  set(key: string, value: string, ttlMs: number): void
}

/**
 * Per-client YouTube OAuth configuration entry.
 *
 * @internal
 */
export interface YouTubeOAuthClientSetting {
  /** One or more refresh tokens used for access-token rotation. */
  refreshToken?: string | string[]
}

/**
 * Minimal runtime contract consumed by the YouTube OAuth helper.
 *
 * @internal
 */
export interface YouTubeOAuthRuntime {
  /** Runtime configuration containing YouTube client token settings. */
  options: {
    sources?: {
      youtube?: {
        clients?: {
          settings?: Record<string, YouTubeOAuthClientSetting | undefined>
        }
      }
    }
  }
  /** Credential manager used for short-lived access-token caching. */
  credentialManager?: YouTubeOAuthCredentialManager
}

/**
 * OAuth token response returned by Google's token endpoint.
 *
 * @internal
 */
export interface YouTubeOAuthTokenResponse {
  /** Short-lived access token issued by Google. */
  access_token?: string
  /** Lifetime of the access token in seconds. */
  expires_in?: number
  /** Refresh token returned by the device flow. */
  refresh_token?: string
  /** Machine-readable OAuth error code. */
  error?: string
  /** Human-readable OAuth error description. */
  error_description?: string
}

/**
 * Device-code response returned by Google's OAuth device endpoint.
 *
 * @internal
 */
export interface YouTubeOAuthDeviceCodeResponse {
  /** Device code used when polling the token endpoint. */
  device_code?: string
  /** Human-entered code shown to the user in the browser. */
  user_code?: string
  /** Verification URL opened in the browser during device auth. */
  verification_url?: string
  /** Polling interval in seconds suggested by Google. */
  interval?: number
  /** Machine-readable OAuth error code. */
  error?: string
  /** Human-readable OAuth error description. */
  error_description?: string
}

/**
 * Minimal YouTube source adapter used by the live chat helper.
 *
 * @internal
 */
export interface YouTubeLiveChatSource {
  /**
   * Returns the proxy to use for live-chat polling requests.
   *
   * @returns Proxy configuration, or `undefined` when polling directly.
   */
  getProxy: () => HttpProxyConfig | undefined

  /**
   * Returns the current YouTube innertube context.
   *
   * @returns Context object containing locale and visitor data.
   */
  getContext: () => YouTubeContext
}

/**
 * Minimal WebSocket-like contract used by the live chat bridge.
 *
 * @example
 * ```typescript
 * const socket: YouTubeLiveChatSocket = {
 *   readyState: 1,
 *   close: () => {},
 *   on: () => {},
 *   send: (payload) => console.log(payload)
 * };
 * ```
 *
 * @public
 */
export interface YouTubeLiveChatSocket {
  /** Ready-state value exposed by the underlying socket implementation. */
  readyState: number
  /** Closes the socket with an optional code and reason. */
  close(code?: number, reason?: string): void
  /** Registers an event listener on the socket implementation. */
  on(event: string, listener: (...args: unknown[]) => void): void
  /** Sends a serialized payload to the connected client. */
  send(data: string): void
}

/**
 * Text run used inside live chat renderers.
 *
 * @internal
 */
export interface YouTubeLiveChatMessageRun {
  /** Raw text content of the run. */
  text?: string
}

/**
 * Normalized subset of YouTube live chat message renderers.
 *
 * Covers text, paid, membership, and gift-purchase announcement renderers.
 *
 * @internal
 */
export interface YouTubeLiveChatMessageRenderer {
  /** Stable message identifier. */
  id?: string
  /** Microsecond-resolution timestamp string. */
  timestampUsec?: string
  /** Channel identifier of the author. */
  authorExternalChannelId?: string
  /** Author display name. */
  authorName?: { simpleText?: string }
  /** Header text used by paid/membership variants. */
  headerPrimaryText?: { runs?: YouTubeLiveChatMessageRun[] }
  /** Author avatar thumbnails. */
  authorPhoto?: { thumbnails?: Array<{ url?: string }> }
  /** Author badge metadata. */
  authorBadges?: Array<{
    liveChatAuthorBadgeRenderer?: { tooltip?: string }
  }>
  /** Standard message body. */
  message?: { runs?: YouTubeLiveChatMessageRun[] }
  /** Secondary text used by non-standard message variants. */
  headerSubtext?: {
    simpleText?: string
    runs?: YouTubeLiveChatMessageRun[]
  }
  /** Purchase amount string for super chats/super stickers. */
  purchaseAmountText?: { simpleText?: string }
}

/**
 * Continuation payload used by YouTube live chat polling.
 *
 * @internal
 */
export interface YouTubeLiveChatContinuationData {
  /** Continuation token for the next poll. */
  continuation?: string
  /** Delay before the next poll should be issued. */
  timeoutMs?: number
}

/**
 * Live chat continuation block returned by YouTube.
 *
 * @internal
 */
export interface YouTubeLiveChatContinuation {
  /** New chat actions delivered in this poll cycle. */
  actions?: Array<Record<string, unknown>>
  /** Continuation instructions for the next poll cycle. */
  continuations?: Array<{
    invalidationContinuationData?: YouTubeLiveChatContinuationData
    timedContinuationData?: YouTubeLiveChatContinuationData
  }>
}

/**
 * Initial watch-next response used to bootstrap live chat polling.
 *
 * @internal
 */
export interface YouTubeLiveChatNextResponse {
  /** Page contents containing the live chat renderer. */
  contents?: {
    twoColumnWatchNextResults?: {
      conversationBar?: {
        liveChatRenderer?: {
          continuations?: Array<{
            reloadContinuationData?: { continuation?: string }
          }>
        }
      }
    }
  }
  /** Response context carrying the API key used by live chat polling. */
  responseContext?: {
    serviceTrackingParams?: Array<{
      serviceInfo?: Array<{ value?: string }>
    }>
  }
}

/**
 * Poll response returned by the YouTube live chat endpoint.
 *
 * @internal
 */
export interface YouTubeLiveChatPollResponse {
  /** Root continuation container for live chat actions. */
  continuationContents?: {
    liveChatContinuation?: YouTubeLiveChatContinuation
  }
}

/**
 * Active live chat polling session created for a video.
 *
 * @example
 * ```typescript
 * const connection: YouTubeLiveChatConnection = {
 *   poll: async () => ({ actions: [], timeoutMs: 5000 })
 * };
 * ```
 *
 * @internal
 */
export interface YouTubeLiveChatConnection {
  /**
   * Polls the live chat endpoint once and returns the normalized result.
   *
   * @returns Poll result, or `null` when the chat can no longer continue.
   */
  poll: () => Promise<LiveChatPollResult | null>
}

/**
 * PoToken manager interface for bot-detection bypass.
 *
 * Generates proof-of-origin tokens required by certain YouTube clients
 * to verify the request is from a legitimate browser.
 *
 * @public
 */
export interface PoTokenManager {
  /**
   * Generates a proof-of-origin token for the given video ID.
   *
   * @param videoId - The YouTube video identifier to generate a token for
   * @param existingVisitorData - Optional existing visitor data to reuse
   * @returns Promise resolving to an object containing the poToken and visitorData
   */
  generate(
    videoId: string,
    existingVisitorData?: string | null
  ): Promise<{ poToken: string | null; visitorData: string }>
}

/**
 * Chapter information extracted from YouTube video metadata.
 *
 * Represents a single chapter/segment marker within a video,
 * typically shown in the YouTube progress bar and description.
 *
 * @example
 * ```typescript
 * const chapter: Chapter = {
 *   title: 'Introduction',
 *   startTime: 0,
 *   thumbnails: [{ url: 'https://i.ytimg.com/...', width: 120, height: 90 }],
 *   duration: 45000,
 *   endTime: 45000
 * };
 * ```
 *
 * @public
 */
export interface Chapter {
  /** Chapter title displayed to the user */
  title: string
  /** Start time in milliseconds from the beginning of the video */
  startTime: number
  /** Array of thumbnail images for this chapter marker */
  thumbnails: Array<{
    url: string
    width?: number
    height?: number
    [key: string]: unknown
  }>
  /** Duration of this chapter in milliseconds (computed after all chapters are parsed) */
  duration?: number
  /** End time in milliseconds (computed after all chapters are parsed) */
  endTime?: number
}

/**
 * Response from the YouTube innertube search API.
 *
 * Provides a loosely-typed structure for the deeply nested search response
 * returned by YouTube's `/youtubei/v1/search` endpoint. Individual clients
 * narrow specific paths through optional chaining.
 *
 * @internal
 */
export interface YouTubeSearchResponse {
  /** Error object if the search request failed at the API level */
  error?: {
    /** Human-readable error message from YouTube */
    message: string
    [key: string]: unknown
  }
  /** Root contents container with section list renderer */
  contents?: {
    /** Section list renderer containing search result sections */
    sectionListRenderer?: {
      /** Array of section items (itemSectionRenderer, shelfRenderer, etc.) */
      contents?: YouTubeSearchSection[]
    }
    /** Two-column search results renderer (desktop layout) */
    twoColumnSearchResultsRenderer?: {
      primaryContents?: {
        sectionListRenderer?: {
          contents?: YouTubeSearchSection[]
        }
      }
    }
    /** Tabbed search results renderer (used by YouTube Music) */
    tabbedSearchResultsRenderer?: {
      tabs?: Array<{
        tabRenderer?: {
          content?: YouTubeSearchTabContent
        }
      }>
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * A single section within search results.
 *
 * @internal
 */
export interface YouTubeSearchSection {
  /** Item section renderer containing individual result items */
  itemSectionRenderer?: {
    contents?: YouTubeSearchItem[]
    [key: string]: unknown
  }
  /** Shelf renderer for grouped results */
  shelfRenderer?: {
    content?: {
      verticalListRenderer?: { items?: YouTubeSearchItem[] }
      richGridRenderer?: { contents?: YouTubeSearchItem[] }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  /** Rich shelf renderer (mobile/tablet layout) */
  richShelfRenderer?: {
    content?: {
      verticalListRenderer?: { items?: YouTubeSearchItem[] }
      richGridRenderer?: { contents?: YouTubeSearchItem[] }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  /** Music shelf renderer (YouTube Music) */
  musicShelfRenderer?: {
    contents?: YouTubeSearchItem[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Individual search result item.
 *
 * Represents a single video, playlist, or channel within search results.
 * Only one of the renderer properties will be present per item.
 *
 * @internal
 */
export interface YouTubeSearchItem {
  /** Standard video renderer */
  videoRenderer?: Record<string, unknown>
  /** Compact video renderer (sidebar/related) */
  compactVideoRenderer?: Record<string, unknown>
  /** Playlist renderer */
  playlistRenderer?: Record<string, unknown>
  /** Compact playlist renderer */
  compactPlaylistRenderer?: Record<string, unknown>
  /** Channel renderer */
  channelRenderer?: Record<string, unknown>
  /** Rich item renderer wrapping inner content */
  richItemRenderer?: {
    content?: YouTubeSearchItem
    [key: string]: unknown
  }
  /** Element renderer for new UI components */
  elementRenderer?: {
    newElement?: {
      type?: {
        componentType?: {
          model?: {
            compactChannelModel?: Record<string, unknown>
            compactPlaylistModel?: Record<string, unknown>
            [key: string]: unknown
          }
          [key: string]: unknown
        }
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  /** Music responsive list item renderer (YouTube Music) */
  musicResponsiveListItemRenderer?: Record<string, unknown>
  /** Music two-column item renderer (YouTube Music) */
  musicTwoColumnItemRenderer?: Record<string, unknown>
  /** Macro markers list item renderer (chapters) */
  macroMarkersListItemRenderer?: Record<string, unknown>
  /** Allow additional unknown properties from YouTube API */
  [key: string]: unknown
}

/**
 * Tab content for YouTube Music search results.
 *
 * @internal
 */
export interface YouTubeSearchTabContent {
  /** Section list renderer at root level */
  sectionListRenderer?: {
    contents?: YouTubeSearchSection[]
    [key: string]: unknown
  }
  /** Music split view renderer (modern YT Music layout) */
  musicSplitViewRenderer?: {
    mainContent?: {
      sectionListRenderer?: {
        contents?: YouTubeSearchSection[]
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Response from the YouTube innertube next endpoint (playlists/recommendations).
 *
 * @internal
 */
export interface YouTubeNextResponse {
  /** Error object if the request failed */
  error?: {
    message: string
    [key: string]: unknown
  }
  /** Root contents container */
  contents?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Typed request body for YouTube innertube player requests.
 *
 * @internal
 */
export interface YouTubePlayerRequestBody {
  /** Client context with device and session info */
  context: YouTubeClientContext
  /** Video ID to retrieve player data for */
  videoId: string
  /** Whether to allow content that may need review */
  contentCheckOk?: boolean
  /** Whether to allow potentially racy content */
  racyCheckOk?: boolean
  /** Additional parameters for embedded players */
  params?: string
  /** Playback context with signature timestamps and cipher info */
  playbackContext?: Record<string, unknown>
  /** Serialized third-party embed configuration */
  serializedThirdPartyEmbedConfig?: Record<string, unknown>
  /** Service integrity dimensions (poToken) */
  serviceIntegrityDimensions?: {
    poToken: string
    [key: string]: unknown
  }
  /** Allow additional properties */
  [key: string]: unknown
}

/**
 * Typed request body for YouTube innertube next (playlist) requests.
 *
 * @internal
 */
export interface YouTubeNextRequestBody {
  /** Client context with device and session info */
  context: YouTubeClientContext
  /** Playlist ID to retrieve */
  playlistId: string
  /** Optional video ID (required for radio/mix playlists starting with RD) */
  videoId?: string | null
  /** Whether to allow content that may need review */
  contentCheckOk?: boolean
  /** Whether to allow potentially racy content */
  racyCheckOk?: boolean
  /** YouTube Music: enable persistent playlist panel */
  enablePersistentPlaylistPanel?: boolean
  /** YouTube Music: audio-only mode */
  isAudioOnly?: boolean
  /** Allow additional properties */
  [key: string]: unknown
}

/**
 * Macro markers list item renderer data for chapter extraction.
 *
 * @internal
 */
export interface MacroMarkersListItemData {
  /** Chapter title */
  title?: {
    simpleText?: string
    runs?: Array<{ text: string }>
    [key: string]: unknown
  }
  /** Time description text (e.g., "1:23") */
  timeDescription?: {
    simpleText?: string
    runs?: Array<{ text: string }>
    [key: string]: unknown
  }
  /** Thumbnail images for the chapter */
  thumbnail?: {
    thumbnails?: Array<{
      url: string
      width?: number
      height?: number
      [key: string]: unknown
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * Video renderer data used for chapter extraction.
 *
 * @internal
 */
export interface VideoRendererWithChapters {
  /** Video ID */
  videoId?: string
  /** Expandable metadata containing chapter cards */
  expandableMetadata?: {
    expandableMetadataRenderer?: {
      expandedContent?: {
        horizontalCardListRenderer?: {
          cards?: Array<{
            macroMarkersListItemRenderer?: MacroMarkersListItemData
            [key: string]: unknown
          }>
          [key: string]: unknown
        }
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}
