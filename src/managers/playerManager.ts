import type { Player as PlaybackPlayer } from '../playback/player.ts'
import type { Session } from '../typings/index.types.ts'
import type {
  CrossfadeConfig,
  FadingConfig,
  FiltersState,
  NodeLink as PlaybackNodeLink,
  Session as PlaybackSession,
  PlayerStateJSON,
  PlayerTrack,
  PlayerVoiceState,
  PlayPayload
} from '../typings/playback/player.types.ts'
import { logger } from '../utils.ts'

interface ClusterWorkerLike {
  id: number
}

interface WorkerManagerLike {
  getWorkerForGuild: (playerKey: string) => ClusterWorkerLike | null
  execute: <T = unknown>(
    worker: ClusterWorkerLike,
    type: string,
    payload: Record<string, unknown>,
    options?: { fast?: boolean; timeoutMs?: number }
  ) => Promise<T>
  assignGuildToWorker: (playerKey: string, worker: ClusterWorkerLike) => void
  unassignGuild: (playerKey: string) => void
  isGuildAssigned: (playerKey: string) => boolean
}

type PlayerInterceptorAction =
  | 'play'
  | 'preload'
  | 'stop'
  | 'pause'
  | 'seek'
  | 'volume'
  | 'setFilters'
  | 'setFading'
  | 'setCrossfade'
  | 'updateVoice'

type PlayerInterceptor = (
  action: PlayerInterceptorAction,
  guildId: string,
  args: readonly unknown[]
) => unknown | Promise<unknown>

interface PlayerManagerNodelinkContext extends PlaybackNodeLink {
  sessions: {
    get: (id: string) => Session | undefined
  }
  statistics: {
    players: number
  }
  workerManager: WorkerManagerLike | null
  extensions?: PlaybackNodeLink['extensions'] & {
    playerInterceptors?: PlayerInterceptor[]
  }
}

interface ClusterPlayerSnapshot {
  guildId: string
  userId: string | undefined
  sessionId: string
}

interface CreatePlayerResult {
  created?: boolean
  reason?: string
}

interface PlayerCommandResponse extends Record<string, unknown> {
  playerNotFound?: boolean
}

interface InterceptorResult {
  handled: true
  result: unknown
}

interface MixAddResult {
  id: string
  track: PlayerTrack
  volume: number
}

interface MixState {
  id: string
  track: PlayerTrack
  volume: number
  position: number
  startTime: number
}

type ManagedPlayer = PlaybackPlayer | ClusterPlayerSnapshot

/**
 * Session-scoped manager that controls player lifecycle and player commands.
 *
 * @remarks
 * - In single-process mode, this manager directly calls {@link PlaybackPlayer} methods.
 * - In cluster mode, it forwards commands to the worker responsible for the player.
 * - Player entries are scoped by `{sessionId}:{guildId}` keys to prevent collisions.
 */
export default class PlayerManager {
  private readonly nodelink: PlayerManagerNodelinkContext
  private readonly sessionId: string

  public readonly players: Map<string, ManagedPlayer>

  private readonly isCluster: boolean
  private readonly pendingCreates: Map<string, Promise<ManagedPlayer>>

  constructor(nodelink: PlayerManagerNodelinkContext, sessionId: string) {
    this.nodelink = nodelink
    this.sessionId = sessionId
    this.players = new Map()
    this.isCluster = nodelink.workerManager !== null
    this.pendingCreates = new Map()
  }

  private getPlayerKey(guildId: string): string {
    return `${this.sessionId}:${guildId}`
  }

  private getSessionOrThrow(): Session {
    const session = this.nodelink.sessions.get(this.sessionId)
    if (!session) {
      throw new Error(`Session ${this.sessionId} was not found.`)
    }
    return session
  }

  private getSessionUserId(session: Session): string | undefined {
    if (Array.isArray(session.userId)) {
      return session.userId[0]
    }
    return session.userId
  }

  private getWorkerManagerOrThrow(): WorkerManagerLike {
    if (!this.nodelink.workerManager) {
      throw new Error('Worker manager is not available in this context.')
    }
    return this.nodelink.workerManager
  }

  private isClusterPlayerSnapshot(
    player: ManagedPlayer
  ): player is ClusterPlayerSnapshot {
    return typeof (player as Partial<PlaybackPlayer>).play !== 'function'
  }

  private getLocalPlayerOrThrow(playerKey: string): PlaybackPlayer {
    const player = this.players.get(playerKey)
    if (!player || this.isClusterPlayerSnapshot(player)) {
      throw new Error('Player not found locally.')
    }
    return player
  }

  private async runClusterPlayerCommand(
    guildId: string,
    command: string,
    args: readonly unknown[]
  ): Promise<PlayerCommandResponse> {
    const session = this.getSessionOrThrow()
    const playerKey = this.getPlayerKey(guildId)
    const workerManager = this.getWorkerManagerOrThrow()
    const worker = workerManager.getWorkerForGuild(playerKey)

    if (!worker) {
      throw new Error('Player not assigned to a worker.')
    }

    const result = await workerManager.execute<PlayerCommandResponse>(
      worker,
      'playerCommand',
      {
        sessionId: this.sessionId,
        guildId,
        userId: this.getSessionUserId(session),
        command,
        args: [...args]
      }
    )

    if (result?.playerNotFound) {
      throw new Error('Player not found.')
    }

    return result
  }

  async _runInterceptors(
    action: PlayerInterceptorAction,
    guildId: string,
    ...args: unknown[]
  ): Promise<InterceptorResult | null> {
    const interceptors = this.nodelink.extensions?.playerInterceptors
    if (!interceptors || interceptors.length === 0) return null

    for (const interceptor of interceptors) {
      if (typeof interceptor !== 'function') continue

      try {
        const result = await interceptor(action, guildId, args)
        if (result !== null && result !== undefined && result !== false) {
          return { handled: true, result }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        logger(
          'error',
          'PlayerManager',
          `Interceptor error for ${action}: ${errorMessage}`
        )
      }
    }

    return null
  }

  async create(
    guildId: string,
    voice?: Partial<PlayerVoiceState>
  ): Promise<ManagedPlayer> {
    const session = this.getSessionOrThrow()
    const playerKey = this.getPlayerKey(guildId)

    const existingPlayer = this.players.get(playerKey)
    if (existingPlayer) {
      logger(
        'debug',
        'PlayerManager',
        `Returning existing player for guild ${guildId} (session: ${this.sessionId})`
      )
      return existingPlayer
    }

    const pendingCreate = this.pendingCreates.get(playerKey)
    if (pendingCreate) {
      return pendingCreate
    }

    const createPromise = this._createInternal(
      session,
      guildId,
      voice,
      playerKey
    ).finally(() => {
      this.pendingCreates.delete(playerKey)
    })

    this.pendingCreates.set(playerKey, createPromise)
    return createPromise
  }

  private async _createInternal(
    session: Session,
    guildId: string,
    voice: Partial<PlayerVoiceState> | undefined,
    playerKey: string
  ): Promise<ManagedPlayer> {
    if (this.isCluster) {
      const workerManager = this.getWorkerManagerOrThrow()
      const worker = workerManager.getWorkerForGuild(playerKey)
      if (!worker) {
        throw new Error('No workers available to create a player.')
      }

      let createSucceeded = false

      try {
        logger(
          'debug',
          'PlayerManager',
          `Creating player for guild ${guildId} (session: ${this.sessionId}) on worker ${worker.id}`
        )

        const createResult = await workerManager.execute<CreatePlayerResult>(
          worker,
          'createPlayer',
          {
            sessionId: this.sessionId,
            guildId,
            userId: this.getSessionUserId(session),
            voice
          }
        )

        if (
          createResult?.created === false &&
          createResult?.reason !== 'Player already exists'
        ) {
          throw new Error(
            createResult?.reason || 'The player could not be created.'
          )
        }

        createSucceeded = true

        if (!this.players.has(playerKey)) {
          this.players.set(playerKey, {
            guildId,
            userId: this.getSessionUserId(session),
            sessionId: this.sessionId
          })
        }

        workerManager.assignGuildToWorker(playerKey, worker)

        const player = this.players.get(playerKey)
        if (!player) {
          throw new Error('Player map did not contain the created entry.')
        }

        return player
      } catch (error) {
        if (!createSucceeded) {
          workerManager.unassignGuild(playerKey)
          throw new Error('The player could not be created.', { cause: error })
        }

        throw error
      }
    }

    const userId = this.getSessionUserId(session)
    if (!userId) {
      throw new Error(`Session ${this.sessionId} is missing a valid user id.`)
    }
    if (!session.socket) {
      throw new Error(`Session ${this.sessionId} socket is not available.`)
    }

    const localSession: PlaybackSession = {
      id: session.id,
      userId,
      socket: session.socket,
      eventQueue: session.eventQueue,
      isPaused: session.isPaused
    }

    const { Player } = await import('../playback/player.ts')
    logger(
      'debug',
      'PlayerManager',
      `Creating new player for guild ${guildId} (session: ${this.sessionId})`
    )

    const player = new Player({
      nodelink: this.nodelink,
      session: localSession,
      guildId
    })

    this.players.set(playerKey, player)
    this.nodelink.statistics.players += 1

    return player
  }

  get(guildId: string): ManagedPlayer | undefined {
    return this.players.get(this.getPlayerKey(guildId))
  }

  async destroy(guildId: string): Promise<void> {
    const playerKey = this.getPlayerKey(guildId)

    if (this.isCluster) {
      const workerManager = this.getWorkerManagerOrThrow()

      if (!workerManager.isGuildAssigned(playerKey)) {
        return
      }

      const worker = workerManager.getWorkerForGuild(playerKey)
      if (worker) {
        await workerManager.execute(worker, 'destroyPlayer', {
          sessionId: this.sessionId,
          guildId
        })
      }

      workerManager.unassignGuild(playerKey)
      this.players.delete(playerKey)
      return
    }

    const player = this.getLocalPlayerOrThrow(playerKey)
    player.destroy()
    this.players.delete(playerKey)
    this.nodelink.statistics.players = Math.max(
      0,
      this.nodelink.statistics.players - 1
    )
  }

  async play(
    guildId: string,
    trackPayload: PlayPayload
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'play',
      guildId,
      trackPayload
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'play', [trackPayload])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.play(trackPayload)
  }

  async preload(
    guildId: string,
    trackPayload: PlayerTrack
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'preload',
      guildId,
      trackPayload
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'preload', [trackPayload])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.preload(trackPayload)
  }

  async stop(guildId: string): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors('stop', guildId)
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'stop', [])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.stop()
  }

  async pause(
    guildId: string,
    shouldPause: boolean
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'pause',
      guildId,
      shouldPause
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'pause', [shouldPause])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.pause(shouldPause)
  }

  async seek(
    guildId: string,
    position?: number,
    endTime?: number
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'seek',
      guildId,
      position,
      endTime
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'seek', [position, endTime])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.seek(position, endTime)
  }

  async volume(
    guildId: string,
    level: number
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors('volume', guildId, level)
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'volume', [level])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.volume(level)
  }

  async setFilters(
    guildId: string,
    filtersPayload: FiltersState | Record<string, unknown>
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'setFilters',
      guildId,
      filtersPayload
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'setFilters', [
        filtersPayload
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.setFilters(filtersPayload as FiltersState)
  }

  async setFading(
    guildId: string,
    fadingConfig?: FadingConfig
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'setFading',
      guildId,
      fadingConfig
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'setFading', [fadingConfig])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.setFading(fadingConfig)
  }

  async setCrossfade(
    guildId: string,
    crossfadeConfig?: CrossfadeConfig
  ): Promise<boolean | PlayerCommandResponse> {
    const interception = await this._runInterceptors(
      'setCrossfade',
      guildId,
      crossfadeConfig
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'setCrossfade', [
        crossfadeConfig
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.setCrossfade(crossfadeConfig)
  }

  async setLoudnessNormalizer(
    guildId: string,
    enabled: boolean
  ): Promise<boolean | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'setLoudnessNormalizer', [
        enabled
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.setLoudnessNormalizer(enabled)
  }

  async updateVoice(
    guildId: string,
    voicePayload: Partial<PlayerVoiceState>
  ): Promise<PlayerCommandResponse | undefined> {
    const interception = await this._runInterceptors(
      'updateVoice',
      guildId,
      voicePayload
    )
    if (interception?.handled)
      return interception.result as PlayerCommandResponse

    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'updateVoice', [
        voicePayload
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    player.updateVoice(voicePayload)
    return undefined
  }

  async toJSON(
    guildId: string
  ): Promise<PlayerStateJSON | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'toJSON', [])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.toJSON()
  }

  async addMix(
    guildId: string,
    trackPayload: PlayerTrack,
    volume: number | null = null
  ): Promise<MixAddResult | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'addMix', [
        trackPayload,
        volume
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.addMix(trackPayload, volume)
  }

  async removeMix(
    guildId: string,
    mixId: string
  ): Promise<boolean | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'removeMix', [mixId])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.removeMix(mixId)
  }

  async updateMix(
    guildId: string,
    mixId: string,
    volume: number
  ): Promise<boolean | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'updateMix', [mixId, volume])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.updateMix(mixId, volume)
  }

  async getMixes(guildId: string): Promise<MixState[] | PlayerCommandResponse> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'getMixes', [])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    return player.getMixes()
  }

  async subscribeLyrics(
    guildId: string,
    skipTrackSource: boolean | string | undefined
  ): Promise<PlayerCommandResponse | undefined> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'subscribeLyrics', [
        skipTrackSource
      ])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    await player.subscribeLyrics(skipTrackSource)
    return undefined
  }

  async unsubscribeLyrics(
    guildId: string
  ): Promise<PlayerCommandResponse | undefined> {
    if (this.isCluster) {
      return this.runClusterPlayerCommand(guildId, 'unsubscribeLyrics', [])
    }

    const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId))
    await player.unsubscribeLyrics()
    return undefined
  }
}
