import { encodeTrack, http1makeRequest, logger } from '../utils.js'

const API_BASE = 'https://api.music.apple.com/v1'
const MAX_PAGE_ITEMS = 300
const DURATION_TOLERANCE = 0.15
const BATCH_SIZE_DEFAULT = 5

export default class AppleMusicSource {
    constructor(nodelink) {
        this.nodelink = nodelink
        this.config = nodelink.options
        this.searchTerms = ['amsearch']

        this.patterns = [
            /https?:\/\/(?:www\.)?music\.apple\.com\/(?:[a-zA-Z]{2}\/)?(album|playlist|artist|song)\/[^/]+\/([a-zA-Z0-9\-.]+)(?:\?i=(\d+))?/
        ]

        this.priority = 95

        this.mediaApiToken = null
        this.tokenOrigin = null
        this.tokenExpiry = null
        this.country = 'US'

        this.playlistPageLimit = 0
        this.albumPageLimit = 0
        this.playlistPageLoadConcurrency = BATCH_SIZE_DEFAULT
        this.albumPageLoadConcurrency = BATCH_SIZE_DEFAULT

        this.allowExplicit = true

        this.tokenInitialized = false
        this.settingUp = false
    }


    async setup() {
        if (this.tokenInitialized && this._isTokenValid()) return true

        if (this.settingUp) return true
        this.settingUp = true

        try {
            const cfg = this.config.sources?.applemusic
            if (!cfg) {
                logger('error', 'AppleMusic', 'Missing config.sources.applemusic')
                return false
            }

            this.mediaApiToken = cfg.mediaApiToken
            this.country = cfg.market || 'US'

            this.playlistPageLimit = cfg.playlistLoadLimit ?? 0
            this.albumPageLimit = cfg.albumLoadLimit ?? 0
            this.playlistPageLoadConcurrency = cfg.playlistPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
            this.albumPageLoadConcurrency = cfg.albumPageLoadConcurrency ?? BATCH_SIZE_DEFAULT
            this.allowExplicit = cfg.allowExplicit ?? true

            if (!this.mediaApiToken) {
                logger('error', 'AppleMusic', 'mediaApiToken missing')
                return false
            }

            this._parseToken(this.mediaApiToken)

            if (this.tokenExpiry && !this._isTokenValid()) {
                logger(
                    'error',
                    'AppleMusic',
                    `Token expired (expiresAt: ${new Date(this.tokenExpiry).toISOString()}).`
                );
                this.tokenInitialized = false;
                return false;
            }

            this.tokenInitialized = true;

            logger(
                'info',
                'AppleMusic',
                `Token initialized (origin: ${this.tokenOrigin || 'none'}, expiresAt: ${this.tokenExpiry ? new Date(this.tokenExpiry).toISOString() : 'none'
                })`
            );


            return true
        } catch (e) {
            logger('error', 'AppleMusic', `setup() error: ${e.message}`)
            return false
        } finally {
            this.settingUp = false
        }
    }

    _isTokenValid() {
        if (!this.tokenExpiry) return true
        return Date.now() < (this.tokenExpiry - 10000)
    }

    _parseToken(token) {
        try {
            const parts = token.split('.')
            if (parts.length < 2) return

            const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
            const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)
            const json = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))

            this.tokenOrigin = json.root_https_origin || null
            this.tokenExpiry = json.exp ? json.exp * 1000 : null
        } catch {
            this.tokenOrigin = null
            this.tokenExpiry = null
        }
    }


    async _apiRequest(path) {
        if (!this.tokenInitialized || !this._isTokenValid()) {
            const ok = await this.setup()
            if (!ok) throw new Error('AppleMusic token unavailable')
        }

        const url = path.startsWith('http') ? path : `${API_BASE}${path}`
        try {
            const { body, statusCode } = await http1makeRequest(url, {
                headers: {
                    Authorization: `Bearer ${this.mediaApiToken}`,
                    Accept: 'application/json',
                    Origin: this.tokenOrigin ? `https://${this.tokenOrigin}` : undefined
                }
            })

            if (statusCode === 401) {
                this.tokenInitialized = false
                await this.setup()
                return this._apiRequest(path)
            }

            if (statusCode < 200 || statusCode >= 300) {
                logger('error', 'AppleMusic', `API error ${statusCode} for ${url}`)
                return null
            }

            return body
        } catch (e) {
            logger('error', 'AppleMusic', `apiRequest error: ${e.message}`)
            return null
        }
    }


    _buildTrack(item, artworkOverride = null) {
        if (!item?.id) return null

        const a = item.attributes || {}
        const artwork = artworkOverride || this._parseArtwork(a.artwork)

        const info = {
            identifier: item.id,
            isSeekable: true,
            author: a.artistName || 'Unknown',
            length: a.durationInMillis ?? 0,
            isStream: false,
            position: 0,
            title: a.name || 'Unknown',
            uri: a.url || '',
            artworkUrl: artwork,
            isrc: a.isrc || null,
            sourceName: 'applemusic',
            explicit: (a.contentRating === 'explicit')
        }

        return {
            encoded: encodeTrack(info),
            info,
            pluginInfo: {}
        }
    }

    _parseArtwork(art) {
        if (!art?.url) return null
        return art.url.replace('{w}', art.width).replace('{h}', art.height)
    }


    async search(query) {
        try {
            const limit = this.config.maxSearchResults || 10
            const q = encodeURIComponent(query)
            const data = await this._apiRequest(
                `/catalog/${this.country}/search?term=${q}&limit=${limit}&types=songs&extend=artistUrl`
            )

            const songs = data?.results?.songs?.data || []
            if (!songs.length) return { loadType: 'empty', data: {} }

            const tracks = songs.map(x => this._buildTrack(x)).filter(Boolean)
            return { loadType: 'search', data: tracks }
        } catch (e) {
            return { exception: { message: e.message, severity: 'fault' } }
        }
    }


    async resolve(url) {
        try {
            const m = this.patterns[0].exec(url)
            if (!m) return { loadType: 'empty', data: {} }

            const type = m[1]
            const id = m[2]
            const altTrackId = m[3]

            switch (type) {
                case 'song':
                    return await this._resolveTrack(id)

                case 'album':
                    return altTrackId ? await this._resolveTrack(altTrackId) : await this._resolveAlbum(id)

                case 'playlist':
                    return await this._resolvePlaylist(id)

                case 'artist':
                    return await this._resolveArtist(id)
            }
        } catch (e) {
            return { exception: { message: e.message, severity: 'fault' } }
        }
    }

    async _resolveTrack(id) {
        const data = await this._apiRequest(`/catalog/${this.country}/songs/${id}?extend=artistUrl`)
        if (!data?.data?.[0]) {
            return { exception: { message: 'Track not found.', severity: 'common' } }
        }

        return { loadType: 'track', data: this._buildTrack(data.data[0]) }
    }

    async _resolveAlbum(id) {
        const albumData = await this._apiRequest(`/catalog/${this.country}/albums/${id}?extend=artistUrl`)
        if (!albumData?.data?.[0]) {
            return { exception: { message: 'Album not found.', severity: 'common' } }
        }

        const album = albumData.data[0]
        const baseTracks = album.relationships?.tracks?.data || []

        const total = album.relationships?.tracks?.meta?.total || baseTracks.length
        const extra = await this._paginate(`/catalog/${this.country}/albums/${id}/tracks`, total, this.albumPageLimit)

        const all = [...baseTracks, ...extra]

        const artwork = this._parseArtwork(album.attributes?.artwork)

        const tracks = all.map(i => this._buildTrack(
            { id: i.id, attributes: { ...i.attributes, artwork: album.attributes.artwork } },
            artwork
        )).filter(Boolean)

        return {
            loadType: 'playlist',
            data: {
                info: { name: album.attributes.name, selectedTrack: 0 },
                tracks
            }
        }
    }

    async _resolvePlaylist(id) {
        const p = await this._apiRequest(`/catalog/${this.country}/playlists/${id}`)
        if (!p?.data?.[0]) {
            return { exception: { message: 'Playlist not found.', severity: 'common' } }
        }

        const playlist = p.data[0]
        const baseTracks = playlist.relationships?.tracks?.data || []

        const total = playlist.relationships?.tracks?.meta?.total || baseTracks.length
        const extra = await this._paginate(
            `/catalog/${this.country}/playlists/${id}/tracks?extend=artistUrl`,
            total,
            this.playlistPageLimit
        )

        const all = [...baseTracks, ...extra]

        const artwork = this._parseArtwork(playlist.attributes.artwork)

        const tracks = all.map(i => this._buildTrack(i, artwork)).filter(Boolean)

        return {
            loadType: 'playlist',
            data: {
                info: { name: playlist.attributes.name, selectedTrack: 0 },
                tracks
            }
        }
    }

    async _resolveArtist(id) {
        const top = await this._apiRequest(`/catalog/${this.country}/artists/${id}/view/top-songs`)
        if (!top?.data) {
            return { exception: { message: 'Artist not found.', severity: 'common' } }
        }

        const artistInfo = await this._apiRequest(`/catalog/${this.country}/artists/${id}`)
        const artist = artistInfo?.data?.[0]?.attributes?.name || 'Artist'
        const artwork = this._parseArtwork(artistInfo?.data?.[0]?.attributes?.artwork)

        const tracks = top.data.map(t => this._buildTrack(t, artwork)).filter(Boolean)

        return {
            loadType: 'playlist',
            data: {
                info: { name: `${artist}'s Top Tracks`, selectedTrack: 0 },
                tracks
            }
        }
    }

    async _paginate(basePath, totalItems, maxPages) {
        const results = []
        const pages = Math.ceil(totalItems / MAX_PAGE_ITEMS)

        let allowed = pages
        if (maxPages > 0) allowed = Math.min(pages, maxPages)

        for (let i = 1; i < allowed; i++) {
            const offset = i * MAX_PAGE_ITEMS
            const path =
                `${basePath}${basePath.includes('?') ? '&' : '?'}limit=${MAX_PAGE_ITEMS}&offset=${offset}`

            const page = await this._apiRequest(path)
            if (page?.data) results.push(...page.data)
        }

        return results
    }

    async getTrackUrl(decodedTrack) {
        const isExplicit = decodedTrack.explicit === true
        const duration = decodedTrack.length

        const query = this._buildSearchQuery(decodedTrack, isExplicit)

        try {
            const res = await this.nodelink.sources.searchWithDefault(query)
            if (res.loadType !== 'search' || res.data.length === 0) {
                return { exception: { message: 'No alternative found.', severity: 'fault' } }
            }

            const best = this._findBestMatch(res.data, duration, decodedTrack)
            if (!best) {
                return { exception: { message: 'No suitable match.', severity: 'fault' } }
            }

            const stream = await this.nodelink.sources.getTrackUrl(best.info)
            return { newTrack: best, ...stream }
        } catch (e) {
            return { exception: { message: e.message, severity: 'fault' } }
        }
    }

    _buildSearchQuery(track, isExplicit) {
        let s = `${track.title} ${track.author}`
        if (isExplicit) {
            s += this.allowExplicit ? ' explicit lyrical video' : ' non explicit lyrical video'
        }
        return s
    }

    _findBestMatch(list, target, original) {
        const allowed = target * DURATION_TOLERANCE
        let best = null
        let bestScore = Infinity

        for (const item of list) {
            const dur = item.info.length
            const diff = Math.abs(dur - target)
            if (diff > allowed) continue

            const tSim = this._sim(this._norm(original.title), this._norm(item.info.title))
            const aSim = this._sim(this._norm(original.author), this._norm(item.info.author))

            const score = diff * 0.5 + (1 - tSim) * target * 0.3 + (1 - aSim) * target * 0.2
            if (score < bestScore) {
                bestScore = score
                best = item
            }
        }

        return best
    }

    _norm(t) {
        if (!t) return ''
        return t.toLowerCase().replace(/[^\w\s]/g, '').trim()
    }

    _sim(a, b) {
        if (!a.length && !b.length) return 1
        const l = a.length > b.length ? a : b
        const s = a.length > b.length ? b : a
        const dist = this._lev(a, b)
        return (l.length - dist) / l.length
    }

    _lev(a, b) {
        const m = []
        for (let i = 0; i <= b.length; i++) m[i] = [i]
        for (let j = 0; j <= a.length; j++) m[0][j] = j

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                m[i][j] =
                    a[j - 1] === b[i - 1]
                        ? m[i - 1][j - 1]
                        : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1)
            }
        }

        return m[b.length][a.length]
    }
}
