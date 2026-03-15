import { http1makeRequest, logger } from "../utils.js";
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
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
};
const cleanText = (text) => {
    if (!text)
        return '';
    let cleaned = decodeHtml(text);
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
    return cleaned.trim();
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
const normalize = (text) => (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
const extractLyricOriginal = (html) => {
    const match = html.match(/<div class="lyric-original[^>]*">([\s\S]*?)<\/div>/i);
    if (!match)
        return null;
    let text = match[1];
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    return text.split('\n').map(cleanText).filter(Boolean);
};
const extractTranslationLanguages = (html) => {
    const match = html.match(/window\.__translationLanguages\s*=\s*(\[[\s\S]*?\]);/i);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[1]);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
const normalizeLang = (lang) => {
    if (!lang)
        return null;
    const cleaned = lang.toLowerCase().replace('-', '_');
    if (cleaned.startsWith('pt'))
        return 'pt';
    if (cleaned.startsWith('en'))
        return 'en';
    if (cleaned.startsWith('es'))
        return 'es';
    if (cleaned.startsWith('de'))
        return 'de';
    if (cleaned.startsWith('fr'))
        return 'fr';
    if (cleaned.startsWith('nl'))
        return 'nl';
    return cleaned;
};
const buildTranslationUrl = (entry) => {
    if (!entry?.url?.artist || !entry?.url?.song || !entry?.url?.translation)
        return null;
    return `https://www.letras.mus.br/${entry.url.artist}/${entry.url.song}/${entry.url.translation}`;
};
const parseSubtitle = (subtitle) => {
    let parsed;
    try {
        parsed = JSON.parse(subtitle);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .map((entry) => {
        if (!Array.isArray(entry) || entry.length < 3)
            return null;
        const text = cleanText(entry[0]);
        const start = Number.parseFloat(entry[1]);
        const end = Number.parseFloat(entry[2]);
        if (!text || Number.isNaN(start) || Number.isNaN(end))
            return null;
        return {
            text,
            time: Math.round(start * 1000),
            duration: Math.max(0, Math.round((end - start) * 1000))
        };
    })
        .filter(Boolean);
};
const buildTrackUrl = (dns, url) => `https://www.letras.mus.br/${dns}/${url}/`;
const findBestDoc = (docs, title, author) => {
    const wantedTitle = normalize(title);
    const wantedAuthor = normalize(author);
    const candidates = docs.filter((doc) => doc?.t === '2' && doc?.dns && doc?.url);
    let best = candidates.find((doc) => normalize(doc.txt) === wantedTitle &&
        normalize(doc.art) === wantedAuthor) || null;
    if (!best) {
        best = candidates.find((doc) => normalize(doc.txt) === wantedTitle) || null;
    }
    return best || candidates[0] || null;
};
export default class LetrasMusLyrics {
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    async setup() {
        return true;
    }
    async _fetchHtml(url) {
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body)
            return null;
        return body;
    }
    async _findLetrasPage(trackInfo) {
        if (trackInfo?.uri && trackInfo.sourceName === 'letrasmus') {
            return trackInfo.uri;
        }
        const query = `${trackInfo.title} ${trackInfo.author}`.trim();
        const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body)
            return null;
        const parsed = parseJsonp(body);
        const docs = parsed?.response?.docs || [];
        const best = findBestDoc(docs, trackInfo.title, trackInfo.author);
        if (!best)
            return null;
        return buildTrackUrl(best.dns, best.url);
    }
    async getLyrics(trackInfo, language) {
        try {
            const pageUrl = await this._findLetrasPage(trackInfo);
            if (!pageUrl)
                return { loadType: 'empty', data: {} };
            const html = await this._fetchHtml(pageUrl);
            if (!html)
                return { loadType: 'empty', data: {} };
            const omq = extractOmqLyric(html);
            const letrasId = omq?.ID;
            const youtubeId = omq?.YoutubeID;
            const originalLang = omq?.SongLanguage || null;
            const requestedLang = normalizeLang(language);
            if (requestedLang) {
                const translations = extractTranslationLanguages(html);
                const entry = translations.find((item) => normalizeLang(item.languageCode) === requestedLang ||
                    (item.languageCode || '').toLowerCase().startsWith(requestedLang)) || null;
                const translationUrl = entry ? buildTranslationUrl(entry) : null;
                if (!translationUrl) {
                    return { loadType: 'empty', data: {} };
                }
                const translationHtml = await this._fetchHtml(translationUrl);
                if (!translationHtml)
                    return { loadType: 'empty', data: {} };
                const translatedLines = extractLyricOriginal(translationHtml);
                if (!translatedLines || translatedLines.length === 0) {
                    return { loadType: 'empty', data: {} };
                }
                return {
                    loadType: 'lyrics',
                    data: {
                        name: omq?.Name || trackInfo.title,
                        synced: false,
                        language: {
                            requested: language || null,
                            resolved: requestedLang,
                            type: 'translation'
                        },
                        lines: translatedLines.map((text) => ({
                            text,
                            time: 0,
                            duration: 0
                        }))
                    }
                };
            }
            if (letrasId && youtubeId) {
                const apiUrl = `https://www.letras.mus.br/api/v2/subtitle/${letrasId}/${youtubeId}/`;
                const { body: apiBody, statusCode } = await http1makeRequest(apiUrl, {
                    method: 'GET'
                });
                if (statusCode === 200 &&
                    apiBody?.status !== 'not found' &&
                    apiBody?.Original?.Subtitle) {
                    const lines = parseSubtitle(apiBody.Original.Subtitle);
                    if (lines.length) {
                        return {
                            loadType: 'lyrics',
                            data: {
                                name: omq?.Name || trackInfo.title,
                                synced: true,
                                language: {
                                    requested: null,
                                    resolved: originalLang,
                                    type: 'original'
                                },
                                lines
                            }
                        };
                    }
                }
            }
            const plainLines = extractLyricOriginal(html);
            if (!plainLines || plainLines.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            return {
                loadType: 'lyrics',
                data: {
                    name: omq?.Name || trackInfo.title,
                    synced: false,
                    language: {
                        requested: null,
                        resolved: originalLang,
                        type: 'original'
                    },
                    lines: plainLines.map((text) => ({ text, time: 0, duration: 0 }))
                }
            };
        }
        catch (e) {
            logger('error', 'Lyrics', `Letras lyrics error: ${e.message}`);
            return {
                loadType: 'error',
                data: { message: e.message, severity: 'fault' }
            };
        }
    }
}
