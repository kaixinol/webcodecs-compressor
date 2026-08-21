/**
 * core/video.js - Resolution presets, dimension calculation, aspect-ratio helpers,
 * and shared codec definitions.
 */

/**
 * Shared codec definitions — single source of truth.
 * Used by main.js (detection) and core/pipeline.js (processing).
 */
export const CODEC_DEFINITIONS = [
  {
    id: "h264",
    label: "H.264 (MP4)",
    mbCodec: "avc",
    webCodecsCodec: "avc1.42001f",
    ext: ".mp4",
    outputMimeType: 'video/mp4; codecs="avc1.42E01E"',
    audioCodecs: ["aac"],
  },
  {
    id: "hevc",
    label: "H.265 / HEVC (MP4)",
    mbCodec: "hevc",
    webCodecsCodec: "hev1.1.6.L93.B0",
    ext: ".mp4",
    outputMimeType: 'video/mp4; codecs="hev1.1.6.L93.B0"',
    audioCodecs: ["aac"],
  },
  {
    id: "vp8",
    label: "VP8 (WebM)",
    mbCodec: "vp8",
    webCodecsCodec: "vp8",
    ext: ".webm",
    outputMimeType: 'video/webm; codecs="vp8"',
    audioCodecs: ["opus", "vorbis"],
  },
  {
    id: "vp9",
    label: "VP9 (WebM)",
    mbCodec: "vp9",
    webCodecsCodec: "vp09.00.10.08",
    ext: ".webm",
    outputMimeType: 'video/webm; codecs="vp09.00.10.08"',
    audioCodecs: ["opus", "vorbis"],
  },
  {
    id: "av1",
    label: "AV1 (MP4/WebM)",
    mbCodec: "av1",
    webCodecsCodec: "av01.0.04M.08",
    ext: ".mp4",
    outputMimeType: 'video/mp4; codecs="av01.0.05M.08"',
    audioCodecs: ["aac"],
  },
];

export const AUDIO_CODEC_DEFINITIONS = [
  { id: "aac", label: "AAC" },
  { id: "opus", label: "Opus" },
  { id: "vorbis", label: "Vorbis" },
];

/**
 * Common resolution presets.
 */
export const RESOLUTION_PRESETS = [
    { id: 'original', label: 'Original (unchanged)', height: null },
    { id: '2160', label: '4K (2160p)', height: 2160 },
    { id: '1440', label: '2K (1440p)', height: 1440 },
    { id: '1080', label: '1080p (FHD)', height: 1080 },
    { id: '720', label: '720p (HD)', height: 720 },
    { id: '480', label: '480p (SD)', height: 480 },
    { id: '360', label: '360p', height: 360 },
    { id: 'custom', label: 'Custom…', height: 'custom' },
];

/**
 * Given a target height and source dimensions, compute width preserving
 * aspect ratio, snapped to even numbers (WebCodecs requirement).
 */
export function dimensionsFromPreset(targetHeight, srcW, srcH) {
    if (targetHeight === null) return { width: srcW, height: srcH };
    const h = targetHeight;
    const w = Math.round(srcW * (h / srcH));
    return {
        width: (w % 2 === 0) ? w : w + 1,
        height: (h % 2 === 0) ? h : h + 1,
    };
}

/**
 * Calculate target dimensions when both width and height are explicitly
 * specified (custom mode), preserving aspect ratio via contain.
 */
export function calculateCustomResize(srcW, srcH, targetW, targetH) {
    let w = targetW;
    let h = targetH;
    if (w % 2 !== 0) w += 1;
    if (h % 2 !== 0) h += 1;
    return { width: w, height: h };
}

/**
 * Check whether speed change is meaningful.
 */
export function needsSpeed(speed) {
    return Math.abs(speed - 1.0) > 0.001;
}
