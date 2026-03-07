import fs from 'node:fs';
import path from 'node:path';
import { encodeTrack, logger } from "../utils.js";
const EXTENSION_TYPE_MAP = Object.freeze({
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    m4a: 'm4a',
    mp4: 'mp4',
    mov: 'mov',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    webm: 'webm',
    weba: 'weba',
    flv: 'flv'
});
function mapExtensionToType(ext) {
    return EXTENSION_TYPE_MAP[ext] || 'arbitrary';
}
function readMagicBytes(filePath, size = 4096) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(size);
        const bytesRead = fs.readSync(fd, header, 0, size, 0);
        return header.subarray(0, bytesRead);
    }
    finally {
        fs.closeSync(fd);
    }
}
function detectTypeByMagic(header) {
    if (!header || header.length < 4)
        return null;
    if (header.subarray(0, 4).toString('[ascii') === 'fLaC')
        return 'audio/flac';
    if (header.subarray(0, 4).toString('ascii') === 'OggS') {
        return header.includes(Buffer.from('OpusHead')) ? 'audio/opus' : 'audio/ogg';
    }
    if (header.length >= 12 &&
        header.subarray(0, 4).toString('ascii') === 'RIFF' &&
        header.subarray(8, 12).toString('ascii') === 'WAVE') {
        return 'audio/wav';
    }
    if (header.subarray(0, 3).toString('ascii') === 'ID3')
        return 'audio/mpeg';
    if ((header[0] === 0xff && (header[1] & 0xe0) === 0xe0) ||
        parseMP3Header(header)) {
        return 'audio/mpeg';
    }
    if (header[0] === 0xff && (header[1] & 0xf6) === 0xf0)
        return 'audio/aac';
    if (header.length >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
        return 'm4a';
    }
    if (header[0] === 0x1a &&
        header[1] === 0x45 &&
        header[2] === 0xdf &&
        header[3] === 0xa3) {
        return 'webm';
    }
    if (header.subarray(0, 3).toString('ascii') === 'FLV')
        return 'flv';
    return null;
}
function detectLocalAudioType(filePath, ext = '') {
    try {
        const header = readMagicBytes(filePath);
        const detected = detectTypeByMagic(header);
        if (detected)
            return detected;
    }
    catch (err) {
        logger('warn', 'Sources', `Could not read magic bytes for "${filePath}": ${err.message}`);
    }
    return mapExtensionToType(ext);
}
function parseMP3Header(buffer) {
    //biome-ignore lint: declare-variable-separate
    const b1 = buffer[0], b2 = buffer[1], b3 = buffer[2];
    if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0)
        return null;
    const versionBits = (b2 & 0x18) >> 3;
    const bitrateIndex = (b3 & 0xf0) >> 4;
    if (bitrateIndex < 1 || bitrateIndex > 14)
        return null;
    const versions = ['2.5', 'x', '2', '1'];
    const version = versions[versionBits] || 'unknown';
    const table = {
        1: [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        2: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        2.5: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    return { bitrateKbps: table[version]?.[bitrateIndex] || null };
}
function detectID3v2Size(fd) {
    const header = Buffer.alloc(10);
    fs.readSync(fd, header, 0, 10, 0);
    if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
        const size = ((header[6] & 0x7f) << 21) |
            ((header[7] & 0x7f) << 14) |
            ((header[8] & 0x7f) << 7) |
            (header[9] & 0x7f);
        return size + 10;
    }
    return 0;
}
function readFileInfo(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const stats = fs.statSync(filePath);
    const info = {
        fileType: ext,
        streamType: detectLocalAudioType(filePath, ext),
        bitrateKbps: 'unknown',
        durationMs: -1
    };
    if (ext === 'mp3') {
        const fd = fs.openSync(filePath, 'r');
        const skip = detectID3v2Size(fd);
        const buf = Buffer.alloc(4096);
        fs.readSync(fd, buf, 0, buf.length, skip);
        fs.closeSync(fd);
        const header = parseMP3Header(buf);
        info.bitrateKbps = header?.bitrateKbps || 'unknown';
        const bps = (typeof info.bitrateKbps === 'number' ? info.bitrateKbps : 128) * 1000;
        info.durationMs = bps ? Math.floor(((stats.size * 8) / bps) * 1000) : 0;
    }
    return info;
}
export default class LocalSource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.searchTerms = [];
        this.priority = 20;
    }
    async setup() {
        return true;
    }
    async search(query) {
        const isAbsolute = path.isAbsolute(query);
        const basePath = path.resolve(this.nodelink.options.sources.local.basePath || './');
        const filePath = isAbsolute
            ? path.resolve(query)
            : path.resolve(basePath, query);
        logger('debug', 'Sources', `Searching local file: ${filePath}`);
        if (!isAbsolute && !filePath.startsWith(basePath)) {
            logger('warn', 'Sources', `Path traversal attempt blocked for local source: "${query}"`);
            return {
                exception: {
                    message: 'Path traversal is not allowed.',
                    severity: 'common'
                }
            };
        }
        try {
            await fs.promises.access(filePath, fs.constants.R_OK);
            const meta = readFileInfo(filePath);
            const track = this.buildTrack(filePath, meta);
            logger('debug', 'Sources', `Local track found: ${track.info.title} [${meta.fileType}]`);
            return { loadType: 'track', data: track };
        }
        catch (err) {
            logger('warn', 'Sources', `Local file not found or unreadable: ${filePath} — ${err.message}`);
            return { loadType: 'empty', data: {} };
        }
    }
    async resolve(file) {
        return this.search(file);
    }
    buildTrack(filePath, meta) {
        const info = {
            identifier: filePath,
            isSeekable: meta.durationMs > 0,
            author: 'unknown',
            length: meta.durationMs,
            isStream: false,
            position: 0,
            title: path.basename(filePath),
            uri: filePath,
            artworkUrl: meta.artwork || null,
            sourceName: 'local'
        };
        return { encoded: encodeTrack(info), info, pluginInfo: meta };
    }
    getTrackUrl(track) {
        const ext = path.extname(track.uri || '').slice(1).toLowerCase();
        const streamType = track?.pluginInfo?.streamType || detectLocalAudioType(track.uri, ext);
        return {
            url: track.uri,
            protocol: 'local',
            format: streamType,
            additionalData: null
        };
    }
    async loadStream(decoded, _url, _protocol, additional) {
        const ext = path.extname(decoded.uri || '').slice(1).toLowerCase();
        const streamType = decoded?.pluginInfo?.streamType || detectLocalAudioType(decoded.uri, ext);
        if (additional?.startTime && decoded.isSeekable) {
            const info = readFileInfo(decoded.uri);
            const bps = (typeof info.bitrateKbps === 'number' ? info.bitrateKbps : 128) * 1000;
            const offset = info.durationMs > 0
                ? Math.floor((bps * (additional.startTime ?? 0)) / 8000)
                : 0;
            const stream = fs.createReadStream(decoded.uri, {
                start: offset
            });
            stream.once('close', () => stream.emit('finishBuffering'));
            return { stream, type: streamType };
        }
        const stream = fs.createReadStream(decoded.uri);
        stream.once('close', () => stream.emit('finishBuffering'));
        stream.on('error', (err) => logger('error', 'Sources', `Local stream error: ${err.message}`));
        return { stream, type: streamType };
    }
}
