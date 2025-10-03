import { Transform } from 'node:stream';

export class Filters extends Transform {
  constructor(options = {}) {
    super(options);

  }

  update(filters) {

  }

  _transform(chunk, encoding, callback) {

    this.push(chunk);
    callback();
  }
}
