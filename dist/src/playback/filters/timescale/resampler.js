/**
 * Cubic interpolation for smoother resampling.
 * @param p0 - Pre-previous sample.
 * @param p1 - Previous sample.
 * @param p2 - Next sample.
 * @param p3 - Post-next sample.
 * @param t - Interpolation factor (0 to 1).
 * @returns Interpolated sample.
 */
const cubicInterpolate = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    return (0.5 *
        (2 * p1 +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
};
/**
 * Retrieves a sample at a specific frame and channel with clamping.
 * @param input - Input buffer.
 * @param channels - Number of channels.
 * @param frames - Total number of frames.
 * @param frameIndex - Target frame index.
 * @param channel - Target channel.
 * @returns Sample value.
 */
const sampleAt = (input, channels, frames, frameIndex, channel) => {
    const clampedIndex = Math.max(0, Math.min(frames - 1, frameIndex));
    return input[clampedIndex * channels + channel] ?? 0;
};
/**
 * Simple cubic resampler for Float32 audio data.
 * @param input - Input Float32Array.
 * @param channels - Number of channels.
 * @param rate - Resampling rate (e.g., 0.5 to slow down, 2.0 to speed up).
 * @returns Resampled Float32Array.
 * @public
 */
export const resample = (input, channels, rate) => {
    if (rate === 1 || input.length === 0)
        return input;
    const inputFrames = Math.floor(input.length / channels);
    if (inputFrames === 0)
        return new Float32Array(0);
    const outputFrames = Math.max(0, Math.floor(inputFrames / rate));
    if (outputFrames === 0)
        return new Float32Array(0);
    const output = new Float32Array(outputFrames * channels);
    for (let outFrame = 0; outFrame < outputFrames; outFrame++) {
        const sourceFrame = outFrame * rate;
        const baseFrame = Math.floor(sourceFrame);
        const frac = sourceFrame - baseFrame;
        for (let channel = 0; channel < channels; channel++) {
            const p0 = sampleAt(input, channels, inputFrames, baseFrame - 1, channel);
            const p1 = sampleAt(input, channels, inputFrames, baseFrame, channel);
            const p2 = sampleAt(input, channels, inputFrames, baseFrame + 1, channel);
            const p3 = sampleAt(input, channels, inputFrames, baseFrame + 2, channel);
            output[outFrame * channels + channel] = cubicInterpolate(p0, p1, p2, p3, frac);
        }
    }
    return output;
};
