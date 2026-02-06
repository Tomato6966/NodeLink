export interface ClientInfo {
    name: string
    version?: string
    url?: string
    codename?: string
    releaseDate?: string
}

export type IPCMessage =
    | {
        type: 'playerEvent'
        payload: {
            sessionId: string
            data: any
        }
    }
    | {
        type: 'workerStats'
        pid: number
        stats: {
            players: number
            playingPlayers: number
            memory?: {
                used: number
                allocated: number
            }
            cpu?: {
                nodelinkLoad: number
            }
            frameStats?: {
                sent: number
                nulled: number
                expected: number
            }
        }
    }
    | {
        type: 'workerFailed'
        payload: {
            workerId: number
            affectedGuilds: string[]
        }
    }
    | {
        type: string
        [key: string]: any
    }

export interface Extension {
    method: string
    path: string
    handler: any
}

export interface TrackModifier {
    (data: any): void
}

export interface WebSocketInterceptor {
    (
        nodelink: any,
        socket: any,
        data: any,
        clientInfo: any
    ): Promise<boolean | void>
}

export interface AudioInterceptor {
    (
        pcm: Buffer,
        sampleRate: number,
        channels: number,
        format: string
    ): Promise<Buffer>
}

export interface PlayerInterceptor {
    (player: any): void
}

export interface ReqShim {
    method?: string
    url?: string
    headers: Record<string, any>
    socket?: {
        remoteAddress?: string
    }
    on?: (event: string, cb: (...args: any[]) => void) => void
    [key: string]: any
}

export interface ResShim {
    _status: number
    _headers: Record<string, any>
    _body: any[]
    writeHead: (status: number, headers?: Record<string, any>) => void
    setHeader: (name: string, value: any) => void
    getHeader: (name: string) => any
    end: (data?: any) => void
    write: (data: any) => void
    [key: string]: any
}
