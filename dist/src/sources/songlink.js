import { encodeTrack, http1makeRequest, logger } from "../utils.js";
const SONG_LINK_PATTERN = /^https?:\/\/(?:www\.)?(song\.link|album\.link|artist\.link|pods\.link|odesli\.co)\/.+/i;
const DEFAULT_PLATFORM_ORDER = [
    'spotify',
    'appleMusic',
    'youtubeMusic',
    'youtube',
    'deezer',
    'tidal',
    'amazonMusic',
    'soundcloud',
    'bandcamp',
    'audius',
    'audiomack',
    'pandora',
    'itunes',
    'amazonStore',
    'google',
    'googleStore',
    'napster',
    'yandex',
    'boomplay',
    'anghami',
    'spinrilla'
];
const PLATFORM_SOURCE_MAP = {
    spotify: 'spotify',
    itunes: 'applemusic',
    appleMusic: 'applemusic',
    youtube: 'youtube',
    youtubeMusic: 'youtube',
    deezer: 'deezer',
    tidal: 'tidal',
    amazonMusic: 'amazonmusic',
    amazonStore: 'amazonmusic',
    soundcloud: 'soundcloud',
    bandcamp: 'bandcamp',
    audius: 'audius',
    audiomack: 'audiomack',
    pandora: 'pandora'
};
const DEFAULT_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const SCRAPE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
export default class SongLinkSource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.config = nodelink.options.sources?.songlink || {};
        this.searchTerms = ['slsearch'];
        this.patterns = [SONG_LINK_PATTERN];
        this.priority = 95;
        this.apiKey = null;
        this.userCountry = 'US';
        this.songIfSingle = true;
        this.preferredPlatforms = DEFAULT_PLATFORM_ORDER;
        this.fallbackToAny = true;
        this.cacheTtlMs = DEFAULT_CACHE_TTL_MS;
        this.useScrapeFallback = true;
        this.useApi = true;
    }
    async setup() {
        this.apiKey = this.config.apiKey || null;
        this.userCountry = this.config.userCountry || 'US';
        this.songIfSingle = this.config.songIfSingle ?? true;
        this.preferredPlatforms = Array.isArray(this.config.preferredPlatforms)
            ? this.config.preferredPlatforms
            : DEFAULT_PLATFORM_ORDER;
        this.fallbackToAny = this.config.fallbackToAny ?? true;
        this.useScrapeFallback = this.config.useScrapeFallback ?? true;
        this.useApi = this.config.useApi ?? true;
        return true;
    }
    async resolve(url) {
        try {
            const cached = this.nodelink.trackCacheManager?.get('songlink', url);
            if (cached)
                return cached;
            const data = await this._fetchSongLinkData(url);
            if (!data?.linksByPlatform) {
                return { loadType: 'empty', data: {} };
            }
            const linksByPlatform = data.linksByPlatform || {};
            const platforms = this._buildPlatformOrder(linksByPlatform);
            const songlinkInfo = {
                pageUrl: data.pageUrl,
                entityUniqueId: data.entityUniqueId,
                userCountry: data.userCountry,
                linksByPlatform
            };
            for (const platform of platforms) {
                const link = linksByPlatform[platform]?.url;
                if (!link)
                    continue;
                const sourceName = PLATFORM_SOURCE_MAP[platform];
                if (!sourceName || !this._isSourceAvailable(sourceName)) {
                    continue;
                }
                try {
                    const result = await this.nodelink.sources.resolve(link);
                    if (result?.loadType &&
                        result.loadType !== 'empty' &&
                        result.loadType !== 'error') {
                        const decorated = this._decorateResult(result, songlinkInfo, platform, link);
                        this.nodelink.trackCacheManager?.set('songlink', url, decorated, this.cacheTtlMs);
                        return decorated;
                    }
                }
                catch (e) {
                    logger('debug', 'SongLink', `Failed to resolve ${platform} link: ${e.message}`);
                }
            }
            return {
                loadType: 'error',
                data: {
                    message: 'No supported platform links found for this Song.link URL.',
                    severity: 'fault'
                }
            };
        }
        catch (e) {
            logger('error', 'SongLink', `Resolution failed: ${e.message}`);
            return {
                loadType: 'error',
                data: { message: e.message, severity: 'fault' }
            };
        }
    }
    async search(query, _sourceTerm, _searchType = 'track') {
        try {
            const limit = this.nodelink.options.maxSearchResults || 10;
            const searchUrl = new URL('https://itunes.apple.com/search');
            searchUrl.searchParams.set('term', query);
            searchUrl.searchParams.set('country', this.userCountry || 'US');
            searchUrl.searchParams.set('entity', 'song,album,podcast,podcastEpisode');
            searchUrl.searchParams.set('limit', String(limit));
            searchUrl.searchParams.set('callback', '__jp33');
            const { body, statusCode } = await http1makeRequest(searchUrl.toString());
            if (statusCode !== 200)
                return { loadType: 'empty', data: {} };
            const payload = typeof body === 'string' ? this._parseJsonp(body) : body;
            const results = payload?.results || [];
            if (!Array.isArray(results) || results.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const tracks = [];
            for (const item of results) {
                if (!item || !item.trackId)
                    continue;
                const kind = item?.kind || item?.wrapperType;
                const wrapper = item?.wrapperType || '';
                const isSong = kind === 'song';
                const isPodcastEpisode = kind === 'podcast-episode' || wrapper === 'podcastEpisode';
                const isPodcast = kind === 'podcast' || wrapper === 'track';
                if (!isSong && !isPodcastEpisode && !isPodcast)
                    continue;
                const episodeUrl = item.episodeUrl || item.previewUrl;
                const feedUrl = item.feedUrl;
                const fallbackUrl = item.trackViewUrl || item.collectionViewUrl;
                const uri = (isPodcastEpisode ? episodeUrl : null) ||
                    (isPodcast ? feedUrl : null) ||
                    fallbackUrl;
                if (!uri)
                    continue;
                const trackInfo = {
                    identifier: String(item.trackId),
                    isSeekable: true,
                    author: item.artistName ||
                        item.collectionArtistName ||
                        item.artistViewUrl ||
                        'Unknown Artist',
                    length: item.trackTimeMillis || 0,
                    isStream: false,
                    position: 0,
                    title: item.trackName || item.collectionName || 'Unknown Title',
                    uri,
                    artworkUrl: item.artworkUrl600 ||
                        item.artworkUrl100 ||
                        item.artworkUrl60 ||
                        null,
                    isrc: item.isrc || null,
                    sourceName: 'songlink'
                };
                tracks.push({
                    encoded: encodeTrack(trackInfo),
                    info: trackInfo,
                    pluginInfo: {
                        kind: kind || wrapper || 'track',
                        feedUrl: item.feedUrl || null
                    }
                });
            }
            if (tracks.length === 0)
                return { loadType: 'empty', data: {} };
            return { loadType: 'search', data: tracks };
        }
        catch (e) {
            logger('error', 'SongLink', `Search failed: ${e.message}`);
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async getSongLinkData(url) {
        return await this._fetchSongLinkData(url);
    }
    getPlatformOrder(linksByPlatform = {}) {
        return this._buildPlatformOrder(linksByPlatform);
    }
    getPlatformSourceName(platform) {
        return PLATFORM_SOURCE_MAP[platform] || null;
    }
    async getTrackUrl(decodedTrack) {
        try {
            const uri = decodedTrack?.uri;
            if (!uri) {
                return {
                    exception: { message: 'Missing track URL.', severity: 'common' }
                };
            }
            const resolved = await this.nodelink.sources.resolve(uri);
            if (resolved?.loadType === 'track') {
                const streamInfo = await this.nodelink.sources.getTrackUrl(resolved.data.info);
                return { newTrack: resolved.data, ...streamInfo };
            }
            return {
                exception: {
                    message: 'Resolved URL did not return a playable track.',
                    severity: 'common'
                }
            };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async _fetchSongLinkData(url) {
        let apiStatus = null;
        if (this.useApi) {
            try {
                const apiUrl = new URL('https://api.song.link/v1-alpha.1/links');
                apiUrl.searchParams.set('url', url);
                if (this.userCountry)
                    apiUrl.searchParams.set('userCountry', this.userCountry);
                if (this.songIfSingle)
                    apiUrl.searchParams.set('songIfSingle', 'true');
                if (this.apiKey)
                    apiUrl.searchParams.set('key', this.apiKey);
                const { body, statusCode } = await http1makeRequest(apiUrl.toString());
                apiStatus = statusCode;
                if (statusCode === 200 && body?.linksByPlatform) {
                    return body;
                }
            }
            catch (e) {
                logger('debug', 'SongLink', `API failed: ${e.message}`);
            }
        }
        if (!this.useScrapeFallback)
            return null;
        return await this._fetchFromHtml(url);
    }
    _parseJsonp(text) {
        const start = text.indexOf('(');
        const end = text.lastIndexOf(')');
        if (start === -1 || end === -1 || end <= start)
            return null;
        const json = text.slice(start + 1, end);
        return JSON.parse(json);
    }
    async _fetchFromHtml(url) {
        try {
            const { body, statusCode } = await http1makeRequest(url, {
                headers: { 'User-Agent': SCRAPE_USER_AGENT }
            });
            if (statusCode !== 200 || typeof body !== 'string')
                return null;
            const nextDataMatch = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
            if (!nextDataMatch)
                return null;
            const parsed = JSON.parse(nextDataMatch[1]);
            const payload = this._findSonglinkPayload(parsed);
            if (!payload?.linksByPlatform)
                return null;
            return payload;
        }
        catch (e) {
            logger('debug', 'SongLink', `HTML scrape failed: ${e.message}`);
            return null;
        }
    }
    _findSonglinkPayload(root) {
        const derived = this._extractFromNextData(root);
        if (derived)
            return derived;
        const stack = [root];
        let visited = 0;
        const maxNodes = 10000;
        while (stack.length > 0 && visited < maxNodes) {
            const current = stack.pop();
            visited++;
            if (!current || typeof current !== 'object')
                continue;
            if (current.linksByPlatform && current.entitiesByUniqueId) {
                return current;
            }
            if (Array.isArray(current)) {
                for (let i = 0; i < current.length; i++) {
                    stack.push(current[i]);
                }
            }
            else {
                for (const value of Object.values(current)) {
                    if (value && typeof value === 'object') {
                        stack.push(value);
                    }
                }
            }
        }
        return null;
    }
    _extractFromNextData(root) {
        const pageData = root?.props?.pageProps?.pageData;
        if (!pageData || !Array.isArray(pageData.sections))
            return null;
        const linksByPlatform = {};
        let userCountry = this.userCountry || 'US';
        for (const section of pageData.sections) {
            if (!section?.links || !Array.isArray(section.links))
                continue;
            for (const link of section.links) {
                const platform = link?.platform;
                const url = link?.url;
                if (!platform || !url || link?.show === false)
                    continue;
                linksByPlatform[platform] = {
                    url,
                    nativeAppUriMobile: link?.nativeAppUriMobile,
                    nativeAppUriDesktop: link?.nativeAppUriDesktop,
                    entityUniqueId: link?.uniqueId
                };
                if (link?.country) {
                    userCountry = link.country;
                }
            }
        }
        if (Object.keys(linksByPlatform).length === 0)
            return null;
        const entitiesByUniqueId = {};
        const entityId = pageData.entityUniqueId;
        const entityData = pageData.entityData;
        if (entityId && entityData) {
            entitiesByUniqueId[entityId] = {
                id: entityData.id,
                type: entityData.type,
                title: entityData.title,
                artistName: entityData.artistName,
                thumbnailUrl: entityData.thumbnailUrl,
                duration: typeof entityData.duration === 'number'
                    ? entityData.duration / 1000
                    : undefined,
                isrc: entityData.isrc || null
            };
        }
        return {
            entityUniqueId: pageData.entityUniqueId,
            userCountry,
            pageUrl: pageData.pageUrl || root?.props?.pageProps?.pageUrl,
            linksByPlatform,
            entitiesByUniqueId
        };
    }
    _buildPlatformOrder(linksByPlatform) {
        const available = Object.keys(linksByPlatform || {});
        if (available.length === 0)
            return [];
        const ordered = [];
        const seen = new Set();
        const base = this.preferredPlatforms && this.preferredPlatforms.length > 0
            ? this.preferredPlatforms
            : DEFAULT_PLATFORM_ORDER;
        for (const platform of base) {
            if (available.includes(platform) && !seen.has(platform)) {
                ordered.push(platform);
                seen.add(platform);
            }
        }
        if (this.fallbackToAny) {
            for (const platform of available) {
                if (!seen.has(platform)) {
                    ordered.push(platform);
                    seen.add(platform);
                }
            }
        }
        return ordered;
    }
    _isSourceAvailable(sourceName) {
        const sourceConfig = this.nodelink.options.sources?.[sourceName];
        if (!sourceConfig?.enabled)
            return false;
        return !!this.nodelink.sources.getSource(sourceName);
    }
    _decorateResult(result, songlinkInfo, platform, url) {
        const extraInfo = {
            ...songlinkInfo,
            selectedPlatform: platform,
            selectedUrl: url
        };
        if (result?.loadType === 'track' && result.data) {
            result.data.pluginInfo = {
                ...(result.data.pluginInfo || {}),
                songlink: extraInfo
            };
        }
        else if (result?.loadType === 'playlist' && result.data) {
            result.data.pluginInfo = {
                ...(result.data.pluginInfo || {}),
                songlink: extraInfo
            };
        }
        return result;
    }
}
