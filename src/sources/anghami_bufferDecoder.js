




// Minimal Protobuf decoder for Anghami SongBatchResponse
// Reverse engineered from the provided structure

export const SongBatchResponse = {
  decode(buffer) {
    const reader = new Reader(buffer);
    const result = {
      response: {},
      takendownSongIds: [],
      missingSongIds: []
    };

    while (reader.pos < reader.len) {
      const tag = reader.uint32();
      const fieldNo = tag >>> 3;
      const wireType = tag & 7;

      switch (fieldNo) {
        case 1: // commonFields
          // Skip commonFields for now as we don't strictly need them
          reader.skipType(wireType);
          break;
        case 2: // response (map<string, Song>)
          {
            const end = reader.uint32() + reader.pos;
            let key = "";
            let value = null;
            while (reader.pos < end) {
              const mapTag = reader.uint32();
              const mapFieldNo = mapTag >>> 3;
              const mapWireType = mapTag & 7;
              switch (mapFieldNo) {
                case 1:
                  key = reader.string();
                  break;
                case 2:
                  value = Song.decode(reader, reader.uint32());
                  break;
                default:
                  reader.skipType(mapWireType);
                  break;
              }
            }
            if (key && value) {
              result.response[key] = value;
            }
          }
          break;
        case 4: // takendownSongIds
          result.takendownSongIds.push(reader.string());
          break;
        case 5: // missingSongIds
          result.missingSongIds.push(reader.string());
          break;
        default:
          reader.skipType(wireType);
          break;
      }
    }
    return result;
  }
};

const Song = {
  decode(reader, len) {
    const end = void 0 === len ? reader.len : reader.pos + len;
    const message = {
        id: "",
        title: "",
        album: "",
        albumID: "",
        artist: "",
        artistID: "",
        track: 0,
        year: "",
        duration: 0,
        coverArt: "",
        genre: "",
        keywords: [],
        description: "",
        playervideo: "",
        videoid: "",
        thumbnailid: "",
        artistType: 0,
        artistGender: 0
    };

    while (reader.pos < end) {
      const tag = reader.uint32();
      const fieldNo = tag >>> 3;
      const wireType = tag & 7;

      switch (fieldNo) {
        case 1: message.id = reader.string(); break;
        case 2: message.title = reader.string(); break;
        case 3: message.album = reader.string(); break;
        case 4: message.albumID = reader.string(); break;
        case 5: message.artist = reader.string(); break;
        case 6: message.artistID = reader.string(); break;
        case 7: message.track = reader.int32(); break;
        case 8: message.year = reader.string(); break;
        case 9: message.duration = reader.float(); break;
        case 10: message.coverArt = reader.string(); break;
        case 12: message.genre = reader.string(); break;
        case 14: message.keywords.push(reader.string()); break;
        case 17: message.description = reader.string(); break;
        case 28: message.playervideo = reader.string(); break;
        case 46: message.videoid = reader.string(); break;
        case 47: message.thumbnailid = reader.string(); break;
        case 61: message.ArtistArt = reader.string(); break;
        case 77: message.artistType = reader.int32(); break;
        case 78: message.artistGender = reader.int32(); break;
        default: reader.skipType(wireType); break;
      }
    }
    return message;
  }
};

// Minimal Buffer Reader implementation
class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.pos = 0;
    this.len = buffer.length;
  }

  uint32() {
    let value = 4294967295;
    value = (this.buf[this.pos] & 127) >>> 0;
    if (this.buf[this.pos++] < 128) return value;
    value = (value | (this.buf[this.pos] & 127) << 7) >>> 0;
    if (this.buf[this.pos++] < 128) return value;
    value = (value | (this.buf[this.pos] & 127) << 14) >>> 0;
    if (this.buf[this.pos++] < 128) return value;
    value = (value | (this.buf[this.pos] & 127) << 21) >>> 0;
    if (this.buf[this.pos++] < 128) return value;
    value = (value | (this.buf[this.pos] & 15) << 28) >>> 0;
    if (this.buf[this.pos++] < 128) return value;
    this.pos += 5;
    return value;
  }

  int32() {
    return this.uint32() | 0;
  }

  string() {
    const len = this.uint32();
    const str = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return str;
  }

  bool() {
    return this.uint32() !== 0;
  }

  float() {
    const value = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return value;
  }

  skipType(wireType) {
    switch (wireType) {
      case 0:
        this.uint32();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.pos += this.uint32();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error("Unknown wire type: " + wireType);
    }
  }
}
