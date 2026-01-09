import { Buffer } from 'node:buffer'

export class ProtoWriter {
    constructor() { this.chunks = []; }
    writeVarint(value) {
        let v = BigInt(value);
        while (v > 127n) { this.chunks.push((Number(v & 127n) | 128)); v >>= 7n; }
        this.chunks.push(Number(v));
    }
    writeTag(fieldNumber, wireType) { this.writeVarint((fieldNumber << 3) | wireType); }
    writeString(fieldNumber, str) {
        if (str === undefined || str === null || str === "") return;
        const buf = Buffer.from(str, 'utf8');
        this.writeTag(fieldNumber, 2);
        this.writeVarint(buf.length);
        this.chunks.push(buf);
    }
    writeBytes(fieldNumber, buffer) {
        if (buffer === undefined || buffer === null || buffer.length === 0) return;
        if (typeof buffer === 'string') {
            try {
                buffer = base64ToU8(buffer);
            } catch (e) {
                buffer = Buffer.from(buffer, 'utf8');
            }
        }
        this.writeTag(fieldNumber, 2);
        this.writeVarint(buffer.length);
        this.chunks.push(buffer);
    }
    writeInt32(fieldNumber, value) {
        if (value === undefined || value === null) return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(value);
    }
    writeInt64(fieldNumber, value) {
        if (value === undefined || value === null) return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(value);
    }
    writeBool(fieldNumber, value) {
        if (value === undefined || value === null || value === false) return;
        this.writeTag(fieldNumber, 0);
        this.writeVarint(1);
    }
    writeFloat(fieldNumber, value) {
        if (value === undefined || value === null || value === 0) return;
        this.writeTag(fieldNumber, 5);
        const buf = Buffer.alloc(4);
        buf.writeFloatLE(value);
        this.chunks.push(buf);
    }
    writeMessage(fieldNumber, writer) {
        const buf = writer.finish();
        if (buf.length === 0) return;
        this.writeTag(fieldNumber, 2);
        this.writeVarint(buf.length);
        this.chunks.push(buf);
    }
    finish() {
        const totalLen = this.chunks.reduce((acc, c) => acc + (typeof c === 'number' ? 1 : c.length), 0);
        const buf = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of this.chunks) {
            if (typeof c === 'number') buf[offset++] = c;
            else { buf.set(c, offset); offset += c.length; }
        }
        return buf;
    }
}

export class ProtoReader {
    constructor(buffer) { this.buffer = buffer; this.pos = 0; }
    readVarint() {
        let result = 0n, shift = 0n;
        while (true) {
            if (this.pos >= this.buffer.length) return result; 
            const b = this.buffer[this.pos++];
            result |= BigInt(b & 0x7F) << shift;
            shift += 7n;
            if ((b & 0x80) === 0) break;
        }
        return result;
    }
    readString() {
        const v = this.readVarint();
        const len = Number(v);
        if (this.pos + len > this.buffer.length) return "";
        const str = new TextDecoder().decode(this.buffer.subarray(this.pos, this.pos + len));
        this.pos += len;
        return str;
    }
    readBytes() {
        const len = Number(this.readVarint());
        if (this.pos + len > this.buffer.length) return new Uint8Array(0);
        const bytes = this.buffer.subarray(this.pos, this.pos + len);
        this.pos += len;
        return bytes;
    }
    skip(wireType) {
        if (this.pos >= this.buffer.length) return;
        switch (wireType) {
            case 0: this.readVarint(); break;
            case 1: this.pos = Math.min(this.pos + 8, this.buffer.length); break;
            case 2:
                const len = Number(this.readVarint());
                this.pos = Math.min(this.pos + len, this.buffer.length);
                break;
            case 5: this.pos = Math.min(this.pos + 4, this.buffer.length); break;
        }
    }
}

export const FormatId = {
    encode(msg, writer) {
        writer.writeInt32(1, msg.itag);
        writer.writeInt64(2, msg.lastModified || msg.last_modified || 0);
        writer.writeString(3, msg.xtags);
    },
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while(reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.itag = Number(reader.readVarint());
            else if (field === 2) msg.lastModified = reader.readVarint().toString();
            else if (field === 3) msg.xtags = reader.readString();
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const ClientAbrState = {
    encode(msg, writer) {
        writer.writeInt64(28, msg.playerTimeMs);
        writer.writeInt32(40, msg.enabledTrackTypesBitfield);
        writer.writeString(69, msg.audioTrackId);
        writer.writeInt32(21, msg.stickyResolution);
        writer.writeBool(46, msg.drcEnabled);
        writer.writeInt32(34, msg.visibility);
        writer.writeFloat(35, msg.playbackRate || 1.0);
        writer.writeBool(22, msg.clientViewportIsFlexible);
        writer.writeInt32(16, msg.lastManualSelectedResolution);
    }
};

export const ClientInfo = {
    encode(msg, writer) {
        writer.writeInt32(16, msg.clientName);
        writer.writeString(17, msg.clientVersion);
    }
};

export const VideoPlaybackAbrRequest = {
    encode(msg) {
        const writer = new ProtoWriter();
        if (msg.clientAbrState) {
            const w = new ProtoWriter();
            ClientAbrState.encode(msg.clientAbrState, w);
            writer.writeMessage(1, w);
        }
        if (msg.selectedFormatIds) {
            for (const f of msg.selectedFormatIds) {
                const w = new ProtoWriter();
                FormatId.encode(f, w);
                writer.writeMessage(2, w);
            }
        }
        if (msg.bufferedRanges) {
            for (const r of msg.bufferedRanges) {
                const w = new ProtoWriter();
                BufferedRange.encode(r, w);
                writer.writeMessage(3, w);
            }
        }
        // Field 4 (playerTimeMs) is not sent by googlevideo's SABR implementation; keep timing only in clientAbrState.
        writer.writeBytes(5, msg.videoPlaybackUstreamerConfig);
        if (msg.preferredAudioFormatIds) {
            for (const f of msg.preferredAudioFormatIds) {
                const w = new ProtoWriter();
                FormatId.encode(f, w);
                writer.writeMessage(16, w);
            }
        }
        if (msg.preferredVideoFormatIds) {
            for (const f of msg.preferredVideoFormatIds) {
                const w = new ProtoWriter();
                FormatId.encode(f, w);
                writer.writeMessage(17, w);
            }
        }
        if (msg.streamerContext) {
            const w = new ProtoWriter();
            StreamerContext.encode(msg.streamerContext, w);
            writer.writeMessage(19, w);
        }
        return writer.finish();
    }
};

export const TimeRange = {
    encode(msg, writer) {
        writer.writeInt64(1, msg.startTicks || 0);
        writer.writeInt64(2, msg.durationTicks || 0);
        writer.writeInt32(3, msg.timescale || 0);
    },
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = { startTicks: "0", durationTicks: "0", timescale: 0 };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.startTicks = reader.readVarint().toString();
            else if (field === 2) msg.durationTicks = reader.readVarint().toString();
            else if (field === 3) msg.timescale = Number(reader.readVarint());
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const BufferedRange = {
    encode(msg, writer) {
        if (msg.formatId) {
            const w = new ProtoWriter();
            FormatId.encode(msg.formatId, w);
            writer.writeMessage(1, w);
        }
        writer.writeInt64(2, msg.startTimeMs || 0);
        writer.writeInt64(3, msg.durationMs || 0);
        writer.writeInt32(4, msg.startSegmentIndex || 0);
        writer.writeInt32(5, msg.endSegmentIndex || 0);
        if (msg.timeRange) {
            const w = new ProtoWriter();
            TimeRange.encode(msg.timeRange, w);
            writer.writeMessage(6, w);
        }
    }
};

export const MediaHeader = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = { itag: 0, sequenceNumber: 0, isInitSeg: false, durationMs: "0", startMs: "0" };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.headerId = Number(reader.readVarint());
            else if (field === 3) msg.itag = Number(reader.readVarint());
            else if (field === 5) msg.xtags = reader.readString();
            else if (field === 8) msg.isInitSeg = Boolean(reader.readVarint());
            else if (field === 9) msg.sequenceNumber = Number(reader.readVarint());
            else if (field === 11) msg.startMs = reader.readVarint().toString();
            else if (field === 12) msg.durationMs = reader.readVarint().toString();
            else if (field === 13) {
                msg.formatId = FormatId.decode(reader, Number(reader.readVarint()));
                msg.itag = msg.formatId.itag;
                msg.xtags = msg.formatId.xtags;
            } else if (field === 14) msg.contentLength = reader.readVarint().toString();
            else if (field === 15) msg.timeRange = TimeRange.decode(reader, Number(reader.readVarint()));
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const FormatInitializationMetadata = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 2) {
                msg.formatId = FormatId.decode(reader, Number(reader.readVarint()));
                msg.itag = msg.formatId.itag; 
            } else if (field === 4) msg.endSegmentNumber = reader.readVarint().toString();
            else if (field === 5) msg.mimeType = reader.readString();
            else if (field === 9) msg.durationUnits = reader.readVarint().toString();
            else if (field === 10) msg.durationTimescale = reader.readVarint().toString();
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const StreamProtectionStatus = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.status = Number(reader.readVarint());
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const SabrRedirect = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.url = reader.readString();
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const SabrError = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.type = reader.readString();
            else if (field === 2) msg.code = Number(reader.readVarint());
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const SnackbarMessage = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.id = Number(reader.readVarint());
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const SabrContextUpdate = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.type = Number(reader.readVarint());
            else if (field === 2) msg.scope = Number(reader.readVarint());
            else if (field === 3) msg.value = reader.readBytes();
            else if (field === 4) msg.sendByDefault = Boolean(reader.readVarint());
            else if (field === 5) msg.writePolicy = Number(reader.readVarint());
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const SabrContextSendingPolicy = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = { startPolicy: [], stopPolicy: [], discardPolicy: [] };
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.startPolicy.push(Number(reader.readVarint()));
            else if (field === 2) msg.stopPolicy.push(Number(reader.readVarint()));
            else if (field === 3) msg.discardPolicy.push(Number(reader.readVarint()));
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

export const NextRequestPolicy = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            if (field === 1) msg.targetAudioReadaheadMs = Number(reader.readVarint());
            else if (field === 2) msg.targetVideoReadaheadMs = Number(reader.readVarint());
            else if (field === 3) msg.maxTimeSinceLastRequestMs = Number(reader.readVarint());
            else if (field === 4) msg.backoffTimeMs = Number(reader.readVarint());
            else if (field === 5) msg.minAudioReadaheadMs = Number(reader.readVarint());
            else if (field === 6) msg.minVideoReadaheadMs = Number(reader.readVarint());
            else if (field === 7) msg.playbackCookie = reader.readBytes();
            else reader.skip(tag & 7);
        }
        return msg;
    }
};

function isMostlyPrintableUtf8(u8) {
    if (!u8 || !u8.length) return false;
    try {
        const s = new TextDecoder().decode(u8);
        if (!s) return false;
        let ok = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) ok++;
        }
        return ok / s.length > 0.9;
    } catch {
        return false;
    }
}

function decodeProtobufObject(reader, len, depth = 2) {
    const end = reader.pos + len;
    const msg = {};

    const push = (field, value) => {
        const k = String(field);
        if (!msg[k]) msg[k] = [];
        msg[k].push(value);
    };

    while (reader.pos < end) {
        const tag = Number(reader.readVarint());
        if (!tag) break;

        const field = tag >>> 3;
        const wireType = tag & 7;

        if (wireType === 0) {
            const v = reader.readVarint();
            const n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
            push(field, n);
        } else if (wireType === 2) {
            const b = reader.readBytes();
            const entry = { len: b.length };
            if (isMostlyPrintableUtf8(b) && b.length <= 256) entry.utf8 = new TextDecoder().decode(b);
            if (depth > 0 && b.length) {
                try {
                    const nested = decodeProtobufObject(new ProtoReader(b), b.length, depth - 1);
                    if (Object.keys(nested).length) entry.pb = nested;
                } catch {}
            }
            push(field, entry);
        } else {
            reader.skip(wireType);
        }
    }

    return msg;
}

export const PlaybackStartPolicy = {
    decode(reader, len) {
        // Unknown schema; return a wire-level decoded object (numeric field keys).
        return decodeProtobufObject(reader, len, 2);
    }
};

export const RequestIdentifier = {
    decode(reader, len) {
        const end = reader.pos + len;
        const msg = {};
        while (reader.pos < end) {
            const tag = Number(reader.readVarint());
            const field = tag >>> 3;
            const wireType = tag & 7;
            if (field === 1 && wireType === 2) msg.id = reader.readString();
            else reader.skip(wireType);
        }
        return msg;
    }
};

export const RequestCancellationPolicy = {
    decode(reader, len) {
        // Unknown schema; return a wire-level decoded object (numeric field keys).
        return decodeProtobufObject(reader, len, 2);
    }
};

export const StreamerContext = {
    encode(msg, writer) {
        if (msg.clientInfo) {
            const w = new ProtoWriter();
            ClientInfo.encode(msg.clientInfo, w);
            writer.writeMessage(1, w);
        }
        writer.writeBytes(2, msg.poToken);
        if (msg.playbackCookie) {
            const w = new ProtoWriter();
            w.writeBytes(1, msg.playbackCookie);
            writer.writeMessage(3, w);
        }
        if (msg.sabrContexts) {
            for (const ctx of msg.sabrContexts) {
                const w = new ProtoWriter();
                w.writeInt32(1, ctx.type);
                w.writeBytes(2, ctx.value);
                writer.writeMessage(5, w);
            }
        }
        if (msg.unsentSabrContexts) {
            for (const type of msg.unsentSabrContexts) {
                writer.writeInt32(6, type);
            }
        }
    }
};

export const EnabledTrackTypes = {
    VIDEO_AND_AUDIO: 0,
    AUDIO_ONLY: 1,
    VIDEO_ONLY: 2
};

export const UMPPartId = {
    FORMAT_INITIALIZATION_METADATA: 42,
    NEXT_REQUEST_POLICY: 35,
    SABR_ERROR: 44,
    SABR_REDIRECT: 43,
    PLAYBACK_START_POLICY: 47,
    REQUEST_IDENTIFIER: 52,
    REQUEST_CANCELLATION_POLICY: 53,
    SABR_CONTEXT_UPDATE: 57,
    SABR_CONTEXT_SENDING_POLICY: 59,
    STREAM_PROTECTION_STATUS: 58,
    RELOAD_PLAYER_RESPONSE: 46,
    MEDIA_HEADER: 20,
    MEDIA: 21,
    MEDIA_END: 22,
    SNACKBAR_MESSAGE: 67
};

export function base64ToU8(base64) {
    const standard_base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    const padded_base64 = standard_base64.padEnd(standard_base64.length + (4 - standard_base64.length % 4) % 4, '=');
    return new Uint8Array(Buffer.from(padded_base64, 'base64'));
}

export function concatenateChunks(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}