<p align="center">
  <img src="https://github.com/1Lucas1apk/lab/blob/master/mwc2h6q%20-%20Imgur.png?raw=true" alt="NodeLink Banner"/>
</p>

<h1 align="center">NodeLink</h1>

<p align="center">
  <b>A modern Lavalink alternative built entirely in Node.js</b><br>
  Lightweight, modular, and optimized for real-time performance.
</p>

---

## Prerequisites

* **Node.js** v18 or higher (v20 recommended)
* **Git**

---

## Overview

**NodeLink** is an alternative audio server built in **Node.js**, designed for those who value control and efficiency. 🌿
It doesn’t try to reinvent the wheel — it just makes it spin with less weight.
Easy to configure, naturally scalable, and with smooth playback, it provides a solid foundation for music bots and real-time audio systems.

Created by Brazilian developers, NodeLink was born from the desire for a simpler, open, and truly accessible audio server for everyone.

---

## Features

* **100% Node.js implementation** – No external runtime required.
* **Lavalink-compatible API** – Works with most existing clients.
* **Optimized decoding** – Powered by WebAssembly and native modules.
* **Smart clustering** – Automatic scaling with multiple processes.
* **Real-time audio filters** – Equalizer, timescale, tremolo, compressor, and more.
* **Low memory footprint** – Efficient even with multiple active players.
* **Multiple source support** – YouTube, Spotify, SoundCloud, Deezer, Twitch, and more.

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink

# Install dependencies
npm install

# Copy the default configuration file
cp config.default.js config.js

# Start the server
npm run start
```

Once started, NodeLink runs a Lavalink-compatible WebSocket server, ready for immediate use.

---

### Memory Usage

NodeLink is designed to be memory-efficient.
At startup, it typically uses around **50 MB**, stabilizing near **24 MB** when idle.
Each active player adds between **4 and 15 MB**, depending on stream format and applied filters.

Cluster workers run independently, maintaining their own caches and pipelines — enabling parallel, scalable playback without session interference.

---

### Architecture

NodeLink follows a **worker-based model**, where each process manages its own players and buffers.
Each worker acts as an autonomous mini-instance, communicating with the main process only when necessary.
This reduces bottlenecks and keeps stability even under heavy load.

Its modular structure also allows swapping components, adding new sources or filters, and adjusting internal behavior without touching the core server.

---

### Technical Dependencies

Internally, NodeLink combines native and WebAssembly modules for precise audio processing, buffering, and packet handling.

- [`@performanc/pwsl-server`](https://github.com/PerformanC/internals/tree/PWSL-server) *
- [`@performanc/voice`](https://npmjs.com/package/@performanc/voice) *
- [`@alexanderolsen/libsamplerate-js`](https://www.npmjs.com/package/@alexanderolsen/libsamplerate-js)
- [`@ecliptia/faad2-wasm`](https://www.npmjs.com/package/@ecliptia/faad2-wasm)
- [`@ecliptia/seekeable-node`](https://www.npmjs.com/package/@ecliptia/seekeable-node)
- [`@wasm-audio-decoders/flac`](https://www.npmjs.com/package/@wasm-audio-decoders/flac)
- [`@wasm-audio-decoders/ogg-vorbis`](https://www.npmjs.com/package/@wasm-audio-decoders/ogg-vorbis)
- [`mpg123-decoder`](https://www.npmjs.com/package/mpg123-decoder)
- [`opusscript`](https://www.npmjs.com/package/opusscript)
- [`prism-media`](https://www.npmjs.com/package/prism-media)
- [`sodium-native`](https://www.npmjs.com/package/sodium-native)

> [!NOTE]  
> Dependencies marked with an asterisk (*) are maintained by the PerformanC team.

These modules form the essential foundation that keeps NodeLink’s playback stable and reliable.

---

## Contributing

Pull requests are welcome!
Feel free to open issues, share suggestions, or join discussions on Discord.
Every contribution helps make NodeLink more stable, accessible, and well-documented.

---

## Community & Support

Questions, feedback, or contributions are always welcome:

* [PerformanC Discord Server](https://discord.gg/uPveNfTuCJ)
* [Ecliptia "Imagine" Server](https://discord.gg/fzjksWS65v)

---

## License

NodeLink is open-source software released under the **BSD 2-Clause License**.
See [LICENSE](LICENSE) for full details.

---

### Motivation

NodeLink was born from a simple desire: to understand and master every detail of an audio server — without relying on closed, heavy, or complicated solutions.
The goal is to make audio accessible, transparent, and fun to build.

---

<p align="center">
  <sub>NodeLink — where lightness meets sound. 🌿</sub><br>
  <sub>Made with ⚡ and curiosity by PerformanC and Ecliptia 💙</sub><br>
  <sub>(BRAZIL 🇧🇷)</sub>
</p>

---
