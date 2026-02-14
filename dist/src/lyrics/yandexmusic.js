import crypto from 'node:crypto';
import { http1makeRequest, logger } from "../utils.js";
const API_BASE = 'https://api.music.yandex.net';
const USER_AGENT = 'Yandex-Music-API';
const CLIENT_HEADER = 'YandexMusicAndroid/24023621';
const ANDROID_SIGN_KEY = 'p93jhgh689SBReK6ghtw62';
export default class YandexMusicLyrics {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.accessToken = null;
    }
    async setup() {
        this.accessToken =
            this.nodelink.options.lyrics?.yandexmusic?.accessToken ||
                this.nodelink.options.sources?.yandexmusic?.accessToken ||
                this.nodelink.credentialManager.get('yandexmusic_access_token') ||
                null;
        if (!this.accessToken) {
            logger('warn', 'Lyrics', 'Yandex Music lyrics disabled (no token).');
            return false;
        }
        return true;
    }
    async getLyrics(trackInfo) {
        if (!trackInfo?.identifier || !this.accessToken) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { sign, timestamp } = this._createSign(trackInfo.identifier);
            const url = new URL(`${API_BASE}/tracks/${trackInfo.identifier}/lyrics`);
            url.searchParams.set('format', 'LRC');
            url.searchParams.set('timeStamp', String(timestamp));
            url.searchParams.set('sign', sign);
            const { statusCode, body } = await http1makeRequest(url.toString(), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `OAuth ${this.accessToken}`,
                    'User-Agent': USER_AGENT,
                    'X-Yandex-Music-Client': CLIENT_HEADER
                },
                localAddress: this.nodelink.routePlanner?.getIP()
            });
            if (statusCode !== 200 || body?.error) {
                return { loadType: 'empty', data: {} };
            }
            const downloadUrl = body?.result?.downloadUrl;
            if (!downloadUrl)
                return { loadType: 'empty', data: {} };
            const lrcText = await this._fetchText(downloadUrl);
            const lines = this._parseLrc(lrcText);
            if (lines.length === 0)
                return { loadType: 'empty', data: {} };
            return {
                loadType: 'lyrics',
                data: {
                    name: trackInfo.title || 'Unknown',
                    synced: true,
                    lines
                }
            };
        }
        catch (e) {
            logger('error', 'Lyrics', `Yandex Music lyrics error: ${e.message}`);
            return {
                loadType: 'error',
                data: { message: e.message, severity: 'fault' }
            };
        }
    }
    _createSign(trackId) {
        const timestamp = Math.floor(Date.now() / 1000);
        const message = `${trackId}${timestamp}`;
        const hmac = crypto.createHmac('sha256', ANDROID_SIGN_KEY);
        const sign = encodeURIComponent(hmac.update(message).digest('base64'));
        return { sign, timestamp };
    }
    async _fetchText(url) {
        const { statusCode, body } = await http1makeRequest(url, {
            method: 'GET',
            headers: { Authorization: `OAuth ${this.accessToken}` },
            localAddress: this.nodelink.routePlanner?.getIP()
        });
        if (statusCode !== 200)
            throw new Error(`HTTP ${statusCode} on ${url}`);
        return typeof body === 'string' ? body : String(body);
    }
    _parseLrc(lrc) {
        const lines = [];
        const regex = /\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.*?)(?=\n|\[|$)/g;
        let match;
        while ((match = regex.exec(lrc)) !== null) {
            const minutes = Number(match[1]);
            const seconds = Number(match[2]);
            const centiseconds = Number(match[3]);
            const time = (minutes * 60 + seconds) * 1000 + centiseconds * 10;
            const text = (match[4] || '').trim();
            if (!text)
                continue;
            lines.push({ text, time, duration: 0 });
        }
        return lines;
    }
}
