import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { logger } from '../../utils.js';
import { poTokenManager } from './potoke.js';
import {
    UMPPartId,
    FormatInitializationMetadata,
    SabrError,
    SabrRedirect,
    StreamProtectionStatus,
    MediaHeader,
    NextRequestPolicy,
    PlaybackStartPolicy,
    RequestIdentifier,
    RequestCancellationPolicy,
    SabrContextUpdate,
    SabrContextSendingPolicy,
    VideoPlaybackAbrRequest,
    ProtoReader,
    ReloadPlaybackContext,
    base64ToU8,
    concatenateChunks
} from './protor.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const MAX_BUFFER_BYTES = 512 * 1024;
const MIN_REQUEST_INTERVAL_MS = 500;

function sha256Hex(u8) {
    const h = createHash('sha256');
    h.update(u8);
    return h.digest('hex');
}

function b64Trunc(u8, maxBytes) {
    const slice = u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8;
    return Buffer.from(slice).toString('base64');
}

function umpPartName(type) {
    switch (type) {
        case UMPPartId.FORMAT_INITIALIZATION_METADATA: return 'FORMAT_INITIALIZATION_METADATA';
        case UMPPartId.NEXT_REQUEST_POLICY: return 'NEXT_REQUEST_POLICY';
        case UMPPartId.SABR_ERROR: return 'SABR_ERROR';
        case UMPPartId.SABR_REDIRECT: return 'SABR_REDIRECT';
        case UMPPartId.PLAYBACK_START_POLICY: return 'PLAYBACK_START_POLICY';
        case UMPPartId.REQUEST_IDENTIFIER: return 'REQUEST_IDENTIFIER';
        case UMPPartId.REQUEST_CANCELLATION_POLICY: return 'REQUEST_CANCELLATION_POLICY';
        case UMPPartId.SABR_CONTEXT_UPDATE: return 'SABR_CONTEXT_UPDATE';
        case UMPPartId.SABR_CONTEXT_SENDING_POLICY: return 'SABR_CONTEXT_SENDING_POLICY';
        case UMPPartId.STREAM_PROTECTION_STATUS: return 'STREAM_PROTECTION_STATUS';
        case UMPPartId.RELOAD_PLAYER_RESPONSE: return 'RELOAD_PLAYER_RESPONSE';
        case UMPPartId.MEDIA_HEADER: return 'MEDIA_HEADER';
        case UMPPartId.MEDIA: return 'MEDIA';
        case UMPPartId.MEDIA_END: return 'MEDIA_END';
        case UMPPartId.SNACKBAR_MESSAGE: return 'SNACKBAR_MESSAGE';
        default: return `UNKNOWN_${type}`;
    }
}

function wait(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();

        let t;
        const onAbort = () => {
            if (t) clearTimeout(t);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };

        t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        t.unref?.();

        if (signal) signal.addEventListener('abort', onAbort);
    });
}

function createKey(itag, xtags) {
    return `${itag || ''}:${xtags || ''}`;
}

const FormatKeyUtils = {
    fromFormatInitializationMetadata: (meta) => {
        const itag = meta.formatId?.itag ?? meta.itag;
        const xtags = meta.formatId?.xtags ?? meta.xtags;
        return createKey(itag, xtags);
    },
    fromMediaHeader: (mediaHeader) => {
        const itag = mediaHeader.formatId?.itag ?? mediaHeader.itag;
        const xtags = mediaHeader.formatId?.xtags ?? mediaHeader.xtags;
        return createKey(itag, xtags);
    }
};

class CompositeBuffer {
    constructor(chunks = []) {
        this.chunks = [];
        this.currentChunkOffset = 0;
        this.currentChunkIndex = 0;
        this.totalLength = 0;
        this.currentDataView = undefined;
        chunks.forEach((chunk) => this.append(chunk));
    }
    append(chunk) {
        if (chunk instanceof Uint8Array) {
            if (chunk.length === 0) return;
            this.chunks.push(chunk);
            this.totalLength += chunk.length;
        } else if (chunk instanceof CompositeBuffer) {
            chunk.chunks.forEach((c) => this.append(c));
        }
        this.currentDataView = undefined;
    }
    split(position) {
        const extractedBuffer = new CompositeBuffer();
        const remainingBuffer = new CompositeBuffer();
        let remainingPos = position;

        for(const chunk of this.chunks) {
            if (remainingPos >= chunk.length) {
                extractedBuffer.append(chunk);
                remainingPos -= chunk.length;
            } else if (remainingPos > 0) {
                extractedBuffer.append(chunk.subarray(0, remainingPos));
                remainingBuffer.append(chunk.subarray(remainingPos));
                remainingPos = 0;
            } else {
                remainingBuffer.append(chunk);
            }
        }
        return { extractedBuffer, remainingBuffer };
    }
    canReadBytes(position, length) { return position + length <= this.totalLength; }
    getUint8(position) {
        this.focus(position);
        return this.chunks[this.currentChunkIndex][position - this.currentChunkOffset];
    }
    getLength() { return this.totalLength; }
    focus(position) {
        if (position < this.currentChunkOffset) this.resetFocus();
        while (this.currentChunkIndex < this.chunks.length && this.currentChunkOffset + this.chunks[this.currentChunkIndex].length <= position) {
            this.currentChunkOffset += this.chunks[this.currentChunkIndex].length;
            this.currentChunkIndex += 1;
        }
        this.currentDataView = undefined;
    }
    resetFocus() { this.currentChunkIndex = 0; this.currentChunkOffset = 0; this.currentDataView = undefined; }
}

class UmpReader {
    constructor(compositeBuffer) { this.compositeBuffer = compositeBuffer; }
    read(handlePart) {
        while (true) {
            let offset = 0;
            const [partType, nextOffset] = this.readVarInt(offset);
            if (partType < 0) break;

            const [partSize, finalOffset] = this.readVarInt(nextOffset);
            if (partSize < 0) break;

            if (!this.compositeBuffer.canReadBytes(finalOffset, partSize)) {
                const split = this.compositeBuffer.split(finalOffset);
                return {
                    type: partType,
                    size: partSize,
                    headerSize: finalOffset,
                    data: split.remainingBuffer,
                    incomplete: true
                };
            }

            const splitResult = this.compositeBuffer.split(finalOffset).remainingBuffer.split(partSize);
            handlePart({ type: partType, size: partSize, data: splitResult.extractedBuffer });
            this.compositeBuffer = splitResult.remainingBuffer;
        }
        return undefined;
    }
    readVarInt(offset) {
        let byteLength;
        if (this.compositeBuffer.canReadBytes(offset, 1)) {
            const firstByte = this.compositeBuffer.getUint8(offset);
            byteLength = firstByte < 128 ? 1 : firstByte < 192 ? 2 : firstByte < 224 ? 3 : firstByte < 240 ? 4 : 5;
        } else { byteLength = 0; }
        if (byteLength < 1 || !this.compositeBuffer.canReadBytes(offset, byteLength)) return [-1, offset];

        let value;
        switch (byteLength) {
            case 1: value = this.compositeBuffer.getUint8(offset++); break;
            case 2: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x3f) + 64 * b2;
                break;
            }
            case 3: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x1f) + 32 * (b2 + 256 * b3);
                break;
            }
            case 4: {
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                const b4 = this.compositeBuffer.getUint8(offset++);
                value = (b1 & 0x0f) + 16 * (b2 + 256 * (b3 + 256 * b4));
                break;
            }
            default: {
                offset++;
                const b1 = this.compositeBuffer.getUint8(offset++);
                const b2 = this.compositeBuffer.getUint8(offset++);
                const b3 = this.compositeBuffer.getUint8(offset++);
                const b4 = this.compositeBuffer.getUint8(offset++);
                value = b1 + 256 * (b2 + 256 * (b3 + 256 * b4));
                break;
            }
        }
        return [value, offset];
    }
}

export class SabrStream extends PassThrough {
    constructor(config = {}) {
        super();
        this.config = config;
        this.videoId = config.videoId;
        this.umpPartHandlers = new Map([
            [UMPPartId.FORMAT_INITIALIZATION_METADATA, this.handleFormatInitializationMetadata.bind(this)],
            [UMPPartId.NEXT_REQUEST_POLICY, this.handleNextRequestPolicy.bind(this)],
            [UMPPartId.PLAYBACK_START_POLICY, this.handlePlaybackStartPolicy.bind(this)],
            [UMPPartId.REQUEST_IDENTIFIER, this.handleRequestIdentifier.bind(this)],
            [UMPPartId.REQUEST_CANCELLATION_POLICY, this.handleRequestCancellationPolicy.bind(this)],
            [UMPPartId.SABR_ERROR, this.handleSabrError.bind(this)],
            [UMPPartId.SABR_REDIRECT, this.handleSabrRedirect.bind(this)],
            [UMPPartId.SABR_CONTEXT_UPDATE, this.handleSabrContextUpdate.bind(this)],
            [UMPPartId.SABR_CONTEXT_SENDING_POLICY, this.handleSabrContextSendingPolicy.bind(this)],
            [UMPPartId.STREAM_PROTECTION_STATUS, this.handleStreamProtectionStatus.bind(this)],
            [UMPPartId.RELOAD_PLAYER_RESPONSE, this.handleReloadPlayerResponse.bind(this)],
            [UMPPartId.MEDIA_HEADER, this.handleMediaHeader.bind(this)],
            [UMPPartId.MEDIA, this.handleMedia.bind(this)],
            [UMPPartId.MEDIA_END, this.handleMediaEnd.bind(this)],
            [UMPPartId.SNACKBAR_MESSAGE, this.handleSnackbarMessage.bind(this)]
        ]);
        this.initializedFormatsMap = new Map();
        this.partialSegmentQueue = new Map();
        this.sabrContexts = new Map();
        this.activeSabrContextTypes = new Set();
        this.requestNumber = 0;
        this.mediaHeadersProcessed = false;
        this._aborted = false;
        this.formatSequenceCounters = new Map(); // itag -> lastSeq
        this.downloadedSegmentsByItag = new Map(); // itag -> Map<segNum, seg>

        this.poToken = config.poToken;
        this.visitorData = config.visitorData;

        this.serverAbrStreamingUrl = config.serverAbrStreamingUrl;
        if (this.serverAbrStreamingUrl) {
            const url = new URL(this.serverAbrStreamingUrl);
            url.searchParams.set('alr', 'yes');
            url.searchParams.set('ump', '1');
            url.searchParams.set('srfvp', '1');
            this.serverAbrStreamingUrl = url.toString();
        }
        this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig;
        this.clientInfo = config.clientInfo;
        this.formatIds = config.formats || [];
        this.startTime = config.startTime || 0;
        this.positionCallback = config.positionCallback;
        this.userAgent = config.userAgent || USER_AGENT;



        this.totalLength = 0;
        this.totalDurationMs = 0;
        this.totalDownloadedMs = 0;
        this.virtualPlayerTimeMs = 0;
        this.lastVirtualAdvanceAt = 0;
        this.lastIterationAt = Date.now();
        this.lastReportedPlayerTimeMs = 0;
        this.partialPart = undefined;

        this.pendingRangesHeaders = new Map();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges = new Set();

        this.enableTrafficLog = true;
        this.trafficLogPath = path.join(process.cwd(), 'sabr_traffic.jsonl');
        this.enableTrafficDump = true;
        this.trafficDumpMaxBytes = 64 * 1024;

        this.noMediaStreak = 0;
        this.abortController = new AbortController();

        if (typeof this.poToken === 'string') {
            try {
                this.poToken = base64ToU8(this.poToken);
            } catch (e) {
                logger('error', 'SABR', `Failed to decode PO token: ${e.message}`);
                this.poToken = null;
            }
        }
    }

    logTraffic(entry) {
        if (!this.enableTrafficLog) return;
        void appendFile(this.trafficLogPath, JSON.stringify(entry) + '\n').catch(() => {});
    }

    start(audioItag) {
        const audioFormat = this.formatIds.find(f => f.itag === audioItag);
        if (!audioFormat) {
            this.emit('error', new Error('Audio format not found in sabr config'));
            return;
        }

        this.loop(audioFormat);
    }

    async loop(audioFormat) {
        const signal = this.abortController.signal;
        try {
            if (this.lastVirtualAdvanceAt === 0) this.lastVirtualAdvanceAt = Date.now();
            while (!this._aborted && !this.destroyed) {
                if (this.requestNumber === 0) {
                    try {
                        const tokenData = await poTokenManager.generate(this.videoId, this.visitorData);
                        if (this._aborted || this.destroyed) break;

                        if (tokenData.poToken) {
                            this.poToken = base64ToU8(tokenData.poToken);
                            if (tokenData.visitorData && !this.visitorData) {
                                this.visitorData = tokenData.visitorData;
                            }
                            logger('debug', 'SABR', `Generated PO Token for session start. Used existing VD: ${!!this.visitorData}`);
                        }
                    } catch (e) {
                         logger('warn', 'SABR', `Failed to generate PO Token: ${e.message}`);
                    }
                }

                const now = Date.now();
                const prevPlayerTime = this.virtualPlayerTimeMs;

                if (this.totalDownloadedMs > this.virtualPlayerTimeMs) {
                    if (this.lastVirtualAdvanceAt > 0) {
                        this.virtualPlayerTimeMs += (now - this.lastVirtualAdvanceAt);
                    }
                    this.lastVirtualAdvanceAt = now;
                } else {
                    if (this.totalDownloadedMs > 0) {
                        if (this.lastVirtualAdvanceAt > 0) {
                           const advance = (now - this.lastVirtualAdvanceAt);
                           this.virtualPlayerTimeMs = Math.min(this.virtualPlayerTimeMs + advance, this.totalDownloadedMs);
                        }
                        this.lastVirtualAdvanceAt = now;
                    }
                }

                if (Math.floor(this.virtualPlayerTimeMs / 1000) !== Math.floor(prevPlayerTime / 1000)) {
                    logger('debug', 'SABR', `Tracking: downloaded=${Math.floor(this.totalDownloadedMs)}ms virtualPlayerTime=${Math.floor(prevPlayerTime)}ms -> ${Math.floor(this.virtualPlayerTimeMs)}ms`);
                }

                this.lastIterationAt = now;

                let reportedPlayerTime = Math.floor(this.virtualPlayerTimeMs);

                this.lastReportedPlayerTimeMs = reportedPlayerTime;

                if (this.readableLength > MAX_BUFFER_BYTES) {
                    await wait(250, signal);
                    continue;
                }

                if (this.mediaHeadersProcessed && this.positionCallback) {
                    this.positionCallback(reportedPlayerTime);
                }

                if (this.lastRequestAt) {
                    const since = now - this.lastRequestAt;
                    if (since < MIN_REQUEST_INTERVAL_MS) await wait(MIN_REQUEST_INTERVAL_MS - since, signal);
                }
                this.lastRequestAt = Date.now();

                try {
                    await this.fetchAndProcessSegments({
                        playerTimeMs: Math.floor(this.totalDownloadedMs),
                        bandwidthEstimate: 15000000,
                        enabledTrackTypesBitfield: 1,
                        audioTrackId: audioFormat.audioTrackId || "",
                        playerState: 1n,
                        visibility: 1,
                        playbackRate: 1.0,
                        stickyResolution: 1080,
                        lastManualSelectedResolution: 1080,
                        clientViewportIsFlexible: false
                    }, audioFormat);
                } catch (e) {
                    if (this._aborted || this.destroyed) break;

                    if (e.message.includes('sabr.malformed_config') || e.message.includes('sabr.media_serving_enforcement_id_error')) {
                        logger('warn', 'SABR', `Recoverable error detected: ${e.message}. Triggering recovery signal...`);

                        if (e.message.includes('media_serving_enforcement_id_error')) {
                            logger('warn', 'SABR', 'Enforcement ID error detected. Clearing SABR contexts to force fresh state.');
                            this.sabrContexts.clear();
                            this.activeSabrContextTypes.clear();
                        }

                        this.emit('stall');

                        const currentRn = this.requestNumber;
                        while (this.requestNumber === currentRn && !this._aborted && !this.destroyed) {
                            await wait(500, signal);
                        }
                        continue;
                    }

                    throw e;
                }

                if (!this.nextRequestPolicy?.backoffTimeMs && this.initializedFormatsMap.size === 0) {
                    await wait(250, signal);
                }
            }
        } catch (e) {
            if (!this.destroyed) this.destroy(e);
        }
    }

    destroy(err) {
        if (this._aborted) return;
        this._aborted = true;
        this.abortController.abort();
        super.destroy(err);
    }

    updateSession(config) {
        if (config.serverAbrStreamingUrl) {
            const url = new URL(config.serverAbrStreamingUrl);
            url.searchParams.set('alr', 'yes');
            url.searchParams.set('ump', '1');
            url.searchParams.set('srfvp', '1');
            this.serverAbrStreamingUrl = url.toString();
        }
        if (config.videoPlaybackUstreamerConfig) {
            this.videoPlaybackUstreamerConfig = config.videoPlaybackUstreamerConfig;
        }
        if (config.poToken) {
            try {
                this.poToken = typeof config.poToken === 'string' ? base64ToU8(config.poToken) : config.poToken;
            } catch (e) {
                logger('error', 'SABR', `Failed to decode PO token (session update): ${e.message}`);
            }
        }
        if (config.playbackCookie) {
            if (!this.nextRequestPolicy) this.nextRequestPolicy = {};
            this.nextRequestPolicy.playbackCookie = config.playbackCookie;
        } else if (this.nextRequestPolicy) {
            delete this.nextRequestPolicy.playbackCookie;
        }
        this.requestNumber = 0;
        this.noMediaStreak = 0;
        this.pendingRangesHeaders.clear();

        logger('info', 'SABR', `Session updated. Continuing with RN=${this.requestNumber}, URL=${this.serverAbrStreamingUrl.slice(0, 50)}...`);
    }

    clearBuffers() {
        this.initializedFormatsMap.clear();
        this.downloadedSegmentsByItag.clear();
        this.formatSequenceCounters.clear();
        this.partialSegmentQueue.clear();

        this.mediaHeadersProcessed = false;
        this.pendingRangesHeaders.clear();
        this.cachedBufferedRanges = null;
        this.lastReportedRanges.clear();

        this.sabrContexts.clear();
        this.activeSabrContextTypes.clear();

        logger('info', 'SABR', `Buffers cleared for recovery. Preserving timeline position: ${this.cumulativeDownloadedMs}ms`);
    }

    decodePart(part, decoder) {
        try {
            const chunks = part.data.chunks;
            const data = chunks.length === 1 ? chunks[0] : concatenateChunks(chunks);
            return decoder.decode(new ProtoReader(data), data.length);
        } catch {
            return undefined;
        }
    }

    getInitializedByFormat(format) {
        if (!format) return undefined;
        const direct = this.initializedFormatsMap.get(createKey(format.itag, format.xtags));
        if (direct) return direct;

        const prefix = `${format.itag}:`;
        for (const [k, v] of this.initializedFormatsMap.entries()) {
            if (k.startsWith(prefix)) return v;
        }

        return undefined;
    }

    resolveFormatIdForRequest(format) {
        if (!format) return undefined;
        if (format.xtags) return { itag: format.itag, lastModified: format.lastModified, xtags: format.xtags };

        const prefix = `${format.itag}:`;
        for (const [k, v] of this.initializedFormatsMap.entries()) {
            if (!k.startsWith(prefix)) continue;

            const fid = v?.formatInitializationMetadata?.formatId;
            if (fid?.itag) {
                return {
                    itag: fid.itag,
                    lastModified: fid.lastModified ?? fid.last_modified ?? format.lastModified,
                    xtags: fid.xtags
                };
            }

            const xtags = k.slice(prefix.length);
            return { itag: format.itag, lastModified: format.lastModified, xtags };
        }

        return { itag: format.itag, lastModified: format.lastModified, xtags: format.xtags };
    }

    handleFormatInitializationMetadata(part) {
        const m = this.decodePart(part, FormatInitializationMetadata);
        if (!m) return;
        const k = FormatKeyUtils.fromFormatInitializationMetadata(m);
        if (!this.initializedFormatsMap.has(k)) {
            this.initializedFormatsMap.set(k, { formatInitializationMetadata: m });
            logger('debug', 'SABR', `Format init: key=${k} mime=${m.mimeType || ''} endSeg=${m.endSegmentNumber || ''}`);
        }
    }

    handleSabrError(part) {
        const err = this.decodePart(part, SabrError);
        if (err) {
            const error = new Error(`SABR Error: ${err.code} ${err.type}`);
            error.code = err.code;
            error.type = err.type;
            if (this._aborted || this.destroyed) return;
            throw error;
        }
    }

    handleSabrRedirect(part) {
        const red = this.decodePart(part, SabrRedirect);
        if(red && red.url) {
            this.serverAbrStreamingUrl = red.url;
        }
    }

    handleStreamProtectionStatus(part) {
        const status = this.decodePart(part, StreamProtectionStatus);
        if (!status) return;

        const now = Date.now();
        const changed = this.lastStreamProtectionStatus !== status.status;
        const shouldLog = changed || !this.lastStreamProtectionLogAt || (now - this.lastStreamProtectionLogAt) > 5000;

        this.lastStreamProtectionStatus = status.status;
        if (!shouldLog) return;
        this.lastStreamProtectionLogAt = now;

        if (status.status === 3) {
            logger('debug', 'SABR', `Stream Protection Status: ${status.status} (Attestation pending/required)`);
            return;
        }

        if (status.status === 2) {
            logger('warn', 'SABR', `Stream Protection Status: ${status.status} (Limited Playback). Triggering token refresh...`);
            poTokenManager.reset();
            this.emit('stall');
            return;
        }

        const level = 'warn';
        logger(level, 'SABR', `Stream Protection Status: ${status.status}`);
    }

    handleMediaPartial(buffer, headerId, isFirstChunk) {
        const s = this.partialSegmentQueue.get(headerId);
        if (s) {

            let dataToPush = buffer;

            if (isFirstChunk) {
                if (buffer.getLength() > 1) {
                    dataToPush = buffer.split(1).remainingBuffer;
                } else if (buffer.getLength() === 1) {
                    return;
                }
            }

            const bytes = dataToPush.getLength();
            s.loadedBytes = (s.loadedBytes || 0) + bytes;

            for (const c of dataToPush.chunks) this.push(c);

            if (bytes > 0) {
               // logger('debug', 'SABR', `d: ${bytes}`); // Verbose
            }
        } else {
            // logger('trace', 'SABR', `Partial media for unknown headerId: ${headerId}`);
        }
    }

    handleMedia(part) {
        const headerId = part.data.getUint8(0);
        const s = this.partialSegmentQueue.get(headerId);
        if (s) {
            const d = part.data.split(1).remainingBuffer;
            const bytes = d.totalLength;
            s.loadedBytes = (s.loadedBytes || 0) + bytes;

            for (const c of d.chunks) this.push(c);

            if (bytes > 0) {
               logger('debug', 'SABR', `Media data: id=${headerId} bytes=${bytes} total=${s.loadedBytes}/${s.mediaHeader?.contentLength || '?'}`);
            }
        } else {
            logger('trace', 'SABR', `Media data for unknown headerId: ${headerId}`);
        }
    }

    handleMediaHeader(part) {
        const h = this.decodePart(part, MediaHeader);
        if (h) {
            const key = FormatKeyUtils.fromMediaHeader(h);
            const headerId = h.headerId || 0;

            let segmentNumber = h.sequenceNumber;
            if (h.isInitSeg) {
                segmentNumber = 0;
            } else if (segmentNumber === undefined || segmentNumber === 0) {
                const count = (this.formatSequenceCounters.get(h.itag) || 0) + 1;
                this.formatSequenceCounters.set(h.itag, count);
                segmentNumber = count;
            } else {
                this.formatSequenceCounters.set(h.itag, segmentNumber);
            }

            if (!h.durationMs || h.durationMs === "0") {
                if (h.timeRange && h.timeRange.timescale > 0) {
                    h.durationMs = Math.ceil((Number(h.timeRange.durationTicks || 0n) / h.timeRange.timescale) * 1000).toString();
                }
            }

            const mediaHeader = h;
            const formatIdKey = key;

            if (!this.pendingRangesHeaders.has(formatIdKey)) {
                this.pendingRangesHeaders.set(formatIdKey, []);
            }
            this.pendingRangesHeaders.get(formatIdKey).push(mediaHeader);

            logger('debug', 'SABR', `MediaHeader: id=${headerId} itag=${h.itag} seq=${segmentNumber} dur=${h.durationMs}ms`);

            this.partialSegmentQueue.set(headerId, {
                formatIdKey: key,
                segmentNumber,
                mediaHeader: h,
                durationMs: h.durationMs,
                loadedBytes: 0
            });
        } else {
            logger('warn', 'SABR', 'Failed to decode MediaHeader');
        }
    }

    handleMediaEnd(part) {
        const id = part.data.getUint8(0);
        const s = this.partialSegmentQueue.get(id);
        if (s) {
            logger('debug', 'SABR', `MediaEnd: id=${id} seq=${s.segmentNumber} totalBytes=${s.loadedBytes}`);

            const itag = s.mediaHeader?.itag || s.mediaHeader?.formatId?.itag;

            let segmentDuration = 0;
            if (s.durationMs) {
                segmentDuration = Number(s.durationMs);
            } else if (s.mediaHeader?.timeRange && s.mediaHeader.timeRange.timescale > 0) {
                segmentDuration = Math.ceil((Number(s.mediaHeader.timeRange.durationTicks || 0n) / s.mediaHeader.timeRange.timescale) * 1000);
            }

            if (segmentDuration > 0) {
                this.totalDownloadedMs += segmentDuration;
                this.mediaHeadersProcessed = true;
                logger('debug', 'SABR', `Segment received: itag=${itag} seq=${s.segmentNumber} dur=${segmentDuration}ms totalDownloaded=${Math.floor(this.totalDownloadedMs)}ms`);
            }

            if (itag) {
                if (!this.downloadedSegmentsByItag.has(itag)) {
                    this.downloadedSegmentsByItag.set(itag, new Map());
                }
                const segMap = this.downloadedSegmentsByItag.get(itag);

                if (segMap.has(s.segmentNumber)) {
                    logger('warn', 'SABR', `Ignoring duplicate segment ${s.segmentNumber} for itag ${itag}`);
                } else {
                    let startMs = Number(s.mediaHeader.startMs || 0n);
                    if (startMs === 0 && s.mediaHeader.timeRange && s.mediaHeader.timeRange.timescale > 0) {
                        startMs = Number((BigInt(s.mediaHeader.timeRange.startTicks || 0n) * 1000n) / BigInt(s.mediaHeader.timeRange.timescale));
                    }
                    const endMs = startMs + segmentDuration;

                    segMap.set(s.segmentNumber, {
                        segmentNumber: s.segmentNumber,
                        durationMs: segmentDuration,
                        byteLength: s.loadedBytes || 0,
                        mediaHeader: s.mediaHeader,
                        startMs,
                        endMs
                    });

                    let maxEdge = this.cumulativeDownloadedMs || 0;
                    if (endMs > maxEdge) maxEdge = endMs;
                    this.cumulativeDownloadedMs = maxEdge;
                }
            }

            this.partialSegmentQueue.delete(id);
        }
    }

    handlePlaybackStartPolicy(part) {
        const p = this.decodePart(part, PlaybackStartPolicy);
        if (p) this.lastPlaybackStartPolicy = p;
    }

    handleRequestIdentifier(part) {
        const id = this.decodePart(part, RequestIdentifier);
        if (id) this.lastRequestIdentifier = id;
    }

    handleRequestCancellationPolicy(part) {
        const p = this.decodePart(part, RequestCancellationPolicy);
        if (p) this.lastRequestCancellationPolicy = p;
    }

    handleNextRequestPolicy(part) {
        const policy = this.decodePart(part, NextRequestPolicy);
        if (!policy) return;

        this.nextRequestPolicy = policy;

        const cookieLen = policy.playbackCookie?.length || 0;
        const backoff = policy.backoffTimeMs || 0;

        const now = Date.now();
        const changed = (this._lastPolicyBackoff !== backoff) || (this._lastPolicyCookieLen !== cookieLen);
        const shouldLog = changed || !this._lastPolicyLogAt || (now - this._lastPolicyLogAt) > 2000;

        this._lastPolicyBackoff = backoff;
        this._lastPolicyCookieLen = cookieLen;
        if (!shouldLog) return;
        this._lastPolicyLogAt = now;

        logger('debug', 'SABR', `NextRequestPolicy: backoff=${backoff}ms cookieLen=${cookieLen}`);
    }

    handleSabrContextUpdate(part) {
        const ctx = this.decodePart(part, SabrContextUpdate);
        if (ctx && ctx.type !== undefined && ctx.value?.length) {
            this.sabrContexts.set(ctx.type, ctx);
            if (ctx.sendByDefault) this.activeSabrContextTypes.add(ctx.type);
            logger('debug', 'SABR', `Received context update type=${ctx.type} len=${ctx.value?.length} sendByDefault=${ctx.sendByDefault}`);
        }
    }

    handleSabrContextSendingPolicy(part) {
        const policy = this.decodePart(part, SabrContextSendingPolicy);
        if (policy) {
            for (const type of policy.startPolicy) this.activeSabrContextTypes.add(type);
            for (const type of policy.stopPolicy) this.activeSabrContextTypes.delete(type);
            for (const type of policy.discardPolicy) this.sabrContexts.delete(type);
        }
    }

    handleSnackbarMessage(part) {}
    handleReloadPlayerResponse(part) {
        const reloadContext = this.decodePart(part, ReloadPlaybackContext);
        if (reloadContext) {
            logger('warn', 'SABR', `Reload requested by server. Reason: ${reloadContext.reason || 'unknown'}`);
            this.emit('stall');
        }
    }

    logDetailedState({ abrState, audioFormat, videoFormat, selectedFormatIds, preferredAudioFormatIds, preferredVideoFormatIds, bufferedRanges, contexts, unsent }) {
        const now = Date.now();
        if (this.lastDetailedLogAt && (now - this.lastDetailedLogAt) < 2000) return;
        this.lastDetailedLogAt = now;

        const cookieLen = this.nextRequestPolicy?.playbackCookie?.length || 0;
        const initKeys = Array.from(this.initializedFormatsMap.keys()).slice(0, 5);

        const segMap = this.downloadedSegmentsByItag.get(audioFormat?.itag);
        const segs = segMap ? Array.from(segMap.values()) : [];
        const downloadedMs = segs.reduce((sum, s) => sum + parseInt(s.durationMs || '0'), 0);
        const aheadMs = abrState?.playerTimeMs !== undefined ? (downloadedMs - abrState.playerTimeMs) : undefined;

        const fmt = (f) => f ? `${f.itag}:${f.xtags || ''}` : 'none';

        logger('debug', 'SABR',
            `State rn=${this.requestNumber} playerTimeMs=${abrState?.playerTimeMs} startTime=${this.startTime} readable=${this.readableLength}/${MAX_BUFFER_BYTES} initKeys=[${initKeys.join(',')}] downloadedMs=${downloadedMs} aheadMs=${aheadMs}`
        );

        logger('debug', 'SABR',
            `Req formats audio=${fmt(audioFormat)} video=${fmt(videoFormat)} selected=[${(selectedFormatIds || []).map(fmt).join(',')}] preferredA=[${(preferredAudioFormatIds || []).map(fmt).join(',')}] bufferedRanges=${bufferedRanges?.length || 0} ctx=${contexts?.length || 0} unsentCtx=${unsent?.length || 0} backoff=${this.nextRequestPolicy?.backoffTimeMs || 0} cookieLen=${cookieLen}`
        );

        if (bufferedRanges?.length) {
            const br = bufferedRanges[0];
            logger('debug', 'SABR', `BufferedRange[0]: itag=${br.formatId?.itag} xtags=${br.formatId?.xtags || ''} startMs=${br.startTimeMs} durMs=${br.durationMs} seg=[${br.startSegmentIndex},${br.endSegmentIndex}] ts=${br.timeRange?.timescale} durTicks=${br.timeRange?.durationTicks}`);
        }
    }

    buildBufferedRanges(vFormat, aFormat) {
        const bufferedRanges = [];
        const formats = [vFormat, aFormat].filter(f => f);

        for (const format of formats) {
            const itag = format.itag;
            const formatIdKey = createKey(itag, format.xtags);
            const headers = this.pendingRangesHeaders.get(formatIdKey);

            if (!headers || headers.length === 0) continue;

            const durationMs = headers.reduce((sum, h) => sum + parseInt(h.durationMs || '0'), 0);
            const startH = headers[0];
            const endH = headers[headers.length - 1];

            bufferedRanges.push({
                durationMs: durationMs.toString(),
                formatId: this.resolveFormatIdForRequest(format),
                startTimeMs: (startH.startMs || "0").toString(),
                startSegmentIndex: startH.sequenceNumber || 1,
                endSegmentIndex: endH.sequenceNumber || 1,
                timeRange: {
                    durationTicks: (BigInt(durationMs) * BigInt(startH.timeRange?.timescale || 1000) / 1000n).toString(),
                    startTicks: (startH.startMs || "0").toString(),
                    timescale: startH.timeRange?.timescale || 1000
                }
            });

            this.pendingRangesHeaders.set(formatIdKey, []);
        }

        return bufferedRanges;
    }

    finalizeRange(r) {

        return {
            durationMs: r.durationMs.toString(),
            formatId: r.formatId,
            startTimeMs: r.startTimeMs.toString(),
            startSegmentIndex: r.startSegmentIndex,
            endSegmentIndex: r.endSegmentIndex,
            timeRange: {
                durationTicks: (BigInt(Math.floor(r.durationMs)) * BigInt(r.timescale) / 1000n).toString(),
                startTicks: r.startTicks.toString(),
                timescale: r.timescale
            }
        };
    }

    async fetchAndProcessSegments(abrState, audioFormat, videoFormat) {
         if (!this.videoPlaybackUstreamerConfig || !this.clientInfo) throw new Error('Missing config');

         if (this.nextRequestPolicy?.backoffTimeMs > 0) {
             const backoff = this.nextRequestPolicy.backoffTimeMs;
             logger('warn', 'SABR', `Waiting for backoff: ${backoff}ms`);
             await wait(backoff, this.abortController.signal);
             this.nextRequestPolicy.backoffTimeMs = 0;
         }

         const formats = [videoFormat, audioFormat].filter(f => f);
         const formatsInitialized = this.initializedFormatsMap.size > 0;
         const requestFormatIds = formats.map((f) => this.resolveFormatIdForRequest(f)).filter((f) => f);

         const selectedFormatIds = formatsInitialized ? requestFormatIds : [];

          if (!this.cachedBufferedRanges) {
              this.cachedBufferedRanges = this.buildBufferedRanges(videoFormat, audioFormat);
          }

         const contexts = [];
         const unsent = [];

         for (const ctx of this.sabrContexts.values()) {
             if (this.activeSabrContextTypes.has(ctx.type)) {
                 contexts.push({ type: ctx.type, value: ctx.value });
             } else {
                 unsent.push(ctx.type);
             }
         }

         const preferredAudioFormatIds = audioFormat ? [this.resolveFormatIdForRequest(audioFormat)] : [];
         const preferredVideoFormatIds = videoFormat ? [this.resolveFormatIdForRequest(videoFormat)] : [];
         const bufferedRanges = this.cachedBufferedRanges || [];

         this.logDetailedState({
             abrState,
             audioFormat,
             videoFormat,
             selectedFormatIds,
             preferredAudioFormatIds,
             preferredVideoFormatIds,
             bufferedRanges,
             contexts,
             unsent
         });

         const requestBody = VideoPlaybackAbrRequest.encode({
            clientAbrState: {
                ...abrState,
                playerTimeMs: BigInt(abrState.playerTimeMs || 0).toString(),
                bandwidthEstimate: BigInt(abrState.bandwidthEstimate || 0).toString(),
                timeSinceLastActionMs: 0n
            },
            selectedFormatIds: selectedFormatIds,
            bufferedRanges,
            videoPlaybackUstreamerConfig: typeof this.videoPlaybackUstreamerConfig === 'string' ? base64ToU8(this.videoPlaybackUstreamerConfig) : this.videoPlaybackUstreamerConfig,
            preferredAudioFormatIds,
            preferredVideoFormatIds,
            streamerContext: {
                poToken: this.poToken,
                playbackCookie: this.nextRequestPolicy?.playbackCookie,
                clientInfo: this.clientInfo,
                sabrContexts: contexts,
                unsentSabrContexts: unsent
            }
        });

        const trafficReq = {
            ts: new Date().toISOString(),
            dir: 'client->yt',
            rn: this.requestNumber,
            url: this.serverAbrStreamingUrl,
            playerTimeMs: abrState?.playerTimeMs,
            requestBodyBytes: requestBody.length,
            requestBodySha256: sha256Hex(requestBody),
            requestBodyB64: this.enableTrafficDump ? b64Trunc(requestBody, this.trafficDumpMaxBytes) : undefined,
            requestBodyB64Truncated: this.enableTrafficDump ? (requestBody.length > this.trafficDumpMaxBytes) : undefined,
            preferredAudioItags: preferredAudioFormatIds.map((f) => f.itag),
            selectedItags: selectedFormatIds.map((f) => f.itag),
            bufferedRanges: bufferedRanges.map((r) => ({ itag: r.formatId?.itag, startMs: r.startTimeMs, durMs: r.durationMs, seg: [r.startSegmentIndex, r.endSegmentIndex] })),
            cookieLen: this.nextRequestPolicy?.playbackCookie?.length || 0,
            contexts: contexts.map((c) => ({ type: c.type, valueLen: c.value?.length || 0 })),
            unsentContexts: unsent
        };
        this.logTraffic(trafficReq);

        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} body=${trafficReq.requestBodyBytes}B br=${trafficReq.bufferedRanges.length} cookieLen=${trafficReq.cookieLen} sha256=${trafficReq.requestBodySha256}`);
        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} abrState(playerTimeMs=${trafficReq.playerTimeMs} enabled=${abrState?.enabledTrackTypesBitfield} visibility=${abrState?.visibility} rate=${abrState?.playbackRate}) ctx=${trafficReq.contexts.length} unsentCtx=${trafficReq.unsentContexts.length}`);

        const reqPreviewB64 = b64Trunc(requestBody, 1024);
        logger('debug', 'SABR', `Traffic -> rn=${trafficReq.rn} bodyB64[1024B]=${reqPreviewB64.length > 260 ? (reqPreviewB64.slice(0, 260) + '...') : reqPreviewB64} (full in sabr_traffic.jsonl)`);

        const rn = this.requestNumber;
        const url = new URL(this.serverAbrStreamingUrl);
        url.searchParams.set('rn', rn.toString());
        this.requestNumber++;

        const headers = {
            'content-type': 'application/x-protobuf',
            'accept': 'application/vnd.yt-ump',
            'x-goog-visitor-id': this.visitorData || "",
            'x-youtube-client-name': String(this.clientInfo?.clientName || '1'),
            'x-youtube-client-version': this.clientInfo?.clientVersion || "",
            'origin': 'https://www.youtube.com',
            'referer': `https://www.youtube.com/watch?v=${this.videoId}`,
            'user-agent': this.userAgent
        };

        if (this.config.accessToken) {
            headers['Authorization'] = `Bearer ${this.config.accessToken}`;
        }

        const t0 = Date.now();
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body: requestBody,
            signal: this.abortController.signal
        });

        if (!res.ok) {
            let errorText = '';
            try {
                errorText = await res.text();
            } catch (e) {
                errorText = '(Failed to read response body)';
            }

            this.logTraffic({
                ts: new Date().toISOString(),
                dir: 'yt->client',
                rn,
                status: res.status,
                ok: false,
                statusText: res.statusText,
                url: url.toString(),
                durationMs: Date.now() - t0,
                responseBytes: (errorText || '').length,
                errorText: errorText.slice(0, 2000)
            });

            logger('error', 'SABR', `Fetch failed: ${res.status} ${res.statusText}`);
            logger('error', 'SABR', `URL: ${url.toString()}`);
            logger('error', 'SABR', `Response Body: ${errorText}`);
            throw new Error(`HTTP ${res.status}: ${errorText}`);
        }

        const signal = this.abortController.signal;

        if (!res.body) throw new Error('Missing response body');
        const reader = res.body.getReader();
        let buffer = new CompositeBuffer();
        const ump = new UmpReader(buffer);
        let responseBytes = 0;
        const responseHash = createHash('sha256');
        const responseDumpChunks = [];
        let responseDumpBytes = 0;

        const partCounts = Object.create(null);
        const partSeq = [];
        const partDumps = [];
        const saw = {
            media: false,
            mediaHeader: false,
            mediaEnd: false,
            nextRequestPolicy: false,
            playbackStartPolicy: false,
            requestIdentifier: false,
            requestCancellationPolicy: false,
            sabrError: false,
            sabrRedirect: false,
            sabrContextUpdate: false,
            streamProtectionStatus: false
        };

        this.mediaHeadersProcessed = false;

        let activePartial = null;

        try {
            while (!this._aborted && !this.destroyed) {
                const { done, value } = await reader.read();
                if (done) break;

                responseBytes += value.length;
                responseHash.update(value);

                if (this.enableTrafficDump && this.trafficDumpMaxBytes > 0 && responseDumpBytes < this.trafficDumpMaxBytes) {
                    const take = Math.min(value.length, this.trafficDumpMaxBytes - responseDumpBytes);
                    if (take > 0) {
                        responseDumpChunks.push(value.subarray(0, take));
                        responseDumpBytes += take;
                    }
                }

                buffer.append(value);
                ump.compositeBuffer = buffer;

                const incomplete = ump.read((part) => {
                    if (this._aborted) return;

                    let handled = false;
                    if (part.type === UMPPartId.MEDIA && activePartial && activePartial.type === UMPPartId.MEDIA) {
                         const alreadyPushed = activePartial.processedBytes;
                         const remainder = part.data.split(alreadyPushed).remainingBuffer;

                         const headerId = activePartial.id ?? (part.data.getLength() > 0 ? part.data.getUint8(0) : 0);
                         const isFirst = alreadyPushed === 0;

                         this.handleMediaPartial(remainder, headerId, isFirst);
                         handled = true;
                         activePartial = null;
                    }

                    if (activePartial) activePartial = null;

                    partCounts[part.type] = (partCounts[part.type] || 0) + 1;
                    partSeq.push({ type: part.type, name: umpPartName(part.type), size: part.size });

                    if (part.type === UMPPartId.MEDIA) saw.media = true;
                    else if (part.type === UMPPartId.MEDIA_HEADER) saw.mediaHeader = true;
                    else if (part.type === UMPPartId.MEDIA_END) saw.mediaEnd = true;
                    else if (part.type === UMPPartId.NEXT_REQUEST_POLICY) saw.nextRequestPolicy = true;
                    else if (part.type === UMPPartId.PLAYBACK_START_POLICY) saw.playbackStartPolicy = true;
                    else if (part.type === UMPPartId.REQUEST_IDENTIFIER) saw.requestIdentifier = true;
                    else if (part.type === UMPPartId.REQUEST_CANCELLATION_POLICY) saw.requestCancellationPolicy = true;
                    else if (part.type === UMPPartId.SABR_ERROR) saw.sabrError = true;
                    else if (part.type === UMPPartId.SABR_REDIRECT) saw.sabrRedirect = true;
                    else if (part.type === UMPPartId.SABR_CONTEXT_UPDATE) saw.sabrContextUpdate = true;
                    else if (part.type === UMPPartId.STREAM_PROTECTION_STATUS) saw.streamProtectionStatus = true;

                    if (this.enableTrafficDump && this.trafficDumpMaxBytes > 0) {
                        const shouldDumpPayload = (part.type !== UMPPartId.MEDIA) && (part.type !== UMPPartId.MEDIA_HEADER) && (part.type !== UMPPartId.MEDIA_END);
                        if (shouldDumpPayload && part.size <= this.trafficDumpMaxBytes) {
                            try {
                                const payload = concatenateChunks(part.data.chunks);
                                let decoded;
                                try {
                                    if (part.type === UMPPartId.PLAYBACK_START_POLICY) decoded = PlaybackStartPolicy.decode(new ProtoReader(payload), payload.length);
                                    else if (part.type === UMPPartId.REQUEST_IDENTIFIER) decoded = RequestIdentifier.decode(new ProtoReader(payload), payload.length);
                                    else if (part.type === UMPPartId.REQUEST_CANCELLATION_POLICY) decoded = RequestCancellationPolicy.decode(new ProtoReader(payload), payload.length);
                                } catch {}

                                partDumps.push({
                                    type: part.type,
                                    name: umpPartName(part.type),
                                    size: part.size,
                                    sha256: sha256Hex(payload),
                                    payloadB64: b64Trunc(payload, this.trafficDumpMaxBytes),
                                    payloadB64Truncated: payload.length > this.trafficDumpMaxBytes,
                                    decoded
                                });
                            } catch {}
                        }
                    }

                    if (!handled) {
                        const handler = this.umpPartHandlers.get(part.type);
                        if (handler) handler(part);
                    }
                });

                if (ump.compositeBuffer) {
                    if (activePartial) {
                         // Logic for maintaining partial state between reads
                    }
                     // The incomplete flag was true, so we check what's left
                   const res = incomplete;
                   if (res && res.incomplete) {
                    if (!activePartial) {
                        activePartial = {
                            type: res.type,
                            totalSize: res.size,
                            headerSize: res.headerSize,
                            processedBytes: 0,
                            id: undefined
                        };
                    }

                    if (res.type === UMPPartId.MEDIA) {
                        const available = res.data.getLength();
                        const newBytesCount = available - activePartial.processedBytes;

                        if (newBytesCount > 0) {
                             const split = res.data.split(activePartial.processedBytes);
                             const newChunk = split.remainingBuffer;

                             let headerId = activePartial.id;

                             if (activePartial.processedBytes === 0 && newChunk.getLength() >= 1) {
                                 headerId = newChunk.getUint8(0);
                                 activePartial.id = headerId;
                             }

                             if (headerId !== undefined) {
                                 const isFirst = (activePartial.processedBytes === 0);
                                 this.handleMediaPartial(newChunk, headerId, isFirst);
                             }

                             activePartial.processedBytes += newBytesCount;
                        }
                    }
                }
                }

                buffer = ump.compositeBuffer;
            }
        } catch (err) {
            // AbortError (or equivalent) during destroy/abort should not crash the stream.
            if (!(this._aborted || this.destroyed || signal.aborted)) throw err;
        } finally {
            try { await reader.cancel(); } catch {}
            try { reader.releaseLock(); } catch {}
        }


        const responseDump = this.enableTrafficDump && responseDumpChunks.length
            ? concatenateChunks(responseDumpChunks)
            : undefined;

        const trafficRes = {
            ts: new Date().toISOString(),
            dir: 'yt->client',
            rn,
            status: res.status,
            ok: true,
            url: url.toString(),
            durationMs: Date.now() - t0,
            responseBytes,
            responseSha256: responseHash.digest('hex'),
            responseBodyB64: responseDump ? Buffer.from(responseDump).toString('base64') : undefined,
            responseBodyB64Truncated: this.enableTrafficDump ? (responseBytes > this.trafficDumpMaxBytes) : undefined,
            contentType: res.headers.get('content-type') || '',
            contentLength: res.headers.get('content-length') || '',
            parts: partCounts,
            partSeq,
            partDumps: partDumps.length ? partDumps : undefined,
            saw,
            policy: {
                backoffTimeMs: this.nextRequestPolicy?.backoffTimeMs || 0,
                cookieLen: this.nextRequestPolicy?.playbackCookie?.length || 0,
                targetAudioReadaheadMs: this.nextRequestPolicy?.targetAudioReadaheadMs,
                minAudioReadaheadMs: this.nextRequestPolicy?.minAudioReadaheadMs,
                maxTimeSinceLastRequestMs: this.nextRequestPolicy?.maxTimeSinceLastRequestMs
            }
        };

        this.logTraffic(trafficRes);
        logger('debug', 'SABR', `Traffic <- rn=${rn} status=${res.status} bytes=${responseBytes} parts=${Object.keys(partCounts).length} hasMedia=${saw.media} backoff=${trafficRes.policy.backoffTimeMs} cookieLen=${trafficRes.policy.cookieLen}`);

        if (saw.media) {
            this.mediaHeadersProcessed = true;
            this.cachedBufferedRanges = undefined;
            this.noMediaStreak = 0;
        } else if (trafficRes.policy.backoffTimeMs > 0) {
            this.noMediaStreak++;
            this.cachedBufferedRanges = undefined;

            if (this.noMediaStreak >= 12) {
                logger('warn', 'SABR', `Stall detected (noMediaStreak=${this.noMediaStreak}). Signaling for re-resolution.`);
                this.emit('stall');
                this.noMediaStreak = 0;
            }
        }
    }
}
