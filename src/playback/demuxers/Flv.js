import { Transform } from 'node:stream'
import { logger } from '../../utils.js'
import { RingBuffer } from '../RingBuffer.js'

const STATE_HEADER = 0
const STATE_TAG_HEADER = 1
const STATE_TAG_BODY = 2

const TAG_TYPE_AUDIO = 8
const BUFFER_SIZE = 2 * 1024 * 1024 // 2MB

export class FlvDemuxer extends Transform {
  constructor(options = {}) {
    super({ ...options, readableObjectMode: true })
    this.on('error', (err) => logger('error', 'FlvDemuxer', `Stream error: ${err.message} (${err.code})`))
    this.ringBuffer = new RingBuffer(BUFFER_SIZE)
    this.state = STATE_HEADER
    this.expectedSize = 9
    this.currentTag = null
  }

  _transform(chunk, encoding, callback) {
    this.ringBuffer.write(chunk)

    while (this.ringBuffer.length >= this.expectedSize) {
      if (this.state === STATE_HEADER) {
        const header = this.ringBuffer.peek(3)
        if (header.toString('ascii') !== 'FLV') {
          return callback(new Error('Invalid FLV header'))
        }
        this.ringBuffer.read(13)
        this.state = STATE_TAG_HEADER
        this.expectedSize = 11
      } else if (this.state === STATE_TAG_HEADER) {
        const header = this.ringBuffer.read(11)
        const type = header.readUInt8(0)
        const size = header.readUIntBE(1, 3)
        
        this.currentTag = { type, size }
        this.state = STATE_TAG_BODY
        this.expectedSize = size + 4
      } else if (this.state === STATE_TAG_BODY) {
        const body = this.ringBuffer.read(this.currentTag.size)
        // Skip PreviousTagSize (4 bytes)
        this.ringBuffer.read(4)
        
        if (this.currentTag.type === TAG_TYPE_AUDIO) {
          this.push(body)
        }

        this.state = STATE_TAG_HEADER
        this.expectedSize = 11
      }
    }

    callback()
  }

  _destroy(err, cb) {
    this.ringBuffer.dispose()
    cb(err)
  }
}

export default FlvDemuxer