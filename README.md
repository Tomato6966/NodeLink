# NodeLink

NodeLink is a next-generation, Lavalink-compatible audio server rewritten from the ground up for maximum performance, stability, and efficiency. It provides a robust solution for delivering high-quality audio to Discord bots, focusing on a lightweight footprint and native processing.

## Core Advantages

What makes NodeLink different from other Lavalink servers?

-   **Extremely Low Memory Footprint**
    NodeLink is incredibly light on resources. It starts at just **~40MB of RAM** and can idle as low as **~10MB**. Even with active players, memory usage is minimal, settling around **~28MB** after initial allocation.

-   **Precision Audio Delivery**
    NodeLink uses [`@performanc/voice`](https://npmjs.com/package/@performanc/voice), our own highly-optimized voice implementation. This gives us fine-grained control over audio packet scheduling, eliminating common issues like audio speed-ups or choppiness by ensuring frames are sent to Discord exactly when they should be.

-   **WebAssembly-Powered Processing**
    Most of our audio decoders now run on WebAssembly, bringing near-native performance directly within Node.js. We use best-in-class, battle-tested libraries for every format to ensure the highest quality and stability.

-   **FFmpeg is No Longer Required**
    > [!IMPORTANT]
    > We have completely removed the dependency on **FFmpeg** for all core playback and decoding. This means lower I/O, less complexity, and a more stable, native experience right out of the box.

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

You can be up and running in just a few minutes.

### Prerequisites

- [Node.js](https://nodejs.org/) (v18.x or higher is recommended)
- [Git](https://git-scm.com/)

### 1. Clone the Repository

First, clone the NodeLink repository to your machine and navigate into the directory:

```shell
git clone https://github.com/PerformanC/NodeLink.git
cd NodeLink
```

### 2. Install Dependencies

Next, install all the necessary dependencies using npm:

```shell
npm install
```

### 3. Create Your Configuration

NodeLink uses a `config.js` file for all its settings. You can create your own by copying the default template:

```shell
cp config.default.js config.js
```

Open `config.js` in your favorite editor and customize it. The most important thing to change is the `server.password`.

### 4. Run It!

You're all set. Start the server with:

```shell
npm start
```

NodeLink is now running and ready to accept client connections!

## Client Compatibility

NodeLink is compatible with a wide range of Lavalink clients. The following table has been adapted for NodeLink's specific features and compatibility.


| Client                                                              | Platform     | v2 supported?   | NodeLink Features?  | NodeLink major version |
| --------------------------------------------------------------------|--------------|-----------------|---------------------|------------------------|
| [Lavalink-Client](https://github.com/lavalink-devs/Lavalink-Client) | JVM          | Yes             | No                  | v1 and v2              |
| [Lavalink.kt](https://github.com/DRSchlaubi/Lavalink.kt)            | Kotlin       | No              | No                  | v1                     |
| [DisGoLink](https://github.com/disgoorg/disgolink)                  | Go           | Yes             | No                  | v1 and v2              |
| [Lavalink.py](https://github.com/devoxin/lavalink.py)               | Python       | Yes             | No                  | v1 and v2              |
| [Mafic](https://github.com/ooliver1/mafic)                          | Python       | Yes             | No                  | v1 and v2              |
| [Wavelink](https://github.com/PythonistaGuild/Wavelink)             | Python       | Yes             | No                  | v1 and v2              |
| [Pomice](https://github.com/cloudwithax/pomice)                     | Python       | Yes             | No                  | v1 and v2              |
| [Hikari-ongaku](https://github.com/MPlatypus/hikari-ongaku)         | Python       | Yes             | No                  | v1 and v2              |
| [Moonlink.js](https://github.com/1Lucas1apk/moonlink.js)            | Typescript   | Yes             | Yes                 | v1 and v2              |
| [Magmastream](https://github.com/Blackfort-Hosting/magmastream)     | Typescript   | No              | No                  | v1                     |
| [Lavacord](https://github.com/lavacord/Lavacord)                    | Typescript   | Yes             | No                  | v1 and v2              |
| [Shoukaku](https://github.com/Deivu/Shoukaku)                       | Typescript   | Yes             | No                  | v1 and v2              |
| [Lavalink-Client](https://github.com/tomato6966/Lavalink-Client)    | Typescript   | No              | No                  | v1                     |
| [Rainlink](https://github.com/RainyXeon/Rainlink)                   | Typescript   | Yes             | Yes                 | v1 and v2              |
| [Poru](https://github.com/parasop/Poru)                             | Typescript   | Yes             | Yes                 | v1 and v2              |
| [Blue.ts](https://github.com/ftrapture/blue.ts)                     | Typescript   | No              | No                  | v1 and v2              | 
| [FastLink](https://github.com/PerformanC/FastLink)                  | Node.js      | Yes             | Yes                 | v1 and v2              |
| [Riffy](https://github.com/riffy-team/riffy)                        | Node.js      | Yes             | No                  | v1 and v2              |
| [TsumiLink](https://github.com/Fyphen1223/TsumiLink)                | Node.js      | Yes             | Yes                 | v1 and v2              |
| [DisCatSharp](https://github.com/Aiko-IT-Systems/DisCatSharp)       | .NET         | Yes             | No                  | v1 and v2              |
| [Lavalink4NET](https://github.com/angelobreuer/Lavalink4NET)        | .NET         | Yes             | No                  | v1 and v2              |
| [Nomia](https://github.com/DHCPCD9/Nomia)                           | .NET         | Yes             | No                  | v1 and v2              |
| [CogLink](https://github.com/PerformanC/Coglink)                    | C            | Yes             | No                  | v1 and v2              |
| [Lavalink-rs](https://gitlab.com/vicky5124/lavalink-rs)             | Rust, Python | Yes             | No                  | v1 and v2              |
| [nyxx_lavalink](https://github.com/nyxx-discord/nyxx_lavalink)      | Dart         | No              | No                  | v1                     |

> [!NOTE]
> If a client is not listed, it does not mean it is incompatible. Most modern Lavalink clients should work with NodeLink. For creating your own client, please refer to the Lavalink implementation documentation.

## Troubleshooting

### "Expected 200, received 403." error

In some regions, you may receive a 403 error when trying to connect to YouTube. The exact reason is unknown, but a workaround is available. To fix this, you must log in to your Google/YouTube account. The process of retrieving the necessary information is explained in the `config.js` file.

### node: bad option: --openssl-legacy-provider

This error occurs when you are using an outdated version of Node.js. To fix this, you must update your Node.js to the latest version. Alternatively, you can remove the `--openssl-legacy-provider` flag from the `start` script in the `package.json` file if you need to use an older Node.js version for other reasons.

## Community & Support

Have questions, need help, or want to share what you've built? Join our community on Discord!

-   [PerformanC Discord Server](https://discord.gg/uPveNfTuCJ) or [Ecliptia \("Imagine"\)](https://discord.gg/fzjksWS65v)

## License

NodeLink is open-source software released under the **BSD 2-Clause License**. You can find the full license text in the [LICENSE](LICENSE) file.