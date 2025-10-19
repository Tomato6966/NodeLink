# API Documentation

This document outlines the differences and additions in the NodeLink API compared to the standard Lavalink API (v4). While NodeLink aims for full compatibility, it also introduces new features and modifies existing behaviors for performance and enhanced functionality.

For the base API specification, please refer to the official [Lavalink REST API documentation](https://lavalink.dev/api/rest).

## Table of Contents

- [General API Changes](#general-api-changes)
  - [Error Responses](#error-responses)
  - [Compression](#compression)
  - [WebSocket Connection](#websocket-connection)
  - [Session Resuming](#session-resuming)
- [Endpoint Differences](#endpoint-differences)
  - [/info](#info)
  - [/stats](#stats)
  - [/loadtracks](#loadtracks)
  - [/routeplanner](#routeplanner)
- [New Endpoints](#new-endpoints)
  - [/loadlyrics](#loadlyrics)
  - [/encodetrack & /decodetracks](#encodetrack--decodetracks)
  - [/connection](#connection)
- [WebSocket Event Differences](#websocket-event-differences)
  - [TrackStartEvent](#trackstartevent)
  - [TrackStuckEvent](#trackstuckevent)
  - [New Events](#new-events)

---

## General API Changes

### Error Responses

While following the standard Lavalink error structure, NodeLink provides more debugging information by default.

- The `trace` field, containing a stack trace, is **always included** in error responses, even without the `?trace=true` query parameter. This helps in faster debugging of client-side issues.

### Compression

NodeLink supports multiple compression formats for API responses to reduce network bandwidth. The server will automatically use the best available format based on the `Accept-Encoding` header sent by the client.

- **Supported formats:** Brotli, Gzip, Deflate.

> [!NOTE]
> It is highly recommended for clients to support **Brotli** for the best performance.

### WebSocket Connection

To improve server-side analytics and client identification, NodeLink enforces a strict format for the `Client-Name` header upon WebSocket connection.

- **Format:** `ClientName/Version (Comment)`
- **Example:** `MyAwesomeClient/3.5.0 (https://my-client.com)`

Connections with a missing or improperly formatted `Client-Name` header may be rejected.

### Session Resuming

Contrary to some older documentation, NodeLink **fully supports** session resuming. If a WebSocket connection is dropped, a client can reconnect to `/v4/websocket` and provide the previous `Session-Id` in the headers to resume the existing session and its players.

---

## Endpoint Differences

### /info

The `/v4/info` endpoint provides information about the NodeLink instance. The structure is similar to Lavalink, with the following key differences in the payload:

- `jvm`: This field contains the **Node.js version** instead of a Java Virtual Machine version.
- `lavaplayer`: This field will always be `"n/a (Node.js)"`, as NodeLink uses its own native playback system.

### /stats

The `/v4/stats` endpoint payload is mostly compatible, with two important distinctions:

- `frameStats`: This object is **never null**. If there are no active players, its fields (`sent`, `nulled`, `deficit`) will all be `0`.
- `detailedStats`: NodeLink adds this new object, which contains a granular breakdown of internal statistics, including API requests per endpoint, source-specific success/failure rates, and playback event counts. This is useful for advanced monitoring.

### /loadtracks

The `/loadtracks` endpoint in NodeLink can return additional `loadType` values beyond the standard Lavalink types, providing more context for the loaded resource.

- **Additional `loadType` values:** `album`, `artist`.

Clients should be prepared to handle these new load types, which behave similarly to the `playlist` load type.

### /routeplanner

NodeLink includes a fully functional IP route planner to handle rate limits from sources like YouTube. This is a significant feature that is not present in the standard Lavalink server.

The following endpoints are available for managing it:

- `GET /v4/routeplanner/status`: Returns the current status of the route planner, including the active strategy and statistics on failing addresses.
- `POST /v4/routeplanner/free/address`: Unmarks a specific IP address as failed.
- `POST /v4/routeplanner/free/all`: Clears all failing IP addresses from the planner.

---

## New Endpoints

NodeLink introduces several new endpoints not found in the Lavalink specification.

### /loadlyrics

This endpoint allows clients to fetch lyrics for a given track.

`GET /v4/loadlyrics?encodedTrack=<base64>`

- **Success Response:** Returns a lyrics object with `loadType`, `data.name`, `data.synced`, and `data.lines` (an array of lyric lines).
- **Failure Response:** Returns a standard error object if lyrics are not found or an error occurs.

### /encodetrack & /decodetracks

NodeLink provides utility endpoints for encoding and decoding tracks, which can be useful for client developers.

- `GET /v4/encodetrack?track=...`: Encodes a track object into a base64 string.
- `POST /v4/decodetracks`: Decodes an array of base64 track strings into track objects.

### /connection

`GET /v4/connection`

This new endpoint returns real-time metrics about the server's internet connection quality, including download speed (bps, kbps, mbps) and the current status (`good`, `average`, `bad`, `disconnected`). This can be used to diagnose network-related playback issues.

---

## WebSocket Event Differences

### TrackStartEvent

NodeLink emits the `TrackStartEvent` only when the audio data for the track begins to be processed and sent to Discord. This is different from Lavalink, which may emit the event as soon as the play request is received. NodeLink's approach provides a more accurate representation of when audio actually starts playing.

### TrackStuckEvent

This event is **not used** in NodeLink. If a track encounters a non-fatal playback error (like a stream interruption), NodeLink will either attempt to recover it automatically or emit a `TrackExceptionEvent` or the new `TrackRecoveryNeededEvent`.

### New Events

NodeLink emits several new events to provide clients with more detailed state information:

- **`TrackRecoveryNeededEvent`**: Emitted when the internal recovery mechanism detects a potentially recoverable issue (e.g., a zombie stream with no data).
- **`ConnectionStatusEvent`**: Dispatched whenever the server's network quality status changes (see `/connection` endpoint).
- **`VolumeChangedEvent`**: Emitted when a player's volume is changed.
- **`FiltersChangedEvent`**: Emitted when a player's audio filters are updated.
- **`SeekEvent`**: Dispatched after a player successfully seeks to a new position.
- **`PauseEvent`**: Dispatched when a player's pause state is changed.
