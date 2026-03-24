import { getBestMatch, logger, makeRequest } from "../utils.js";
/**
 * Deezer lyrics provider backed by Deezer GraphQL endpoint.
 * @public
 */
export default class DeezerLyrics {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Cached Deezer JWT token.
     */
    jwt;
    /**
     * JWT expiration timestamp in milliseconds.
     */
    jwtExpiry;
    /**
     * Creates a new Deezer lyrics provider.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.jwt = null;
        this.jwtExpiry = 0;
    }
    /**
     * Initializes provider resources.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Retrieves and caches Deezer JWT used by lyrics endpoint.
     * @returns JWT token or null when unavailable.
     * @internal
     */
    async _getJwt() {
        if (this.jwt && Date.now() < this.jwtExpiry)
            return this.jwt;
        try {
            const { body, error } = await makeRequest('https://auth.deezer.com/login/anonymous?jo=p&rto=c', { method: 'GET' });
            if (error)
                throw new Error('Request failed');
            const data = typeof body === 'string'
                ? JSON.parse(body)
                : body;
            if (!data?.jwt)
                throw new Error('No JWT in response');
            this.jwt = data.jwt;
            this.jwtExpiry = Date.now() + 300000;
            return this.jwt;
        }
        catch (e) {
            logger('error', 'Lyrics', `Deezer JWT fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
    /**
     * Loads lyrics for a track.
     * @param trackInfo - Track metadata from manager.
     * @returns Lyrics payload or empty result.
     */
    async getLyrics(trackInfo) {
        const jwt = await this._getJwt();
        if (!jwt)
            return { loadType: 'empty', data: {} };
        let trackId = trackInfo.identifier;
        if (trackInfo.sourceName !== 'deezer') {
            const query = `${trackInfo.title} ${trackInfo.author}`;
            const searchRes = await this.nodelink.sources.search('deezer', query);
            const searchData = searchRes.data;
            if (searchRes.loadType !== 'search' ||
                !Array.isArray(searchData) ||
                searchData.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const candidates = searchData;
            const bestMatch = getBestMatch(candidates, trackInfo);
            if (!bestMatch)
                return { loadType: 'empty', data: {} };
            const matchedCandidate = bestMatch;
            trackId = matchedCandidate.info.identifier;
        }
        try {
            const query = `query GetLyrics($trackId: String!) {
  track(trackId: $trackId) {
    id
    lyrics {
      id
      text
      ...SynchronizedWordByWordLines
      ...SynchronizedLines
      licence
      copyright
      writers
      __typename
    }
    __typename
  }
}

fragment SynchronizedWordByWordLines on Lyrics {
  id
  synchronizedWordByWordLines {
    start
    end
    words {
      start
      end
      word
      __typename
    }
    __typename
  }
  __typename
}

fragment SynchronizedLines on Lyrics {
  id
  synchronizedLines {
    lrcTimestamp
    line
    lineTranslated
    milliseconds
    duration
    __typename
  }
  __typename
}`;
            const res = await makeRequest('https://pipe.deezer.com/api', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                body: {
                    operationName: 'GetLyrics',
                    variables: { trackId: String(trackId) },
                    query
                },
                disableBodyCompression: true
            });
            const data = typeof res.body === 'string'
                ? JSON.parse(res.body)
                : res.body;
            const lyrics = data?.data?.track?.lyrics;
            if (res.error || !lyrics)
                return { loadType: 'empty', data: {} };
            let lines = [];
            let synced = false;
            if (lyrics.synchronizedWordByWordLines?.length) {
                synced = true;
                lines = lyrics.synchronizedWordByWordLines.map((line) => ({
                    time: line.start,
                    duration: line.end - line.start,
                    text: line.words.map((w) => w.word).join(' '),
                    words: line.words.map((w) => ({
                        text: w.word,
                        timestamp: w.start,
                        duration: w.end - w.start
                    }))
                }));
            }
            else if (lyrics.synchronizedLines?.length) {
                synced = true;
                lines = lyrics.synchronizedLines.map((line) => ({
                    time: line.milliseconds,
                    duration: line.duration,
                    text: line.line
                }));
            }
            else if (lyrics.text) {
                lines = lyrics.text
                    .split(/\r?\n/)
                    .map((text) => ({ time: 0, duration: 0, text: text.trim() }))
                    .filter((line) => line.text.length > 0);
            }
            return {
                loadType: 'lyrics',
                data: {
                    name: trackInfo.title,
                    synced,
                    lines
                }
            };
        }
        catch (e) {
            logger('error', 'Lyrics', `Deezer lyrics request failed: ${e instanceof Error ? e.message : String(e)}`);
            return { loadType: 'empty', data: {} };
        }
    }
}
