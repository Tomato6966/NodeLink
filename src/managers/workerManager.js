import cluster from 'node:cluster';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from '../utils.js';

export default class WorkerManager {
    constructor(config) {
        this.workers = [];
        this.guildToWorker = new Map();
        this.nextStatelessWorkerIndex = 0;
        this.pendingRequests = new Map();

        const workersCount = config.cluster.workers === 0 ? os.cpus().length : Math.max(1, config.cluster.workers || 0);
        logger('info', 'Cluster', `Primary PID ${process.pid} - starting ${workersCount} workers`);

        for (let i = 0; i < workersCount; i++) {
            this.forkWorker();
        }

        cluster.on('exit', (worker, code, signal) => {
            logger('warn', 'Cluster', `Worker ${worker.process.pid} exited (code=${code}). Respawning...`);
            this.removeWorker(worker.id);
            this.forkWorker();
        });
    }

    forkWorker() {
        const worker = cluster.fork();
        this.workers.push(worker);
        logger('info', 'Cluster', `Spawned worker ${worker.process.pid}`);

        worker.on('message', (msg) => this.handleWorkerMessage(worker, msg));
        return worker;
    }

    removeWorker(workerId) {
        const index = this.workers.findIndex((w) => w.id === workerId);
        if (index !== -1) this.workers.splice(index, 1);

        for (const [guildId, wId] of this.guildToWorker.entries()) {
            if (wId === workerId) {
                this.guildToWorker.delete(guildId);
            }
        }
    }

    handleWorkerMessage(worker, msg) {
        if (msg.type === 'commandResult') {
            const callback = this.pendingRequests.get(msg.requestId);
            if (callback) {
                this.pendingRequests.delete(msg.requestId);
                if (msg.error) callback.reject(new Error(String(msg.error)));
                else callback.resolve(msg.payload);
            }
        } else if (global.nodelink) {
            global.nodelink.handleIPCMessage(msg);
        }
    }

    getWorkerForGuild(guildId) {
        if (this.guildToWorker.has(guildId)) {
            const workerId = this.guildToWorker.get(guildId);
            const worker = this.workers.find(w => w.id === workerId);
            if (worker?.isConnected()) return worker;
        }

        const worker = this.getBestWorker();
        this.assignGuildToWorker(guildId, worker);
        return worker;
    }

    getBestWorker() {
        if (this.workers.length === 0) return null;
        const worker = this.workers[this.nextStatelessWorkerIndex];
        this.nextStatelessWorkerIndex = (this.nextStatelessWorkerIndex + 1) % this.workers.length;
        return worker;
    }

    assignGuildToWorker(guildId, worker) {
        this.guildToWorker.set(guildId, worker.id);
    }

    unassignGuild(guildId) {
        this.guildToWorker.delete(guildId);
    }

    isGuildAssigned(guildId) {
        return this.guildToWorker.has(guildId);
    }

    execute(worker, type, payload) {
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomBytes(16).toString('hex');
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request of type '${type}' to worker timed out`));
            }, 30000);

            this.pendingRequests.set(requestId, { resolve, reject });

            worker.send({ type, requestId, payload });
        });
    }
}