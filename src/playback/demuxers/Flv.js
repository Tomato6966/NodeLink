import { Transform } from 'node:stream'

const STATE_HEADER = 0
const STATE_TAG_HEADER = 1
const STATE_TAG_BODY = 2

const TAG_TYPE_AUDIO = 8

//NOVO DEMUXER ENCONTRADO NAS PROFUNDEZAS DO GITHUB, TESTADO E FUNCIONANDO PARA FLV LIVE DO BILIBILI
//quebrei cabeça para entender o formato FLV, mas consegui fazer funcionar
//:P

export class FlvDemuxer extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: true })
    this.buffer = Buffer.alloc(0)
    this.state = STATE_HEADER
    this.expectedSize = 9
    this.currentTag = null
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length >= this.expectedSize) {
      if (this.state === STATE_HEADER) {
        if (this.buffer.toString('ascii', 0, 3) !== 'FLV') {
          return callback(new Error('Invalid FLV header'))
        }
        // Skip header (9 bytes) + PreviousTagSize0 (4 bytes)
        this.buffer = this.buffer.subarray(13)
        this.state = STATE_TAG_HEADER
        this.expectedSize = 11
      } else if (this.state === STATE_TAG_HEADER) {
        const type = this.buffer.readUInt8(0)
        const size = this.buffer.readUIntBE(1, 3)
        
        this.currentTag = { type, size }
        this.buffer = this.buffer.subarray(11)
        this.state = STATE_TAG_BODY
        this.expectedSize = size + 4
      } else if (this.state === STATE_TAG_BODY) {
        const body = this.buffer.subarray(0, this.currentTag.size)
        
        if (this.currentTag.type === TAG_TYPE_AUDIO) {
          this.push(body)
        }

        this.buffer = this.buffer.subarray(this.currentTag.size + 4)
        this.state = STATE_TAG_HEADER
        this.expectedSize = 11
      }
    }

    callback()
  }
}

export default FlvDemuxer