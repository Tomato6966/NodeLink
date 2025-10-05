export default class Allpass {
  constructor() {
    this.x1 = 0
    this.y1 = 0
    this.a = 0
  }

  setCoefficient(a) {
    this.a = Math.max(-0.999, Math.min(0.999, a))
  }

  process(sample) {
    const output = this.a * sample + this.x1 - this.a * this.y1

    this.x1 = sample
    this.y1 = output

    return output
  }
}
