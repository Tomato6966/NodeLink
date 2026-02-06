
declare module '@performanc/pwsl-server' {
    import { EventEmitter } from 'node:events';

    export default class WebSocketServer extends EventEmitter {
        constructor(options?: any);
        handleUpgrade(request: any, socket: any, head: any, context: any, callback: (ws: any) => void): void;
        handleUpgrade(request: any, socket: any, head: any, callback: (ws: any) => void): void;
    }
}

declare namespace NodeJS {
    interface Process {
        embedder?: string;
    }
}

declare var nodelink: any;
