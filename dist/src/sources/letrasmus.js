import { encodeTrack, getBestMatch, http1makeRequest, logger } from "../utils.js";
const LETRAS_PATTERN = /^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/[a-z0-9-]+\/[^/]+\/?/i;
const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/';
const decodeHtml = (text) => {
    if (!text)
        return text;
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
};
const parseJsonp = (body) => {
    if (!body)
        return null;
    const trimmed = body.trim();
    if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
        return JSON.parse(trimmed.slice('LetrasSug('.length, -1));
    }
    const start = trimmed.indexOf('(');
    const end = trimmed.lastIndexOf(')');
    if (start !== -1 && end > start) {
        return JSON.parse(trimmed.slice(start + 1, end));
    }
    return JSON.parse(trimmed);
};
const extractMeta = (html, property) => {
    const re1 = new RegExp(`<meta[^>]+property=[\"']${property}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']${property}[\"'][^>]*>`, 'i');
    const match = html.match(re1) || html.match(re2);
    return match ? decodeHtml(match[1]) : null;
};
const extractOmqLyric = (html) => {
    const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i);
    if (!match)
        return null;
    try {
        return JSON.parse(match[1]);
    }
    catch {
        return null;
    }
};
const buildTrackUrl = (dns, url) => `https://www.letras.mus.br/${dns}/${url}/`;
export default class LetrasMusSource {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.priority = 40;
        this.searchTerms = ['lmsearch'];
        this.recommendationTerm = ['lmrec'];
        this.patterns = [LETRAS_PATTERN];
        this.maxSearchResults = nodelink.options.maxSearchResults || 10;
    }
    async setup() {
        logger('info', 'Sources', 'Loaded LetrasMus source.');
        return true;
    }
    isLinkMatch(link) {
        return LETRAS_PATTERN.test(link);
    }
    async search(query, sourceTerm) {
        try {
            if (sourceTerm === 'lmrec') {
                return await this._recommend(query);
            }
            const tracks = await this._searchSolr(query);
            return tracks.length
                ? { loadType: 'search', data: tracks }
                : { loadType: 'empty', data: {} };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async resolve(url) {
        if (!LETRAS_PATTERN.test(url)) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { body, statusCode, error } = await http1makeRequest(url, {
                method: 'GET'
            });
            if (error || statusCode !== 200 || !body) {
                return {
                    exception: {
                        message: `Failed to fetch Letras page: ${error?.message || statusCode}`,
                        severity: 'fault'
                    }
                };
            }
            const omq = extractOmqLyric(body);
            const title = omq?.Name || extractMeta(body, 'og:title') || 'Unknown';
            const author = omq?.Artist || 'Unknown';
            const artworkUrl = extractMeta(body, 'og:image');
            const youtubeId = omq?.YoutubeID || null;
            const canonical = extractMeta(body, 'og:url') || extractMeta(body, 'canonical') || url;
            let length = 0;
            let finalArtwork = artworkUrl || null;
            if (youtubeId) {
                try {
                    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
                    const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl);
                    if (youtubeResult?.loadType === 'track') {
                        const ytInfo = youtubeResult.data?.info || youtubeResult.data;
                        if (Number.isFinite(ytInfo?.length))
                            length = ytInfo.length;
                        if (!finalArtwork && ytInfo?.artworkUrl) {
                            finalArtwork = ytInfo.artworkUrl;
                        }
                    }
                }
                catch { }
            }
            const info = {
                identifier: canonical,
                isSeekable: true,
                author,
                length,
                isStream: false,
                position: 0,
                title,
                uri: canonical,
                artworkUrl: finalArtwork,
                isrc: null,
                sourceName: 'letrasmus'
            };
            return { loadType: 'track', data: { encoded: encodeTrack(info), info } };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async _resolveYoutubeIdFromPage(url) {
        if (!url)
            return null;
        try {
            const { body, statusCode, error } = await http1makeRequest(url, {
                method: 'GET'
            });
            if (error || statusCode !== 200 || !body)
                return null;
            const omq = extractOmqLyric(body);
            return omq?.YoutubeID || null;
        }
        catch {
            return null;
        }
    }
    async getTrackUrl(decodedTrack) {
        try {
            let youtubeId = decodedTrack?.youtubeId || decodedTrack?.info?.youtubeId;
            if (!youtubeId && decodedTrack?.uri) {
                youtubeId = await this._resolveYoutubeIdFromPage(decodedTrack.uri);
            }
            if (youtubeId) {
                const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
                const youtubeResult = await this.nodelink.sources.resolve(youtubeUrl);
                if (youtubeResult?.loadType === 'track') {
                    const streamInfo = await this.nodelink.sources.getTrackUrl(youtubeResult.data.info);
                    return { newTrack: youtubeResult.data, ...streamInfo };
                }
            }
            const query = `${decodedTrack.title} ${decodedTrack.author}`.trim();
            let searchResult = await this.nodelink.sources.search('youtube', query, 'ytmsearch');
            if (searchResult.loadType !== 'search' ||
                searchResult.data.length === 0) {
                searchResult = await this.nodelink.sources.searchWithDefault(query);
            }
            if (searchResult.loadType !== 'search' ||
                searchResult.data.length === 0) {
                return {
                    exception: {
                        message: 'No matching track found on default source.',
                        severity: 'common'
                    }
                };
            }
            const bestMatch = getBestMatch(searchResult.data, decodedTrack);
            if (!bestMatch) {
                return {
                    exception: {
                        message: 'No suitable alternative found after filtering.',
                        severity: 'common'
                    }
                };
            }
            const streamInfo = await this.nodelink.sources.getTrackUrl(bestMatch.info);
            return { newTrack: bestMatch, ...streamInfo };
        }
        catch (e) {
            return { exception: { message: e.message, severity: 'fault' } };
        }
    }
    async _searchSolr(query) {
        const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body) {
            throw new Error(`Letras search failed: ${error?.message || statusCode}`);
        }
        const parsed = parseJsonp(body);
        const docs = parsed?.response?.docs || [];
        return docs
            .filter((doc) => doc?.t === '2' && doc?.dns && doc?.url)
            .slice(0, this.maxSearchResults)
            .map((doc) => {
            const uri = buildTrackUrl(doc.dns, doc.url);
            const info = {
                identifier: uri,
                isSeekable: true,
                author: doc.art || 'Unknown',
                length: 0,
                isStream: false,
                position: 0,
                title: doc.txt || 'Unknown',
                uri,
                artworkUrl: doc.img || null,
                isrc: null,
                sourceName: 'letrasmus'
            };
            return { encoded: encodeTrack(info), info };
        });
    }
    async _recommend(query) {
        const urlMatch = query?.match(/^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/([a-z0-9-]+)\//i);
        let artistSlug = urlMatch?.[1] || null;
        if (!artistSlug) {
            try {
                const searchTracks = await this._searchSolr(query);
                const first = searchTracks[0]?.info;
                if (first?.uri) {
                    const match = first.uri.match(/^https?:\/\/(?:www\.)?letras\.(?:mus\.br|com)\/([a-z0-9-]+)\//i);
                    artistSlug = match?.[1] || null;
                }
            }
            catch { }
        }
        if (!artistSlug) {
            return { loadType: 'empty', data: {} };
        }
        const recUrl = `https://api.letras.mus.br/v2/playlists/radio/${artistSlug}/`;
        const { body, statusCode, error } = await http1makeRequest(recUrl, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body) {
            return {
                exception: {
                    message: `Letras recommendation failed: ${error?.message || statusCode}`,
                    severity: 'fault'
                }
            };
        }
        const list = Array.isArray(body?.SongList) ? body.SongList : [];
        const tracks = list.slice(0, this.maxSearchResults).map((item) => {
            const uri = buildTrackUrl(item.DNS, item.URL);
            const info = {
                identifier: uri,
                isSeekable: true,
                author: item.Artist || 'Unknown',
                length: 0,
                isStream: false,
                position: 0,
                title: item.Name || 'Unknown',
                uri,
                artworkUrl: null,
                isrc: null,
                sourceName: 'letrasmus'
            };
            return { encoded: encodeTrack(info), info };
        });
        return tracks.length
            ? { loadType: 'search', data: tracks }
            : { loadType: 'empty', data: {} };
    }
    async loadStream(track, url, protocol, additionalData) {
        return this.nodelink.sources.loadStream(track, url, protocol, additionalData);
    }
}
