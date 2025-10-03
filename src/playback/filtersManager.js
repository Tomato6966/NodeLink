import { Transform } from 'node:stream';

import tremolo from './filters/tremolo.js';

export class FiltersManager extends Transform {
  constructor(options = {}) {
    super(options);

    this.filters = [ tremolo ];

    this.update({
      //ativar o tremolo
      tremolo: {
        frequency: 2.0,
        depth: 0.5
      }
    });
  }

  update(filters) {
    for (const filter of this.filters) {
      filter.update(filters);
    }
  }

  _transform(chunk, encoding, callback) {
    let processedChunk = chunk;
    for (const filter of this.filters) {
      processedChunk = filter.process(processedChunk);
    }

    this.push(processedChunk);
    callback();
  }
}
