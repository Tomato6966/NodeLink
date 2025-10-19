# NodeLink

NodeLink is a next-generation, Lavalink-compatible audio server, rewritten from the ground up for **maximum performance, stability, and efficiency**. Designed for Discord bots, NodeLink focuses on **native audio processing**, low-latency delivery, and a lightweight footprint without relying on external tools like FFmpeg.

## Core Advantages

What makes NodeLink stand out from other Lavalink servers?

- **Efficient Resource Usage**  
  NodeLink is designed to run smoothly with minimal resource consumption, even with multiple active players.

- **Precision Audio Delivery**  
  Using [`@performanc/voice`](https://npmjs.com/package/@performanc/voice), NodeLink schedules audio packets accurately to Discord, avoiding common issues like choppiness or speed-ups.

- **WebAssembly-Powered Decoding**  
  Most audio decoders run on WebAssembly, providing near-native performance directly in Node.js while ensuring stability and high-quality playback.

- **FFmpeg-Free Playback**  
  > [!IMPORTANT]  
  > NodeLink no longer requires **FFmpeg** for core playback and decoding. This simplifies setup, reduces I/O overhead, and provides a more stable experience out of the box.

## Dependencies

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

## Getting Started

Follow these steps to get NodeLink running:

### Prerequisites

- [Node.js](https://nodejs.org/) (v18.x or higher recommended)  
- [Git](https://git-scm.com/)

### 1. Clone the Repository

```shell
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink
````

### 2. Install Dependencies

```shell
npm install
```

### 3. Create Your Configuration

```shell
cp config.default.js config.js
```

Open `config.js` and customize your settings. Make sure to set `server.password`.

### 4. Run the Server

```shell
npm start
```

NodeLink is now running and ready to accept client connections.

## Client Compatibility

NodeLink is compatible with most Lavalink clients. Clients that support NodeLink-specific features are highlighted.

| Client                                                              | Platform   | v2 supported? | NodeLink Features? | NodeLink major version |
| ------------------------------------------------------------------- | ---------- | ------------- | ------------------ | ---------------------- |
| [Lavalink-Client](https://github.com/lavalink-devs/Lavalink-Client) | JVM        | Yes           | No                 | v1 and v2              |
| [Lavalink.kt](https://github.com/DRSchlaubi/Lavalink.kt)            | Kotlin     | No            | No                 | v1                     |
| [DisGoLink](https://github.com/disgoorg/disgolink)                  | Go         | Yes           | No                 | v1 and v2              |
| [Lavalink.py](https://github.com/devoxin/lavalink.py)               | Python     | Yes           | No                 | v1 and v2              |
| [Mafic](https://github.com/ooliver1/mafic)                          | Python     | Yes           | No                 | v1 and v2              |
| [Wavelink](https://github.com/PythonistaGuild/Wavelink)             | Python     | Yes           | No                 | v1 and v2              |
| [Pomice](https://github.com/cloudwithax/pomice)                     | Python     | Yes           | No                 | v1 and v2              |
| [Hikari-ongaku](https://github.com/MPlatypus/hikari-ongaku)         | Python     | Yes           | No                 | v1 and v2              |
| [Moonlink.js](https://github.com/1Lucas1apk/moonlink.js)            | Typescript | Yes           | Yes                | v1 and v2              |
| [Magmastream](https://github.com/Blackfort-Hosting/magmastream)     | Typescript | No            | No                 | v1                     |
| [Lavacord](https://github.com/lavacord/Lavacord)                    | Typescript | Yes           | No                 | v1 and v2              |
| [Shoukaku](https://github.com/Deivu/Shoukaku)                       | Typescript | Yes           | No                 | v1 and v2              |
| [Rainlink](https://github.com/RainyXeon/Rainlink)                   | Typescript | Yes           | Yes                | v1 and v2              |
| [Poru](https://github.com/parasop/Poru)                             | Typescript | Yes           | Yes                | v1 and v2              |
| [FastLink](https://github.com/PerformanC/FastLink)                  | Node.js    | Yes           | Yes                | v1 and v2              |
| [TsumiLink](https://github.com/Fyphen1223/TsumiLink)                | Node.js    | Yes           | Yes                | v1 and v2              |

> [!NOTE]
> If a client is not listed, it does not mean it is incompatible. Most modern Lavalink clients should work with NodeLink. For creating your own client, refer to the Lavalink implementation documentation.

## Troubleshooting

### "Expected 200, received 403." error

This may occur in some regions when connecting to YouTube. To resolve this, you may need to log in to a Google/YouTube account. Details are explained in `config.js`.

### node: bad option: --openssl-legacy-provider

Occurs when using an outdated Node.js version. Update Node.js to the latest version, or remove the `--openssl-legacy-provider` flag in `package.json` if needed.

## Community & Support

Have questions or want to share your projects? Join the community on Discord:

* [PerformanC Discord Server](https://discord.gg/uPveNfTuCJ)
* [Ecliptia "Imagine" Server](https://discord.gg/fzjksWS65v)

## License

NodeLink is open-source software released under the **BSD 2-Clause License**. See the full text in [LICENSE](LICENSE).

