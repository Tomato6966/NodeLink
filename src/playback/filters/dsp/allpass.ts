/**
 * First-order all-pass filter.
 * @public
 */
export default class Allpass {
  public x1 = 0
  public y1 = 0
  private a = 0

  /**
   * Sets the filter coefficient.
   * @param a - Coefficient value, clamped to [-0.999, 0.999].
   */
  public setCoefficient(a: number): void {
    this.a = Math.max(-0.999, Math.min(0.999, a))
  }

  /**
   * Processes a single audio sample.
   * @param sample - The input sample.
   * @returns The processed output sample.
   */
  public process(sample: number): number {
    const output = this.a * sample + this.x1 - this.a * this.y1

    this.x1 = sample
    this.y1 = output

    return output
  }
}
