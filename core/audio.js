/**
 * core/audio.js - Audio-related utilities
 * Currently the pipeline modifies audio timestamps directly inside
 * the MediaBunny Conversion `process` callback, so this module
 * primarily provides configuration helpers.
 */

/**
 * Choose the best audio codec for a given container.
 * @param {'h264'|'vp8'|'vp9'|'av1'} videoCodec
 * @returns {'aac'|'opus'} audio codec id
 */
export function pickAudioCodec(videoCodec) {
    if (videoCodec === 'h264') return 'aac';
    return 'opus'; // vp8/vp9/av1 → WebM → Opus
}

/**
 * Whether audio processing (timestamp modification) is needed.
 */
export function needsAudioProcess(speed) {
    return Math.abs(speed - 1.0) > 0.001;
}

/**
 * Estimate a reasonable audio bitrate.
 * @param {number} channels
 * @returns {number} bitrate in bps
 */
export function estimateAudioBitrate(channels) {
    if (channels >= 6) return 256_000;  // 5.1
    if (channels >= 2) return 128_000;  // stereo
    return 64_000;                      // mono
}
