import { logger, makeRequest } from "../../../utils.js";
import { BaseClient, checkURLType, YOUTUBE_CONSTANTS } from '../common.js';
export default class TV extends BaseClient {
    constructor(nodelink, oauth) {
        super(nodelink, 'TVHTML5_CAST', oauth);
    }
    getClient(context) {
        return {
            client: {
                clientName: 'TVHTML5_CAST',
                clientVersion: '7.20190924',
                userAgent: 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 CrKey/1.54.248666',
                hl: context.client.hl,
                gl: context.client.gl,
                visitorData: context.client.visitorData
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    requirePlayerScript() {
        return true;
    }
    async getAuthHeaders() {
        // this client does not work with oauth, does not require it to function, because the audio is beign casted (prob)
        return {};
    }
    async resolve(url, _type, context, cipherManager) {
        const sourceName = 'youtube';
        const urlType = checkURLType(url, 'youtube');
        const apiEndpoint = this.getApiEndpoint();
        switch (urlType) {
            case YOUTUBE_CONSTANTS.VIDEO:
            case YOUTUBE_CONSTANTS.SHORTS: {
                const idPattern = /(?:v=|\/shorts\/|youtu\.be\/)([^&?]+)/;
                const videoIdMatch = url.match(idPattern);
                if (!videoIdMatch || !videoIdMatch[1]) {
                    logger('error', 'YouTube-TVCast', `Could not parse video ID from URL: ${url}`);
                    return {
                        exception: {
                            message: 'Invalid video URL.',
                            severity: 'common',
                            cause: 'Input'
                        }
                    };
                }
                const videoId = videoIdMatch[1];
                const headers = await this.getAuthHeaders();
                const { body: playerResponse, statusCode } = await this._makePlayerRequest(videoId, context, headers, cipherManager);
                if (statusCode !== 200) {
                    const message = `Failed to load video/short player data. Status: ${statusCode}`;
                    logger('error', 'YouTube-TVCast', message);
                    return {
                        exception: { message, severity: 'common', cause: 'Upstream' }
                    };
                }
                return await this._handlePlayerResponse(playerResponse, sourceName, videoId);
            }
            case YOUTUBE_CONSTANTS.PLAYLIST: {
                const playlistIdMatch = url.match(/[?&]list=([\w-]+)/);
                if (!playlistIdMatch || !playlistIdMatch[1]) {
                    logger('error', 'YouTube-TVCast', `Could not parse playlist ID from URL: ${url}`);
                    return {
                        exception: {
                            message: 'Invalid playlist URL.',
                            severity: 'common',
                            cause: 'Input'
                        }
                    };
                }
                const playlistId = playlistIdMatch[1];
                const videoIdMatch = url.match(/[?&]v=([\w-]+)/);
                const currentVideoId = videoIdMatch?.[1] ?? null;
                const requestBody = {
                    context: this.getClient(context),
                    playlistId,
                    contentCheckOk: true,
                    racyCheckOk: true
                };
                if (playlistId.startsWith('RD') && currentVideoId) {
                    requestBody.videoId = currentVideoId;
                }
                const { body: playlistResponse, statusCode } = await makeRequest(`${apiEndpoint}/youtubei/v1/next`, {
                    headers: { 'User-Agent': this.getClient(context).client.userAgent },
                    body: requestBody,
                    method: 'POST',
                    disableBodyCompression: true,
                    proxy: this.getProxy()
                });
                if (statusCode !== 200) {
                    const errMsg = `Failed to fetch playlist. Status: ${statusCode}`;
                    logger('error', 'YouTube-TV', `Error loading playlist ${playlistId}: ${errMsg}`);
                    return {
                        exception: {
                            message: errMsg,
                            severity: 'common',
                            cause: 'Upstream'
                        }
                    };
                }
                return await this._handlePlaylistResponse(playlistId, currentVideoId, playlistResponse, sourceName, context);
            }
            default:
                return { loadType: 'empty', data: {} };
        }
    }
    async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
        const sourceName = decodedTrack.sourceName || 'youtube';
        logger('debug', 'YouTube-TVCast', `Getting stream URL for: ${decodedTrack.title} (ID: ${decodedTrack.identifier}) on ${sourceName}`);
        const headers = await this.getAuthHeaders();
        const { body: playerResponse, statusCode } = await this._makePlayerRequest(decodedTrack.identifier, context, headers, cipherManager, proxy);
        if (statusCode !== 200) {
            const message = `Failed to get player data for stream. Status: ${statusCode}`;
            logger('error', 'YouTube-TVCast', message);
            return { exception: { message, severity: 'common', cause: 'Upstream' } };
        }
        return await this._extractStreamData(playerResponse, decodedTrack, context, cipherManager, itag);
    }
}
