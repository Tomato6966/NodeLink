import { encodeTrack, http1makeRequest, logger, makeRequest } from "../utils.js";
import HLSHandler from "../playback/hls/HLSHandler.js";
const API_BASE = 'https://api.vk.com/method/';
const API_VERSION = '5.131';
const BASE64_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0';
export default class VKMusicSource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options.sources?.vkmusic || {};
        this.searchTerms = ['vksearch'];
        this.recommendationTerm = ['vkrec'];
        this.patterns = [
            /vk\.(?:com|ru)\/.*?[?&]z=audio_playlist(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
            /vk\.(?:com|ru)\/(?:music\/(?:playlist|album)\/)(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/|(?:\?|&)access_hash=)(?<hash>[a-z0-9]+))?/i,
            /vk\.(?:com|ru)\/audio(?<owner>-?\d+)_(?<id>\d+)(?:(?:%2F|_|\/)(?<hash>[a-z0-9]+))?/i,
            /vk\.(?:com|ru)\/artist\/(?<id>[^/?#\s&]+)/i,
            /vk\.(?:com|ru)\/audios(?<id>-?\d+)/i
        ];
        this.priority = 80;
        this.userId = 0;
        this.hasToken = false;
        this.accessToken = this.config.userToken || null;
        this.tokenExpiry = 0;
        this.cookie = this.config.userCookie || '';
    }
    async setup() {
        const cachedToken = this.nodelink.credentialManager.get('vk_access_token');
        if (cachedToken) {
            this.accessToken = cachedToken;
            this.hasToken = true;
            logger('info', 'VKMusic', 'Using cached access token');
            return true;
        }
        if (this.accessToken || this.cookie) {
            try {
                if (!this.accessToken && this.cookie)
                    await this._refreshAccessToken();
                const response = await this._apiRequest('users.get', {});
                if (response?.[0]) {
                    this.userId = response[0].id;
                    this.hasToken = true;
                    logger('info', 'VKMusic', `Logged in as: ${response[0].first_name} (${this.userId})`);
                    return true;
                }
            }
            catch (e) {
                logger('warn', 'VKMusic', `Initial auth failed: ${e.message}`);
            }
        }
        return true;
    }
    async _refreshAccessToken() {
        if (!this.cookie)
            throw new Error('No cookie provided');
        logger('debug', 'VKMusic', 'Refreshing access token...');
        const { body, error, statusCode } = await http1makeRequest('https://login.vk.ru/?act=web_token', {
            method: 'POST',
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': 'https://vk.ru/',
                'Origin': 'https://vk.ru',
                'Cookie': this.cookie,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'version=1&app_id=6287487',
            disableBodyCompression: true,
            localAddress: this.nodelink.routePlanner?.getIP(),
            proxy: this.config.proxy
        });
        if (error || statusCode !== 200 || body.type !== 'okay') {
            logger('error', 'VKMusic', `Token refresh failed: ${body?.error_info || statusCode}`);
            throw new Error(`Token refresh failed: ${body?.error_info || statusCode}`);
        }
        this.accessToken = body.data.access_token;
        this.tokenExpiry = body.data.expires * 1000;
        this.userId = body.data.user_id;
        this.hasToken = true;
        this.nodelink.credentialManager.set('vk_access_token', this.accessToken, this.tokenExpiry - Date.now());
        logger('info', 'VKMusic', 'Access token refreshed successfully');
        return this.accessToken;
    }
    async search(query, sourceTerm) {
        if (this.recommendationTerm.includes(sourceTerm))
            return this.getRecommendations(query);
        if (!this.hasToken && this.cookie)
            await this._refreshAccessToken();
        if (!this.hasToken) {
            logger('warn', 'VKMusic', 'Search requested but no auth token available');
            return { exception: { message: 'VK auth required', severity: 'common' } };
        }
        try {
            logger('debug', 'VKMusic', `Searching for: ${query}`);
            const res = await this._apiRequest('audio.search', { q: query, count: this.nodelink.options.maxSearchResults || 10, extended: 1 });
            if (!res?.items?.length)
                return { loadType: 'empty', data: {} };
            return { loadType: 'search', data: res.items.map(item => this.buildTrack(item)) };
        }
        catch (e) {
            logger('error', 'VKMusic', `Search failed: ${e.message}`);
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async getRecommendations(query) {
        if (!this.hasToken && this.cookie)
            await this._refreshAccessToken();
        let audioId = query;
        if (!/^-?\d+_\d+$/.test(query)) {
            const searchRes = await this.search(query, 'vksearch');
            if (searchRes.loadType === 'search' && searchRes.data.length > 0)
                audioId = searchRes.data[0].info.identifier;
            else
                return { loadType: 'empty', data: {} };
        }
        try {
            logger('debug', 'VKMusic', `Getting recommendations for: ${audioId}`);
            const res = await this._apiRequest('audio.getRecommendations', { target_audio: audioId, count: 20, extended: 1 });
            if (!res?.items?.length)
                return { loadType: 'empty', data: {} };
            return {
                loadType: 'playlist',
                data: { info: { name: 'VK Recommendations', selectedTrack: 0 }, tracks: res.items.map(item => this.buildTrack(item)) }
            };
        }
        catch (e) {
            logger('error', 'VKMusic', `Recommendations failed: ${e.message}`);
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async resolve(url) {
        logger('debug', 'VKMusic', `Resolving URL: ${url}`);
        const playlistMatch = url.match(this.patterns[0]) || url.match(this.patterns[1]);
        if (playlistMatch)
            return this._resolvePlaylist(playlistMatch.groups.owner, playlistMatch.groups.id, playlistMatch.groups.hash, url);
        const trackMatch = url.match(this.patterns[2]);
        if (trackMatch)
            return this._resolveTrack(url, trackMatch);
        const audiosMatch = url.match(this.patterns[4]);
        if (audiosMatch)
            return this._resolvePlaylist(audiosMatch.groups.id, null, null, url);
        return { loadType: 'empty', data: {} };
    }
    async _resolvePlaylist(ownerId, playlistId, accessKey, url) {
        if (!this.hasToken && this.cookie)
            await this._refreshAccessToken();
        if (this.hasToken) {
            try {
                logger('debug', 'VKMusic', `Resolving playlist via API: ${ownerId}_${playlistId}`);
                const params = { owner_id: ownerId, extended: 1, count: this.nodelink.options.maxAlbumPlaylistLength || 100 };
                if (playlistId)
                    params.album_id = playlistId;
                if (accessKey)
                    params.access_key = accessKey;
                const res = await this._apiRequest('audio.get', params);
                if (res?.items?.length) {
                    return {
                        loadType: 'playlist',
                        data: { info: { name: 'VK Playlist', selectedTrack: 0 }, tracks: res.items.map(item => this.buildTrack(item)) }
                    };
                }
            }
            catch (e) {
                logger('debug', 'VKMusic', `API playlist resolution failed: ${e.message}`);
            }
        }
        return this._scrapePlaylist(url);
    }
    async _scrapePlaylist(url) {
        try {
            logger('debug', 'VKMusic', `Scraping playlist: ${url}`);
            const { body, statusCode } = await http1makeRequest(url, { headers: { 'User-Agent': USER_AGENT, 'Cookie': this.cookie }, proxy: this.config.proxy });
            if (statusCode !== 200)
                throw new Error(`HTTP ${statusCode}`);
            const dataAudioMatch = body.match(/data-audio="([^"]+)"/g);
            if (dataAudioMatch) {
                const tracks = dataAudioMatch.map(m => {
                    const raw = m.match(/"([^"]+)"/)[1].replace(/&quot;/g, '"');
                    return this._parseMeta(JSON.parse(raw));
                }).filter(Boolean);
                logger('debug', 'VKMusic', `Scraped ${tracks.length} tracks from playlist`);
                return { loadType: 'playlist', data: { info: { name: 'VK Scraped Playlist', selectedTrack: 0 }, tracks } };
            }
            throw new Error('No track data found in page');
        }
        catch (e) {
            logger('error', 'VKMusic', `Scraping playlist failed: ${e.message}`);
            return { exception: { message: `Scraping failed: ${e.message}`, severity: 'fault' } };
        }
    }
    async _resolveTrack(url, trackMatch) {
        if (!this.hasToken && this.cookie)
            await this._refreshAccessToken();
        if (this.hasToken) {
            try {
                const { owner, id, hash } = trackMatch.groups;
                const audios = `${owner}_${id}${hash ? `_${hash}` : ''}`;
                logger('debug', 'VKMusic', `Resolving track via API: ${audios}`);
                const res = await this._apiRequest('audio.getById', { audios, extended: 1 });
                if (res?.[0]) {
                    let track = this.buildTrack(res[0]);
                    if (!track.info.artworkUrl || !res[0].url) {
                        logger('debug', 'VKMusic', `Self-healing track: ${audios}`);
                        const searchRes = await this.search(`${res[0].artist} ${res[0].title}`, 'vksearch');
                        if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
                            const healed = searchRes.data.find(t => t.info.artworkUrl) || searchRes.data[0];
                            track = healed;
                        }
                    }
                    return { loadType: 'track', data: track };
                }
            }
            catch (e) {
                logger('debug', 'VKMusic', `API track resolution failed: ${e.message}`);
            }
        }
        return this._scrapeTrack(url);
    }
    async _scrapeTrack(url) {
        try {
            logger('debug', 'VKMusic', `Scraping track: ${url}`);
            const { body, statusCode } = await http1makeRequest(url, { headers: { 'User-Agent': USER_AGENT, 'Cookie': this.cookie }, proxy: this.config.proxy });
            if (statusCode !== 200)
                throw new Error(`HTTP ${statusCode}`);
            const dataAudioMatch = body.match(/data-audio="([^"]+)"/);
            if (dataAudioMatch) {
                const data = JSON.parse(dataAudioMatch[1].replace(/&quot;/g, '"'));
                let track = this._parseMeta(data);
                if (track && !track.info.artworkUrl && this.hasToken) {
                    logger('debug', 'VKMusic', `Self-healing scraped track: ${track.info.title}`);
                    const searchRes = await this.search(`${track.info.author} ${track.info.title}`, 'vksearch');
                    if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
                        track = searchRes.data.find(t => t.info.artworkUrl) || searchRes.data[0];
                    }
                }
                return { loadType: 'track', data: track };
            }
            throw new Error('Track data not found in page');
        }
        catch (e) {
            logger('error', 'VKMusic', `Scraping track failed: ${e.message}`);
            return { exception: { message: `Scraping failed: ${e.message}`, severity: 'fault' } };
        }
    }
    _parseMeta(data) {
        if (!Array.isArray(data) || data.length < 6)
            return null;
        const id = `${data[1]}_${data[0]}`;
        let rawUrl = data[2];
        if (rawUrl?.includes('audio_api_unavailable'))
            rawUrl = this._unmask_url(rawUrl, this.userId);
        const artworkUrl = data[14] ? data[14].split(',')[0] : null;
        const trackInfo = {
            identifier: id, isSeekable: true, author: data[4], length: data[5] * 1000,
            isStream: false, position: 0, title: data[3], uri: `https://vk.com/audio${id}`,
            artworkUrl, isrc: null, sourceName: 'vkmusic',
            details: [data[25] || null]
        };
        return { encoded: encodeTrack(trackInfo), info: trackInfo };
    }
    buildTrack(item) {
        const id = `${item.owner_id}_${item.id}`;
        const thumb = item.album?.thumb || item.album?.images?.[0];
        const artworkUrl = thumb?.photo_1200 || thumb?.photo_600 || thumb?.photo_300 || null;
        const trackInfo = {
            identifier: id, isSeekable: true, author: item.artist, length: item.duration * 1000,
            isStream: false, position: 0, title: item.title, uri: `https://vk.com/audio${id}`,
            artworkUrl, isrc: item.external_ids?.isrc || null, sourceName: 'vkmusic',
            details: [item.access_key || null]
        };
        return { encoded: encodeTrack(trackInfo), info: trackInfo };
    }
    async getTrackUrl(decodedTrack, itag, forceRefresh = false) {
        if (!forceRefresh) {
            const cached = this.nodelink.trackCacheManager.get('vkmusic', decodedTrack.identifier);
            if (cached)
                return cached;
        }
        const id = decodedTrack.identifier;
        const accessKey = decodedTrack.details?.[0];
        logger('debug', 'VKMusic', `Resolving stream for: ${id}`);
        let url = null;
        if (!this.hasToken && this.cookie)
            await this._refreshAccessToken();
        if (this.hasToken) {
            try {
                const audios = accessKey ? `${id}_${accessKey}` : id;
                const res = await this._apiRequest('audio.getById', { audios });
                if (res?.[0]?.url)
                    url = res[0].url.includes('audio_api_unavailable') ? this._unmask_url(res[0].url, this.userId) : res[0].url;
            }
            catch (e) {
                logger('debug', 'VKMusic', `Stream API getById failed: ${e.message}`);
            }
            if (!url) {
                try {
                    logger('debug', 'VKMusic', `Stream fallback search for: ${decodedTrack.author} - ${decodedTrack.title}`);
                    const res = await this._apiRequest('audio.search', { q: `${decodedTrack.author} ${decodedTrack.title}`, count: 10 });
                    const match = res?.items?.find(i => `${i.owner_id}_${i.id}` === id) || res?.items?.[0];
                    if (match?.url)
                        url = match.url.includes('audio_api_unavailable') ? this._unmask_url(match.url, this.userId) : match.url;
                }
                catch (e) {
                    logger('debug', 'VKMusic', `Stream fallback search failed: ${e.message}`);
                }
            }
        }
        if (url && (url.startsWith('http') || url.includes('.m3u8'))) {
            logger('debug', 'VKMusic', `Stream resolved: ${url.substring(0, 50)}...`);
            const result = { url, protocol: url.includes('.m3u8') ? 'hls' : 'https', format: url.includes('.m3u8') ? 'mpegts' : 'mp3' };
            this.nodelink.trackCacheManager.set('vkmusic', decodedTrack.identifier, result, 1000 * 60 * 60 * 2);
            return result;
        }
        logger('warn', 'VKMusic', 'Native stream not found, falling back to YouTube');
        const searchRes = await this.nodelink.sources.searchWithDefault(`${decodedTrack.title} ${decodedTrack.author}`);
        if (searchRes.loadType === 'search' && searchRes.data.length > 0) {
            return { newTrack: searchRes.data[0], ...(await this.nodelink.sources.getTrackUrl(searchRes.data[0].info)) };
        }
        return { exception: { message: 'Stream not found', severity: 'fault' } };
    }
    async loadStream(_track, url, protocol, additionalData) {
        const headers = { 'User-Agent': USER_AGENT, 'Cookie': this.cookie, 'Referer': 'https://vk.com/', 'Origin': 'https://vk.com' };
        if (protocol === 'hls') {
            logger('debug', 'VKMusic', 'Loading HLS stream via mpegts strategy');
            return {
                stream: new HLSHandler(url, {
                    headers,
                    type: 'mpegts',
                    localAddress: this.nodelink.routePlanner?.getIP(),
                    startTime: additionalData?.startTime || 0,
                    proxy: this.config.proxy
                }),
                type: 'mpegts'
            };
        }
        const { stream, error } = await http1makeRequest(url, { method: 'GET', streamOnly: true, headers, proxy: this.config.proxy });
        if (error)
            throw error;
        return { stream, type: 'mp3' };
    }
    async _apiRequest(method, params) {
        if (this.cookie && (!this.accessToken || (this.tokenExpiry && Date.now() >= this.tokenExpiry - 60000)))
            await this._refreshAccessToken();
        const url = new URL(API_BASE + method);
        params.access_token = this.accessToken;
        params.v = API_VERSION;
        Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
        const { body, error, statusCode } = await makeRequest(url.toString(), {
            method: 'GET', headers: { 'User-Agent': 'KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)' },
            localAddress: this.nodelink.routePlanner?.getIP(),
            proxy: this.config.proxy
        });
        if (error || statusCode !== 200 || body.error) {
            if ((statusCode === 401 || body?.error?.error_code === 5) && this.cookie) {
                await this._refreshAccessToken();
                return this._apiRequest(method, params);
            }
            throw new Error(body?.error?.error_msg || error?.message || `HTTP ${statusCode}`);
        }
        return body.response;
    }
    _b64_decode(enc) {
        let dec = '', e = 0, n = 0;
        for (let i = 0; i < enc.length; i++) {
            const r = BASE64_CHARS.indexOf(enc[i]);
            if (r === -1)
                continue;
            e = (n % 4) ? 64 * e + r : r;
            if (n++ % 4)
                dec += String.fromCharCode(255 & (e >> ((-2 * n) & 6)));
        }
        return dec;
    }
    _unmask_url(mask_url, vk_id) {
        if (!mask_url.includes('audio_api_unavailable'))
            return mask_url;
        try {
            const parts = mask_url.split('?extra=')[1].split('#');
            const split1 = this._b64_decode(parts[1]).split(String.fromCharCode(11));
            const maskUrlArr = this._b64_decode(parts[0]).split('');
            let index = parseInt(split1[1], 10) ^ vk_id;
            const urlLen = maskUrlArr.length, indexes = new Array(urlLen);
            for (let n = urlLen - 1; n >= 0; n--) {
                index = ((urlLen * (n + 1)) ^ (index + n)) % urlLen;
                indexes[n] = index;
            }
            for (let n = 1; n < urlLen; n++) {
                const c = maskUrlArr[n], idx = indexes[urlLen - 1 - n];
                maskUrlArr[n] = maskUrlArr[idx], maskUrlArr[idx] = c;
            }
            return maskUrlArr.join('');
        }
        catch (e) {
            return null;
        }
    }
}
