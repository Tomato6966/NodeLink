# API Documentation - NodeLink Additions & Differences

This document outlines the differences and additions in the NodeLink API compared to the standard Lavalink API (v4). It is not a complete API reference. For the base API specification, please refer to the official [Lavalink REST API documentation](https://lavalink.dev/api/rest).

---

## General API Changes

### Authorization
While the Lavalink specification requires an `Authorization` header, NodeLink strictly enforces this for **all** HTTP REST endpoints, not just WebSocket connections. Requests without a valid password will be rejected with a `401 Unauthorized` status.

### Error Responses
The `trace` field, containing a stack trace, is **always included** in error responses, even without the `?trace=true` query parameter. This helps in faster debugging.

### Source Mirroring
For sources that do not provide direct audio streams (e.g., Spotify, Tidal), NodeLink will attempt to find a matching track on a streamable source (like YouTube) and play it instead. This process is automatic.

### WebSocket Connections
NodeLink requires the following headers to establish a WebSocket connection to `/v4/websocket`. This is stricter than some Lavalink clients might expect.

| Header Name     | Description                                                                                    |
|-----------------|------------------------------------------------------------------------------------------------|
| `Authorization` | The password configured on the server.                                                         |
| `User-Id`       | The user ID of your bot.                                                                       |
| `Client-Name`   | A name for your client, ideally in `Name/Version` format (e.g., `MyClient/1.2.3`).               |
| `Session-Id`?   | The ID of a previous session to resume.                                                        |

Connections with missing or improperly formatted headers will be rejected.

---

## Endpoint Differences & Additions

### `/info`
The `/v4/info` payload is mostly compatible with Lavalink, with the following key differences:
- `jvm`: This field is replaced by `node`, containing the Node.js version.
- `lavaplayer`: This field will always be `"n/a (Node.js)"`.
- `voice`: A new object is added, containing information about the underlying voice engine (e.g., `@performanc/voice`).

### `/stats`
The `/v4/stats` payload has two distinctions:
- `frameStats`: This object is **never null**. If there are no active players, its fields will all be `0`.
- `detailedStats`: NodeLink adds this new object, which contains a granular breakdown of internal statistics for advanced monitoring.
  - `api`: Object containing API request and error counts per endpoint.
    - `requests`: `{ "/v4/loadtracks": 120, ... }`
    - `errors`: `{ "/v4/loadtracks": 5, ... }`
  - `sources`: Object containing success and failure counts per source.
    - `youtube`: `{ "success": 1000, "failure": 50 }`
    - `soundcloud`: `{ "success": 200, "failure": 10 }`
  - `playback`: Object containing counts for playback-related WebSocket events.
    - `events`: `{ "TrackStartEvent": 500, "TrackEndEvent": 498, ... }`

### `/loadtracks`
The `/loadtracks` endpoint can return additional `loadType` values:
- **`album`**: For a collection of tracks from an album.
- **`artist`**: For a collection of tracks from an artist.
These behave identically to the `playlist` load type.

#### Search Prefixes
To perform a search with a specific source, you can prefix your identifier in the `/loadtracks` endpoint. If no prefix is used, the default search source configured on the server will be used.

| Prefix      | Source        | Description                               |
|-------------|---------------|-------------------------------------------|
| `ytsearch:` | YouTube       | Searches on YouTube.                      |
| `ytmsearch:`| YouTube Music | Searches on YouTube Music.                |
| `scsearch:` | SoundCloud    | Searches on SoundCloud.                   |
| `dzsearch:` | Deezer        | Searches on Deezer.                       |
| `spsearch:` | Spotify       | Searches on Spotify.                      |
| `tdsearch:` | Tidal         | Searches on Tidal.                        |
| `bcsearch:` | Bandcamp      | Searches on Bandcamp.                     |
| `ncsearch:` | NicoNico      | Searches on NicoNico Douga.               |
| `gtts:`     | Google TTS    | Converts text to speech using Google.     |
| `local:`    | Local Files   | Searches for a local file on the server.  |
| `file:`     | Local Files   | Alias for `local:`.                       |

> [!NOTE]
> Using a search prefix for a source that is disabled on the server will result in an error.

#### HoloTrack Structure

NodeLink uses an enhanced track structure called **HoloTrack** that extends the standard Lavalink track format with rich metadata. The response structure varies by load type to optimize performance.

**Load Types:**
- **`track`**: Single track with full metadata (most detailed)
- **`search`**: Collection of tracks with basic metadata (performance-optimized)
- **`playlist`**: Collection with playlist info (performance-optimized)
- **`album`**: Collection from an album (behaves like playlist)
- **`artist`**: Collection from an artist (behaves like playlist)
- **`empty`**: No results found
- **`error`**: An error occurred

**Track Object (Full Metadata - `loadType: "track"`):**

```typescript
{
  loadType: "track",
  data: {
    // Required fields
    encoded: string,              // Base64 encoded track data
    title: string,                // Track title
    author: string,               // Track author/artist
    isHolo: boolean,              // Always true for NodeLink
    isVanilla: boolean,           // Always false for NodeLink
    accessibility: string,        // Screen reader friendly description
    
    // Optional fields (may be null or omitted)
    description?: string,         // Track description
    keywords?: string[],          // Associated keywords
    externalLinks?: object,       // External platform links
    
    details: {
      isSeekable: boolean,
      isLive: boolean,
      isExplicit: boolean,
      genres: string[],
      publishedAt?: {             // Optional publication date
        original: string,         // e.g., "11 years ago"
        timestamp: number,        // Unix timestamp in ms
        date: string,             // ISO 8601 date
        readable: string,
        compact: string,          // e.g., "4y 2mo 5d"
        ago: {
          years: number,
          months: number,
          weeks: number,
          days: number,
          hours: number,
          minutes: number,
          seconds: number
        }
      } | null
    },
    
    links: {
      source: string,             // Source URL
      preview: string,            // Embeddable preview URL
      artist?: string             // Artist page URL (optional)
    },
    
    ids: {
      internal: string,           // Source-specific ID
      isrc?: string | null        // ISRC code (optional)
    },
    
    duration: {
      ms: number,                 // Milliseconds
      formatted: string,          // e.g., "3:45"
      hms: string                 // e.g., "0h 03m 45s"
    },
    
    thumbnails: {
      default: string,
      medium: string,
      high: string
    },
    
    source: {
      name: string,               // e.g., "youtube", "spotify"
      url: string
    },
    
    // Optional rich metadata (only in full track response)
    artists?: object[],           // Contributing artists
    channel?: {                   // Channel/uploader info
      name: string,
      id: string,
      url: string,
      icon?: string | null,
      subscribers?: {
        original: string,
        count: number,
        formatted: string
      } | null,
      verified: boolean,
      description?: string | null,
      videoCount?: object | null,
      featuredVideo?: object | null,
      links?: string[],
      banner?: string | null
    },
    album?: object | null,        // Album information
    chapters?: object[],          // Video chapters
    stats?: {                     // View/like statistics
      views?: number | null,
      likes?: number | null,
      category?: string | null
    },
    videoQualities?: object[],    // Available video formats
    audioFormats?: object[]       // Available audio formats
  }
}
```

**Search/Playlist Results (Performance-Optimized):**

When `loadType` is `search`, `playlist`, `album`, or `artist`, tracks contain minimal metadata for performance:

```typescript
{
  loadType: "search",  // or "playlist", "album", "artist"
  data: [  // For search
    {
      // Required basic fields
      encoded: string,
      title: string,
      author: string,
      isHolo: boolean,
      isVanilla: boolean,
      accessibility: string,
      
      // Minimal metadata
      description: null,         // Always null
      keywords: [],              // Always empty
      externalLinks: null,       // Always null
      
      details: {
        isSeekable: boolean,
        isLive: boolean,
        isExplicit: boolean,
        genres: [],              // Always empty
        publishedAt: object | null
      },
      
      links: { source: string, preview: string, artist?: string },
      ids: { internal: string, isrc: null },
      duration: object,
      thumbnails: object,
      source: object,
      
      // Minimal optional fields
      artists: [],
      channel: object | null,    // Basic info only
      album: null,
      chapters: [],
      stats: object | null,      // May include views
      videoQualities: [],
      audioFormats: []
    }
  ]
}
```

For `playlist`, `album`, and `artist` responses:
```typescript
{
  loadType: "playlist",  // or "album" or "artist"
  data: {
    info: {
      name: string,              // Playlist/album/artist name
      selectedTrack: number      // Usually 0
    },
    pluginInfo: object,
    tracks: [
      // Array of tracks with minimal metadata (same as search)
    ]
  }
}
```

**Optional Fields Summary:**

The following fields may be `null` or omitted depending on the source and load type:
- Top-level: `description`, `keywords`, `externalLinks`, `artists`, `channel`, `album`, `chapters`, `stats`, `videoQualities`, `audioFormats`
- In `details`: `publishedAt`
- In `links`: `artist`
- In `ids`: `isrc`
- In `channel`: `icon`, `subscribers`, `description`, `videoCount`, `featuredVideo`, `links`, `banner`
- In `stats`: `views`, `likes`, `category`

**Performance Notes:**
- Use direct track URLs to get full metadata
- Search queries return minimal metadata for faster responses
- Load specific tracks to enrich metadata when needed

### `/routeplanner`
NodeLink includes a fully functional IP route planner, a feature not present in standard Lavalink. The following endpoints are available for managing it:

- `GET /v4/routeplanner/status`: Returns the current status of the route planner.
- `POST /v4/routeplanner/free/address`: Unmarks a specific IP address as failed.
- `POST /v4/routeplanner/free/all`: Clears all failing IP addresses from the planner.

**Status Response Body:**

| Field   | Type     | Description                                                           |
|---------|----------|-----------------------------------------------------------------------|
| class   | ?string  | The name of the RoutePlanner implementation being used.               |
| details | ?object  | The status details of the RoutePlanner.                               |

**Details Object:**

| Field            | Type   | Description                                                                 |
|------------------|--------|-----------------------------------------------------------------------------|
| ipBlock          | object | The ip block being used (`type` and `size`).                                |
| failingAddresses | array  | An array of objects, each detailing a failing address and when it failed.   |
| strategy         | string | The strategy being used for IP rotation (e.g., `RotateOnBan`, `RoundRobin`). |
| currentAddress   | string | The current address being used by the planner.                              |

### `/loadlyrics` (New Endpoint)
`GET /v4/loadlyrics?encodedTrack=<base64>`
A new endpoint to fetch lyrics for a given track.

### `/connection` (New Endpoint)
`GET /v4/connection`
A new endpoint that returns real-time metrics about the server's internet connection quality.

### Additional Encode/Decode Endpoints
In addition to Lavalink's `/encodetrack` and `/decodetracks`, NodeLink provides:
- `GET /v4/decodeTrack`: Decodes a single track string.
- `POST /v4/encodeTracks`: Encodes an array of track objects.

---

## Player API

NodeLink exposes the full Player API via REST. The following objects are used in this section.

### Player Object

| Field   | Type           | Description                                           |
|---------|----------------|-------------------------------------------------------|
| guildId | string         | The guild id of the player                            |
| track   | ?Track object  | The currently playing track                           |
| volume  | int            | The volume of the player, range 0-1000                |
| paused  | bool           | Whether the player is paused                          |
| state   | Player State   | The state of the player                               |
| voice   | Voice State    | The voice state of the player                         |
| filters | Filters object | The filters used by the player                        |

#### Player State

| Field     | Type | Description                                                                              |
|-----------|------|------------------------------------------------------------------------------------------|
| time      | int  | Unix timestamp in milliseconds                                                           |
| position  | int  | The position of the track in milliseconds                                                |
| connected | bool | Whether NodeLink is connected to the voice gateway                                       |
| ping      | int  | The ping of the node to the Discord voice server in milliseconds (`-1` if not connected) |

#### Voice State

| Field     | Type   | Description                                       |
|-----------|--------|---------------------------------------------------|
| token     | string | The Discord voice token to authenticate with      |
| endpoint  | string | The Discord voice endpoint to connect to          |
| sessionId | string | The Discord voice session id to authenticate with |

---

### Get Players

Returns a list of all players in the session.

`GET /v4/sessions/{sessionId}/players`

**Response:** An array of Player objects.

---

### Get Player

Returns the player for a specific guild.

`GET /v4/sessions/{sessionId}/players/{guildId}`

**Response:** A Player object.

---

### Update Player

Updates or creates the player for a guild.

`PATCH /v4/sessions/{sessionId}/players/{guildId}`

**Query Params:**

| Field      | Type | Description                                                                  |
|------------|------|------------------------------------------------------------------------------|
| noReplace? | bool | If `true`, the currently playing track will not be replaced if one is playing. Defaults to `false`. |

**Request Body:**

| Field      | Type   | Description                                                                                   |
|------------|--------|-----------------------------------------------------------------------------------------------|
| track?     | object | An object containing the `encoded` track to play. Set to `null` to stop the current track.    |
| position?  | int    | The track position in milliseconds.                                                           |
| endTime?   | ?int   | The track end time in milliseconds. `null` resets this.                                       |
| volume?    | int    | The player volume, from 0 to 1000.                                                            |
| paused?    | bool   | Whether the player should be paused.                                                          |
| filters?   | object | The new [Filters](#filters) to apply. This overrides all previously applied filters.          |
| voice?     | object | The voice server update information from Discord.                                             |

> [!NOTE]
> Unlike standard Lavalink, NodeLink's update player endpoint does **not** support resolving an `identifier` in the request body. You must provide the base64 `encoded` track.

---

### Destroy Player

Destroys the player for a specific guild.

`DELETE /v4/sessions/{sessionId}/players/{guildId}`

**Response:** `204 No Content` on success.

---

## Session API

### Update Session

Updates the session with the resuming state and timeout.

`PATCH /v4/sessions/{sessionId}`

**Request Body:**

| Field     | Type | Description                                         |
|-----------|------|-----------------------------------------------------|
| resuming? | bool | Whether resuming is enabled for this session or not |
| timeout?  | int  | The timeout in seconds (default is 60s)             |

**Response Body:**

| Field    | Type | Description                                         |
|----------|------|-----------------------------------------------------|
| resuming | bool | The new resuming state for this session.            |
| timeout  | int  | The new timeout in seconds.                         |

---

## WebSocket Event Differences

### `TrackStartEvent`
NodeLink emits this event only when the audio data for the track begins to be processed and sent to Discord, providing a more accurate representation of when audio actually starts playing.

### `TrackStuckEvent`
This event is emitted in NodeLink when a track gets stuck. This can happen if the stream provides no data for a configurable amount of time, or if a recovery attempt fails.

### New Events
NodeLink emits several new events not found in the standard Lavalink specification:

#### `PlayerCreatedEvent`
Emitted when a new player is successfully created.
| Field   | Type   | Description                               |
|---------|--------|-------------------------------------------|
| guildId | string | The ID of the guild where the player was created. |
| player  | object | The initial state of the created player.  |

#### `PlayerDestroyedEvent`
Emitted when a player is destroyed.
| Field   | Type   | Description                               |
|---------|--------|-------------------------------------------|
| guildId | string | The ID of the guild whose player was destroyed. |

#### `PlayerReconnectingEvent`
Emitted when a player's voice connection is attempting to reconnect.
| Field   | Type   | Description                               |
|---------|--------|-------------------------------------------|
| guildId | string | The ID of the guild whose player is reconnecting. |
| voice   | object | The current voice state of the player.    |

#### `PlayerConnectedEvent`
Emitted when a player's voice connection is successfully established.
| Field   | Type   | Description                               |
|---------|--------|-------------------------------------------|
| guildId | string | The ID of the guild whose player connected. |
| voice   | object | The current voice state of the player.    |

#### `WorkerFailedEvent`
(Cluster Mode Only) Emitted when a worker process fails, indicating that its players were destroyed.
| Field          | Type   | Description                               |
|----------------|--------|-------------------------------------------|
| affectedGuilds | array  | The IDs of the guilds whose players were lost. |
| message        | string | A descriptive message about the failure.  |

#### `ConnectionStatusEvent`
Dispatched whenever the server's network quality status changes.
| Field   | Type   | Description                                                                                                |
|---------|--------|------------------------------------------------------------------------------------------------------------|
| status  | string | The new status (`good`, `average`, `bad`, `disconnected`).                                                 |
| metrics | object | An object containing detailed metrics, including `speed` (bps, kbps, mbps), `downloadedBytes`, `durationSeconds`. |

#### `VolumeChangedEvent`
Emitted when a player's volume is changed.
| Field  | Type | Description                       |
|--------|------|-----------------------------------|
| volume | int  | The new volume of the player (0-1000). |

#### `FiltersChangedEvent`
Emitted when a player's audio filters are updated.
| Field   | Type   | Description                      |
|---------|--------|----------------------------------|
| filters | object | The new filters object applied to the player. |

#### `SeekEvent`
Dispatched after a player successfully seeks to a new position.
| Field    | Type | Description                             |
|----------|------|-----------------------------------------|
| position | int  | The new position in the track in milliseconds. |

#### `PauseEvent`
Dispatched when a player's pause state is changed.
| Field  | Type | Description                       |
|--------|------|-----------------------------------|
| paused | bool | The new pause state of the player. |

---


