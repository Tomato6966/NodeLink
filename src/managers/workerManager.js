import cluster from 'node:cluster';
import os from 'node:os';
import crypto from 'node:crypto';
import { logger } from '../utils.js';

export default class WorkerManager {
    constructor(config) {
        this.config = config;
        this.workers = [];
        this.guildToWorker = new Map();
        this.nextStatelessWorkerIndex = 0;
        this.pendingRequests = new Map();
        this.maxWorkers = config.cluster.workers === 0 ? os.cpus().length : Math.max(1, config.cluster.workers || 0);
        this.minWorkers = 1;
        this.workerLoad = new Map(); 

        logger('info', 'Cluster', `Primary PID ${process.pid} - WorkerManager initialized. Max workers: ${this.maxWorkers}`);

        this.ensureWorkerAvailability();

        cluster.on('exit', (worker, code, signal) => {
            logger('warn', 'Cluster', `Worker ${worker.process.pid} exited (code=${code}). Respawning...`);
            this.removeWorker(worker.id);
             if (this.workers.length < this.minWorkers || Array.from(this.guildToWorker.values()).some(wId => wId === worker.id)) {
                this.forkWorker();
            }
        });
    }

    forkWorker() {
        if (this.workers.length >= this.maxWorkers) {
            logger('warn', 'Cluster', `Cannot fork new worker: maximum worker limit (${this.maxWorkers}) reached.`);
            return null;
        }
        const worker = cluster.fork();
        this.workers.push(worker);
        this.workerLoad.set(worker.id, 0);
        logger('info', 'Cluster', `Spawned worker ${worker.process.pid}`);

        worker.on('message', (msg) => this.handleWorkerMessage(worker, msg));
        return worker;
    }

    removeWorker(workerId) {
        const index = this.workers.findIndex((w) => w.id === workerId);
        if (index !== -1) this.workers.splice(index, 1);
        this.workerLoad.delete(workerId);

        const affectedGuilds = [];
        for (const [guildId, wId] of this.guildToWorker.entries()) {
            if (wId === workerId) {
                affectedGuilds.push(guildId);
                this.guildToWorker.delete(guildId);
                logger('warn', 'Cluster', `Guild ${guildId} unassigned due to worker ${workerId} exit. Will be reassigned on next request.`);
            }
        }

        if (affectedGuilds.length > 0 && process.connected) {
            process.send({ type: 'workerFailed', payload: { workerId, affectedGuilds } });
        }
    }

    handleWorkerMessage(worker, msg) {
        if (msg.type === 'commandResult') {
            const callback = this.pendingRequests.get(msg.requestId);
            if (callback) {
                clearTimeout(callback.timeout); 
                this.pendingRequests.delete(msg.requestId);
                if (msg.error) callback.reject(new Error(String(msg.error)));
                else callback.resolve(msg.payload);
            }
        } else if (msg.type === 'workerStats') {
            this.workerLoad.set(worker.id, msg.stats.players);
        } else if (global.nodelink) {
            global.nodelink.handleIPCMessage(msg);
        }
    }

    getWorkerForGuild(guildId) {
        if (this.guildToWorker.has(guildId)) {
            const workerId = this.guildToWorker.get(guildId);
            const worker = this.workers.find(w => w.id === workerId);
            if (worker?.isConnected()) return worker;
           this.guildToWorker.delete(guildId);
        }

        his.ensureWorkerAvailability();

        let bestWorker = null;
        let minLoad = Infinity;

        for (const worker of this.workers) {
            if (worker.isConnected()) {
                const load = this.workerLoad.get(worker.id) || 0;
                if (load < minLoad) {
                    minLoad = load;
                    bestWorker = worker;
                }
            }
        }

        if (!bestWorker) {
           bestWorker = this.forkWorker();
            if (!bestWorker) {
                throw new Error('No workers available and cannot fork new ones.');
            }
        }

        this.assignGuildToWorker(guildId, bestWorker);
        return bestWorker;
    }

    getBestWorker() {
        if (this.workers.length === 0) {
            const worker = this.forkWorker();
            if (!worker) throw new Error('No workers available and cannot fork new ones.');
            return worker;
        }
        const worker = this.workers[this.nextStatelessWorkerIndex];
        this.nextStatelessWorkerIndex = (this.nextStatelessWorkerIndex + 1) % this.workers.length;
        return worker;
    }

    assignGuildToWorker(guildId, worker) {
        this.guildToWorker.set(guildId, worker.id);
        logger('debug', 'Cluster', `Assigned guild ${guildId} to worker ${worker.id}`);
    }

    unassignGuild(guildId) {
        this.guildToWorker.delete(guildId);
    }

    isGuildAssigned(guildId) {
        return this.guildToWorker.has(guildId);
    }

    ensureWorkerAvailability() {
        if (this.workers.length === 0 && this.maxWorkers > 0) {
            logger('info', 'Cluster', 'No workers available, forking initial worker.');
            this.forkWorker();
        }
    }

    execute(worker, type, payload) {
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomBytes(16).toString('hex');
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request of type '${type}' to worker timed out`));
            }, 15000)

            this.pendingRequests.set(requestId, { resolve, reject, timeout });

            worker.send({ type, requestId, payload });
        });
    }
}