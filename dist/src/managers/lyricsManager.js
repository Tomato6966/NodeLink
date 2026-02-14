var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignLyrics } from '../modules/lyricsAligner.js';
import { logger } from "../utils.js";
export default class LyricsManager {
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.lyricsSources = new Map();
    }
    async loadFolder() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const lyricsDir = path.join(__dirname, '../lyrics');
        this.lyricsSources.clear();
        try {
            await fs.access(lyricsDir);
            const files = await fs.readdir(lyricsDir);
            const jsFiles = files.filter((f) => f.endsWith('.js'));
            const toLoad = jsFiles.filter((f) => {
                const name = path.basename(f, '.js');
                return !!this.nodelink.options.lyrics?.[name]?.enabled;
            });
            await Promise.all(toLoad.map(async (file) => {
                const name = path.basename(file, '.js');
                const filePath = path.join(lyricsDir, file);
                const fileUrl = new URL(`file://${filePath}`);
                const Mod = (await import(__rewriteRelativeImportExtension(fileUrl))).default;
                const instance = new Mod(this.nodelink);
                if (await instance.setup()) {
                    this.lyricsSources.set(name, instance);
                    logger('info', 'Lyrics', `Loaded lyrics source: ${name}`);
                }
                else {
                    logger('error', 'Lyrics', `Failed setup for lyrics source: ${name}; source not available.`);
                }
            }));
        }
        catch {
            logger('info', 'Lyrics', `Lyrics directory not found, creating at: ${lyricsDir}`);
            await fs.mkdir(lyricsDir, { recursive: true });
        }
    }
    async loadLyrics(decodedTrack, language, skipTrackSource = false) {
        if (!decodedTrack ||
            !decodedTrack.info?.sourceName ||
            !decodedTrack.info?.uri) {
            logger('warn', 'Lyrics', 'Invalid track object provided to loadLyrics', decodedTrack);
            return {
                loadType: 'error',
                data: { message: 'Invalid track object provided.', severity: 'common' }
            };
        }
        logger('debug', 'Lyrics', `Loading lyrics for track: ${decodedTrack.info.title}`);
        const reliableTrackData = await this.nodelink.sources.resolve(decodedTrack.info.uri);
        if (reliableTrackData.loadType !== 'track') {
            logger('warn', 'Lyrics', `Could not re-fetch track information for ${decodedTrack.info.title}`);
            return {
                loadType: 'error',
                data: {
                    message: 'Could not re-fetch track information before loading lyrics.',
                    severity: 'fault'
                }
            };
        }
        const trackInfo = reliableTrackData.data?.info || reliableTrackData.data;
        const sourceName = trackInfo?.sourceName;
        const lyricsSource = this.lyricsSources.get(sourceName);
        const isYouTube = sourceName === 'youtube' || sourceName === 'ytmusic';
        let youtubeCaptions = null;
        if (lyricsSource && !skipTrackSource) {
            if (isYouTube) {
                try {
                    const result = await lyricsSource.getLyrics(trackInfo, language);
                    if (result && result.loadType === 'lyrics') {
                        youtubeCaptions = result;
                    }
                }
                catch (e) {
                    logger('warn', 'Lyrics', `Failed to fetch YouTube captions for alignment: ${e.message}`);
                }
            }
            else {
                const lyrics = await lyricsSource.getLyrics(trackInfo, language);
                if (lyrics && lyrics.loadType !== 'empty') {
                    lyrics.data.provider = sourceName;
                    return lyrics;
                }
            }
        }
        for (const [name, source] of this.lyricsSources) {
            if (name === sourceName)
                continue;
            logger('debug', 'Lyrics', `Trying lyrics source ${name} for ${trackInfo?.title || 'Unknown Title'}.`);
            const lyrics = await source.getLyrics(trackInfo, language);
            if (lyrics && lyrics.loadType !== 'empty') {
                if (isYouTube && youtubeCaptions && lyrics.data.synced) {
                    try {
                        logger('debug', 'Lyrics', `Aligning ${name} lyrics with YouTube timing...`);
                        const alignedLines = alignLyrics(lyrics.data.lines, youtubeCaptions.data);
                        lyrics.data.lines = alignedLines;
                    }
                    catch (alignErr) {
                        logger('warn', 'Lyrics', `Failed to align lyrics: ${alignErr.message}`);
                    }
                }
                lyrics.data.provider = name;
                return lyrics;
            }
        }
        if (isYouTube && youtubeCaptions) {
            youtubeCaptions.data.provider = sourceName;
            return youtubeCaptions;
        }
        logger('debug', 'Lyrics', `No lyrics found for ${trackInfo?.title || 'Unknown Track'}`);
        return { loadType: 'empty', data: {} };
    }
}
