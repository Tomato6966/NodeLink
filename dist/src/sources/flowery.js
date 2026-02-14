import { PassThrough } from 'node:stream';
import { URL } from 'node:url';
import { encodeTrack, logger, makeRequest } from "../utils.js";
export default class FlowerySource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = this.nodelink.options.sources?.flowery || {};
        this.searchTerms = ['ftts', 'flowery'];
        this.patterns = [/^ftts:\/\//];
        this.priority = 50;
        this.voiceMap = new Map();
        this.defaultVoiceId = null;
    }
    async setup() {
        logger('info', 'Sources', 'Loaded Flowery TTS source.');
        await this._fetchVoices();
        return true;
    }
    async _fetchVoices() {
        try {
            const cachedVoices = this.nodelink.credentialManager.get('flowery_voices');
            if (cachedVoices) {
                this.voiceMap = new Map(Object.entries(cachedVoices.voiceMap));
                this.defaultVoiceId = cachedVoices.defaultVoiceId;
                logger('debug', 'Flowery', `Loaded ${this.voiceMap.size} voices from CredentialManager.`);
                return;
            }
            const voicesEndpoint = 'https://api.flowery.pw/v1/tts/voices';
            const { body, error, statusCode } = await makeRequest(voicesEndpoint, { method: 'GET' });
            if (error || statusCode !== 200 || !body || !Array.isArray(body.voices)) {
                logger('error', 'Flowery', `Failed to fetch voices from ${voicesEndpoint}: ${error?.message || `Status ${statusCode}`}`);
                return;
            }
            this.voiceMap.clear();
            for (const voice of body.voices) {
                this.voiceMap.set(String(voice.name).toLowerCase(), voice.id);
            }
            if (body.default?.id) {
                this.defaultVoiceId = body.default.id;
                logger('info', 'Flowery', `Default voice set to: ${body.default.name} (${body.default.id})`);
            }
            else if (body.voices.length > 0) {
                this.defaultVoiceId = body.voices[0].id;
                logger('info', 'Flowery', `Using first available voice as default: ${body.voices[0].name} (${body.voices[0].id})`);
            }
            this.nodelink.credentialManager.set('flowery_voices', {
                voiceMap: Object.fromEntries(this.voiceMap),
                defaultVoiceId: this.defaultVoiceId
            }, 24 * 60 * 60 * 1000);
            logger('debug', 'Flowery', `Fetched ${this.voiceMap.size} voices.`);
        }
        catch (e) {
            logger('error', 'Flowery', `Exception fetching voices: ${e.message}`);
        }
    }
    async search(query) {
        if (!query)
            return { loadType: 'empty', data: {} };
        try {
            const url = this._buildUrl(query);
            const track = this.buildTrack({
                title: query.length > 50 ? `${query.substring(0, 47)}...` : query,
                author: 'Flowery TTS',
                uri: url,
                identifier: `ftts:${query}`
            });
            return { loadType: 'track', data: track };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault', cause: 'Exception' } };
        }
    }
    async resolve(url) {
        try {
            let text = '';
            const params = {};
            if (url.startsWith('ftts://')) {
                const pathAndQuery = url.slice(7);
                const splitIdx = pathAndQuery.indexOf('?');
                if (splitIdx !== -1) {
                    text = decodeURIComponent(pathAndQuery.substring(0, splitIdx));
                    const queryStr = pathAndQuery.substring(splitIdx + 1);
                    const searchParams = new URLSearchParams(queryStr);
                    for (const [key, value] of searchParams) {
                        params[key] = value;
                    }
                }
                else {
                    text = decodeURIComponent(pathAndQuery);
                }
            }
            else {
                text = url;
            }
            if (!text)
                return { loadType: 'empty', data: {} };
            const apiUrl = this._buildUrl(text, params);
            const track = this.buildTrack({
                title: text.length > 50 ? `${text.substring(0, 47)}...` : text,
                author: 'Flowery TTS',
                uri: apiUrl,
                identifier: url
            });
            return { loadType: 'track', data: track };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault', cause: 'Exception' } };
        }
    }
    _buildUrl(text, overrides = {}) {
        const config = this.config;
        const enforceConfig = config.enforceConfig || false;
        let voiceName = config.voice || 'Salli';
        let translate = config.translate || false;
        let silence = config.silence || 0;
        let speed = config.speed || 1.0;
        if (!enforceConfig) {
            if (overrides.voice)
                voiceName = overrides.voice;
            if (overrides.translate !== undefined)
                translate = overrides.translate;
            if (overrides.silence !== undefined)
                silence = overrides.silence;
            if (overrides.speed !== undefined)
                speed = overrides.speed;
        }
        let voiceId = this.voiceMap.get(String(voiceName).toLowerCase()) || this.defaultVoiceId;
        if (!voiceId) {
            logger('warn', 'Flowery', `Voice "${voiceName}" not found and no default voice available. Using fallback voice ID.`);
            voiceId = 'default';
        }
        const baseUrl = 'https://api.flowery.pw/v1/tts';
        const queryParams = new URLSearchParams({
            voice: String(voiceId),
            text: String(text),
            translate: String(translate),
            silence: String(silence),
            audio_format: 'mp3',
            speed: String(speed)
        });
        return `${baseUrl}?${queryParams.toString()}`;
    }
    buildTrack(partialInfo) {
        const track = {
            identifier: partialInfo.identifier,
            isSeekable: true,
            author: 'Flowery TTS',
            length: -1,
            isStream: false,
            position: 0,
            title: partialInfo.title,
            uri: partialInfo.uri,
            artworkUrl: null,
            isrc: null,
            sourceName: 'flowery'
        };
        return { encoded: encodeTrack(track), info: track, pluginInfo: {} };
    }
    async getTrackUrl(track, itag, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager.get('flowery', track.identifier);
            if (cached)
                return cached;
        }
        const normalized = this._forceMp3Url(track.uri);
        try {
            this.nodelink.trackCacheManager.set('flowery', track.identifier, normalized);
        }
        catch {
            // ignore
        }
        return normalized;
    }
    _forceMp3Url(uri) {
        const out = { url: uri, protocol: 'https', format: 'mp3' };
        try {
            const urlObj = new URL(uri);
            urlObj.searchParams.set('audio_format', 'mp3');
            out.url = urlObj.toString();
            return out;
        }
        catch {
            return out;
        }
    }
    async loadStream(decodedTrack, url, _protocol, _additionalData) {
        logger('debug', 'Sources', `Loading Flowery TTS stream for "${decodedTrack.title}"`);
        const finalUrl = this._forceMp3Url(url).url;
        try {
            const response = await makeRequest(finalUrl, {
                method: 'GET',
                streamOnly: true,
                headers: {
                    'User-Agent': 'NodeLink/FloweryTTS',
                    Accept: '*/*'
                }
            });
            if (response.error || !response.stream) {
                throw (response.error || new Error('Failed to get stream, no stream object returned.'));
            }
            const stream = new PassThrough();
            response.stream.pipe(stream);
            response.stream.on('end', () => {
                stream.emit('finishBuffering');
            });
            response.stream.on('error', (err) => {
                logger('error', 'Sources', `Flowery TTS stream error: ${err.message}`);
                if (!stream.destroyed)
                    stream.destroy(err);
            });
            return { stream };
        }
        catch (err) {
            logger('error', 'Sources', `Failed to load Flowery TTS stream: ${err.message}`);
            return {
                exception: { message: err.message, severity: 'common', cause: 'Upstream' }
            };
        }
    }
}
