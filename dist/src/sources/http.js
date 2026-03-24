import { PassThrough, Transform } from 'node:stream';
import { encodeTrack, getVersion, http1makeRequest, logger } from "../utils.js";
/**
 * Default user agent for HTTP source requests.
 * @internal
 */
const DEFAULT_HTTP_USER_AGENT = `NodeLink/${getVersion()} (https://github.com/PerformanC/NodeLink)`;
/**
 * Extracts file extension from URL.
 * @param rawUrl - Input URL.
 * @returns Lowercased extension without dot.
 * @internal
 */
const extractUrlExtension = (rawUrl) => {
    const sanitized = String(rawUrl || '')
        .split('?')[0]
        ?.split('#')[0] || '';
    const lastSlash = sanitized.lastIndexOf('/');
    const lastDot = sanitized.lastIndexOf('.');
    if (lastDot === -1 || lastDot < lastSlash)
        return '';
    return sanitized.slice(lastDot + 1).toLowerCase();
};
/**
 * Normalizes header value from unknown/object/string[] to string.
 * @param value - Header value.
 * @returns Header string.
 * @internal
 */
const headerToString = (value) => Array.isArray(value) ? String(value[0] || '') : String(value || '');
/**
 * Transform stream that strips ICY metadata blocks and emits parsed metadata.
 * @internal
 */
class IcyMetadataTransform extends Transform {
    metaInt;
    onMetadata;
    audioBytesRemaining;
    pendingMetaLength;
    metaChunks;
    metaBytes;
    lastSignature;
    /**
     * Creates a new ICY metadata transform.
     * @param metaInt - Metadata interval in bytes.
     * @param onMetadata - Metadata callback.
     */
    constructor(metaInt, onMetadata) {
        super();
        this.metaInt = metaInt;
        this.onMetadata = onMetadata;
        this.audioBytesRemaining = metaInt;
        this.pendingMetaLength = null;
        this.metaChunks = [];
        this.metaBytes = 0;
        this.lastSignature = null;
    }
    /**
     * Emits parsed metadata payload if content changed.
     * @param raw - Raw metadata block.
     * @internal
     */
    _emitMetadata(raw) {
        const cleaned = raw.replace(/\0+$/, '').trim();
        if (!cleaned)
            return;
        const fields = {};
        const regex = /([A-Za-z0-9]+)='([^']*)'/g;
        for (const match of cleaned.matchAll(regex)) {
            fields[(match[1] || '').toLowerCase()] = match[2] || '';
        }
        const payload = {
            raw: cleaned,
            streamTitle: fields.streamtitle || null,
            streamUrl: fields.streamurl || null,
            fields
        };
        const signature = payload.raw;
        if (signature && signature !== this.lastSignature) {
            this.lastSignature = signature;
            this.onMetadata?.(payload);
        }
    }
    /**
     * Processes audio and metadata chunks.
     * @param chunk - Incoming stream chunk.
     * @param _encoding - Stream encoding.
     * @param callback - Transform callback.
     * @internal
     */
    _transform(chunk, _encoding, callback) {
        try {
            let offset = 0;
            while (offset < chunk.length) {
                if (this.pendingMetaLength === null) {
                    const remaining = chunk.length - offset;
                    const toCopy = Math.min(this.audioBytesRemaining, remaining);
                    if (toCopy > 0) {
                        this.push(chunk.subarray(offset, offset + toCopy));
                        this.audioBytesRemaining -= toCopy;
                        offset += toCopy;
                    }
                    if (this.audioBytesRemaining === 0) {
                        this.pendingMetaLength = -1;
                    }
                }
                else if (this.pendingMetaLength === -1) {
                    if (offset >= chunk.length)
                        break;
                    this.pendingMetaLength = (chunk[offset] || 0) * 16;
                    offset += 1;
                    this.metaChunks = [];
                    this.metaBytes = 0;
                    if (this.pendingMetaLength === 0) {
                        this.audioBytesRemaining = this.metaInt;
                        this.pendingMetaLength = null;
                    }
                }
                else {
                    const remaining = chunk.length - offset;
                    const needed = this.pendingMetaLength - this.metaBytes;
                    const toCopy = Math.min(needed, remaining);
                    if (toCopy > 0) {
                        this.metaChunks.push(chunk.subarray(offset, offset + toCopy));
                        this.metaBytes += toCopy;
                        offset += toCopy;
                    }
                    if (this.metaBytes >= this.pendingMetaLength) {
                        const raw = Buffer.concat(this.metaChunks, this.pendingMetaLength).toString('utf8');
                        this._emitMetadata(raw);
                        this.audioBytesRemaining = this.metaInt;
                        this.pendingMetaLength = null;
                    }
                }
            }
            callback();
        }
        catch (err) {
            callback(err);
        }
    }
}
/**
 * Generic HTTP source.
 * @public
 */
export default class HttpSource {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Source-specific configuration.
     */
    config;
    /**
     * Source search term prefixes.
     */
    searchTerms;
    /**
     * Source priority.
     */
    priority;
    /**
     * Creates a new HTTP source instance.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const rawHttpConfig = nodelink.options.sources?.http;
        this.config =
            rawHttpConfig &&
                typeof rawHttpConfig === 'object' &&
                'userAgent' in rawHttpConfig &&
                typeof rawHttpConfig.userAgent === 'string'
                ? { userAgent: rawHttpConfig.userAgent }
                : {};
        this.searchTerms = [];
        this.priority = 10;
    }
    /**
     * Initializes provider resources.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Search handler delegates to resolve for HTTP source.
     * @param query - URL query.
     * @returns Resolve result.
     */
    async search(query) {
        return this.resolve(query);
    }
    /**
     * Resolves an HTTP URL into track payload.
     * @param url - Target URL.
     * @returns Resolve result payload.
     */
    async resolve(url) {
        try {
            const userAgent = this.config.userAgent || DEFAULT_HTTP_USER_AGENT;
            const requestHeaders = { 'User-Agent': userAgent };
            const validAudioPrefixes = ['audio/', 'video/'];
            const validApplicationTypes = ['application/octet-stream'];
            const isValidMediaType = (contentType) => validAudioPrefixes.some((prefix) => contentType.startsWith(prefix)) ||
                validApplicationTypes.includes(contentType) ||
                contentType === '';
            let data = await http1makeRequest(url, {
                method: 'HEAD',
                headers: requestHeaders
            });
            const headContentType = headerToString(data.headers?.['content-type']);
            const headOk = !data.error &&
                (data.statusCode || 0) < 400 &&
                isValidMediaType(headContentType);
            if (!headOk) {
                const getData = await http1makeRequest(url, {
                    method: 'GET',
                    streamOnly: true,
                    headers: requestHeaders
                });
                const previewStream = getData?.stream;
                if (previewStream && typeof previewStream.destroy === 'function') {
                    previewStream.destroy();
                }
                data = getData;
            }
            if (data.error) {
                return {
                    exception: { message: String(data.error), severity: 'common' }
                };
            }
            if ((data.statusCode || 0) >= 400) {
                return {
                    exception: {
                        message: `HTTP error ${data.statusCode} while resolving`,
                        severity: 'common'
                    }
                };
            }
            const headers = data.headers;
            const contentType = headerToString(headers?.['content-type']);
            if (!isValidMediaType(contentType)) {
                return {
                    exception: {
                        message: `Unsupported content type: ${contentType}`,
                        severity: 'common'
                    }
                };
            }
            const hasContentLength = 'content-length' in (headers || {});
            const isStream = Boolean(headers?.['icy-metaint']) ||
                !hasContentLength;
            return {
                loadType: 'track',
                data: this.buildTrack(url, headers, isStream)
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                exception: {
                    message: `Failed to resolve URL: ${message}`,
                    severity: 'common'
                }
            };
        }
    }
    /**
     * Builds track payload for resolved URL and headers.
     * @param url - Source URL.
     * @param headers - Response headers.
     * @param isStream - Whether source is stream.
     * @returns Resolved track payload.
     * @internal
     */
    buildTrack(url, headers, isStream) {
        const headerRecord = (headers || {});
        const contentDisposition = headerToString(headerRecord['content-disposition']);
        const fileNameMatch = contentDisposition.match(/filename="([^"]+)"/i);
        const title = headerToString(headerRecord['icy-name']) ||
            fileNameMatch?.[1] ||
            'Unknown';
        const description = headerToString(headerRecord['icy-description']);
        const genre = headerToString(headerRecord['icy-genre']);
        const stationUrl = headerToString(headerRecord['icy-url']) || url;
        const icyBr = headerToString(headerRecord['icy-br']);
        const audioInfo = headerToString(headerRecord['ice-audio-info']);
        const bitrate = Number.parseInt(icyBr || audioInfo.split(';')?.[0]?.split('=')?.[1] || '0', 10);
        let artworkUrl = null;
        const contentType = headerToString(headerRecord['content-type']);
        if (url.startsWith('https://cdn.discordapp.com') &&
            contentType.includes('video/')) {
            const cleanedUrl = url.endsWith('&') ? url.slice(0, -1) : url;
            const base = cleanedUrl.replace('https://cdn.discordapp.com', 'https://media.discordapp.net');
            const separator = base.includes('?') ? '&' : '?';
            artworkUrl = `${base}${separator}format=webp`;
        }
        const track = {
            identifier: url,
            isSeekable: !isStream,
            author: description || 'unknown',
            length: -1,
            isStream,
            position: 0,
            title,
            uri: url,
            artworkUrl: null,
            isrc: null,
            sourceName: 'http'
        };
        const encodedTrack = { ...track, details: [] };
        return {
            encoded: encodeTrack(encodedTrack),
            info: track,
            pluginInfo: {
                bitrate,
                genre,
                stationUrl,
                artworkUrl,
                icyBr,
                audioInfo
            }
        };
    }
    /**
     * Returns playable URL for HTTP tracks.
     * @param info - Track info payload.
     * @returns URL and protocol tuple.
     */
    getTrackUrl(info) {
        return { url: info.uri, protocol: 'http' };
    }
    /**
     * Loads stream for HTTP track.
     * @param _decodedTrack - Decoded track payload (unused).
     * @param url - Stream URL.
     * @returns Stream payload or exception.
     */
    async loadStream(_decodedTrack, url) {
        try {
            const userAgent = this.config.userAgent || DEFAULT_HTTP_USER_AGENT;
            const opts = {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'Icy-MetaData': '1',
                    'User-Agent': userAgent
                }
            };
            const response = await http1makeRequest(url, opts);
            if (response.error)
                throw new Error(String(response.error));
            const headers = (response.headers || {});
            const contentType = headerToString(headers['content-type']);
            const extensionType = !contentType || contentType === 'application/octet-stream'
                ? extractUrlExtension(url)
                : '';
            const resolvedType = extensionType || contentType;
            const httpStream = response.stream;
            if (!httpStream) {
                throw new Error('No stream returned from HTTP source');
            }
            let outputStream = httpStream;
            const metaInt = Number.parseInt(headerToString(headers['icy-metaint']), 10);
            if (Number.isFinite(metaInt) && metaInt > 0) {
                const icyHeaders = {
                    name: headerToString(headers['icy-name']) || null,
                    description: headerToString(headers['icy-description']) || null,
                    genre: headerToString(headers['icy-genre']) || null,
                    url: headerToString(headers['icy-url']) || null,
                    bitrate: headerToString(headers['icy-br']) || null
                };
                const metadataStream = new IcyMetadataTransform(metaInt, (metadata) => {
                    outputStream.emit('icyMetadata', {
                        metadata,
                        icy: icyHeaders,
                        receivedAt: Date.now()
                    });
                });
                httpStream.pipe(metadataStream);
                outputStream = metadataStream;
            }
            const finalStream = outputStream.pipe(new PassThrough());
            finalStream.on('end', () => {
                logger('debug', 'HTTP Source', `Stream ended for ${url}, emitting finishBuffering.`);
                finalStream.emit('finishBuffering');
            });
            finalStream.on('error', (err) => {
                logger('error', 'HTTP Source', `Stream error: ${err.message}`);
            });
            return { stream: finalStream, type: resolvedType };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger('error', 'Sources', `Failed to load http stream: ${message}`);
            return { exception: { message, severity: 'common' } };
        }
    }
}
