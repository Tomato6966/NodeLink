/**
 * YouTube URL type constants for classification.
 * @public
 */
export const YOUTUBE_CONSTANTS = {
    /** Regular YouTube video (watch URL) */
    VIDEO: 0,
    /** YouTube playlist (playlist URL with list parameter) */
    PLAYLIST: 1,
    /** YouTube Shorts video (short form content) */
    SHORTS: 2,
    /** Unknown or unsupported URL type */
    UNKNOWN: -1
};
