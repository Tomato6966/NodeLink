import { Transform } from 'node:stream';

import tremolo from './filters/tremolo.js';
import vibrato from './filters/vibrato.js';

export class FiltersManager extends Transform {
  constructor(options = {}) {
    super(options);

    this.availableFilters = {
      tremolo,
      vibrato
    };

    this.activeFilters = [];

    this.update({});
  }

  update(filters) {
    this.activeFilters = [];
    for (const filterName in this.availableFilters) {
      const filter = this.availableFilters[filterName];
      
      if (filters[filterName]) {
        this.activeFilters.push(filter);
      }

      filter.update(filters);
    }
  }

  _transform(chunk, encoding, callback) {
    if (this.activeFilters.length === 0) {
      this.push(chunk);
      return callback();
    }

    let processedChunk = chunk;
    for (const filter of this.activeFilters) {
      processedChunk = filter.process(processedChunk);
    }

    this.push(processedChunk);
    callback();
  }
}
