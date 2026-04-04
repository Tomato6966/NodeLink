/**
 * SoundCloud Source Type Definitions
 * Shared types for SoundCloud data processing and API interactions.
 *
 * @packageDocumentation
 * @module SoundCloudTypes
 */
/**
 * Mapping of search type aliases to canonical types.
 *
 * Supports various user-facing aliases (e.g., 'sounds', 'music', 'set')
 * and normalizes them to API-compatible types.
 *
 * @example
 * ```typescript
 * const type = SEARCH_TYPE_MAP['sounds']; // 'tracks'
 * const type2 = SEARCH_TYPE_MAP['artists']; // 'users'
 * ```
 *
 * @public
 */
export const SEARCH_TYPE_MAP = {
    track: 'tracks',
    tracks: 'tracks',
    sounds: 'tracks',
    sound: 'tracks',
    user: 'users',
    users: 'users',
    people: 'users',
    artist: 'users',
    artists: 'users',
    album: 'albums',
    albums: 'albums',
    playlist: 'playlists',
    playlists: 'playlists',
    set: 'playlists',
    sets: 'playlists',
    all: 'all',
    everything: 'all'
};
