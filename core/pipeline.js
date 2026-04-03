/**
 * core/pipeline.js - Main video processing pipeline using MediaBunny Conversion API
 *
 * Transformations:
 * - Resize: via MediaBunny native scaling (width/height/fit)
 * - Speed: via custom process() modifying timestamp/duration on each sample
 * - Codec: via video.codec option (transcodes when needed)
 * - Audio: kept or discarded; timestamps modified via process() when speed != 1
 * - Quality: when qualityPreset === 'original', bitrate is set very high to avoid
 *   perceptible compression (uses source bitrate × 1.2 as target).
 *
 * HEVC (H.265) is mapped to MP4 container.
 */

import {
    Input,
    ALL_FORMATS,
    BlobSource,
    Output,
    BufferTarget,
    Mp4OutputFormat,
    WebMOutputFormat,
    Conversion,
    canEncodeVideo,
} from 'mediabunny';

import { dimensionsFromPreset, calculateCustomResize, needsSpeed } from './video.js';

/** Codec id → label shown in UI */
export const CODEC_OPTIONS = [
    { id: 'h264', mbCodec: 'avc',     label: 'H.264 (MP4)',         ext: '.mp4',  fmt: Mp4OutputFormat },
    { id: 'hevc', mbCodec: 'hevc',    label: 'H.265 / HEVC (MP4)',  ext: '.mp4',  fmt: Mp4OutputFormat },
    { id: 'vp8',  mbCodec: 'vp8',     label: 'VP8 (WebM)',          ext: '.webm', fmt: WebMOutputFormat },
    { id: 'vp9',  mbCodec: 'vp9',     label: 'VP9 (WebM)',          ext: '.webm', fmt: WebMOutputFormat },
    { id: 'av1',  mbCodec: 'av1',     label: 'AV1 (MP4/WebM)',      ext: '.mp4',  fmt: Mp4OutputFormat },
];

/** Lookup table */
const BY_ID = Object.fromEntries(CODEC_OPTIONS.map(c => [c.id, c]));

/**
 * Check if the browser can encode a given codec at a test resolution.
 */
export async function checkCodecSupported(mbCodec, w = 1280, h = 720) {
    try {
        return await canEncodeVideo(mbCodec, { width: w, height: h, bitrate: 1e6 });
    } catch {
        return false;
    }
}

/**
 * Estimate a reasonable bitrate for a given resolution (~0.08 bpp at 30 fps).
 */
export function estimateBitrate(w, h) {
    const pixels = w * h;
    return Math.max(200_000, Math.min(20_000_000, Math.round(pixels * 30 * 0.08)));
}

/**
 * Derive a "no visible quality loss" bitrate: source bitrate × 1.2
 * capped at 50 Mbps. If source bitrate is unknown, fall back to
 * a very generous 8 Mbps.
 */
export function originalQualityBitrate(sourceBitrate, _w = 0, _h = 0) {
    if (sourceBitrate && sourceBitrate > 0) {
        return Math.min(50_000_000, Math.round(sourceBitrate * 1.2));
    }
    return 8_000_000;
}

/**
 * Derive output file name.
 */
export function deriveOutputFileName(originalName, codecId) {
    const cfg = BY_ID[codecId];
    const ext = cfg ? cfg.ext : '.mp4';
    const base = originalName.replace(/\.[^.]+$/, '');
    return `${base}_processed${ext}`;
}

/**
 * Build video process function — adjusts timestamps for speed.
 * Called by MediaBunny AFTER native resize/rotate.
 */
function makeVideoProcessFn(speed) {
    return (sample) => {
        sample.setTimestamp(sample.timestamp / speed);
        sample.setDuration(sample.duration / speed);
        return sample;
    };
}

/** Build audio process function — adjusts timestamps for speed. */
function makeAudioProcessFn(speed) {
    return (sample) => {
        sample.setTimestamp(sample.timestamp / speed);
        if (typeof sample.setDuration === 'function') {
            sample.setDuration(sample.duration / speed);
        }
        return sample;
    };
}

/**
 * Full processing pipeline.
 *
 * @param {object} opts
 * @param {File} opts.file
 * @param {string} opts.codec - Codec id: h264|hevc|vp8|vp9|av1
 * @param {string} [opts.resolution] - Resolution preset id or null (= original)
 * @param {number} [opts.customWidth] - Custom width (when resolution === 'custom')
 * @param {number} [opts.customHeight] - Custom height (when resolution === 'custom')
 * @param {number} opts.speed - Playback speed multiplier
 * @param {boolean} opts.keepAudio
 * @param {number} [opts.bitrate] - Video bitrate in bps (0 = qualityPreset determines)
 * @param {'auto'|'original'} opts.qualityPreset
 * @param {function(number): void} [opts.onProgress]
 * @param {function(string): void} [opts.onStatus]
 * @param {function(object): void} [opts.onConversionReady]
 * @returns {Promise<{ buffer: ArrayBuffer, fileName: string, mimeType: string,
 *                    inputSize: number, outputSize: number, srcDuration: number }>}
 */
export async function processVideo({
    file,
    codec = 'h264',
    resolution = null,
    customWidth,
    customHeight,
    speed = 1.0,
    keepAudio = true,
    bitrate = 0,
    qualityPreset = 'auto',
    onProgress = null,
    onStatus = null,
    onConversionReady = null,
}) {
    const cfg = BY_ID[codec];
    if (!cfg) throw new Error(`Unknown codec: ${codec}`);
    const videoCodec = cfg.mbCodec;
    const outputFormat = new cfg.fmt();

    /* ── 1. Open input ─────────────────────────────────────────────── */
    const input = new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
    });

    const inputSize = await input.source.getSize();
    const srcDuration = await input.computeDuration();
    const firstTs = await input.getFirstTimestamp();
    const effectiveDuration = srcDuration - firstTs;

    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();

    if (!videoTrack) throw new Error('No video track found in input file.');

    const srcW = videoTrack.displayWidth;
    const srcH = videoTrack.displayHeight;

    /* ── 2. Resolve output dimensions ──────────────────────────────── */
    let outW = srcW;
    let outH = srcH;
    let needsResize = false;

    if (resolution && resolution !== 'original') {
        if (resolution === 'custom' && customWidth && customHeight) {
            ({ width: outW, height: outH } = calculateCustomResize(srcW, srcH, customWidth, customHeight));
        } else {
            const presetH = parseInt(resolution, 10);
            if (!isNaN(presetH)) {
                ({ width: outW, height: outH } = dimensionsFromPreset(presetH, srcW, srcH));
            }
        }
        needsResize = outW !== srcW || outH !== srcH;
    }

    // Safety: never upscale beyond source dimensions
    if (outW > srcW || outH > srcH) {
        outW = srcW;
        outH = srcH;
        needsResize = false;
    }

    const doSpeed = needsSpeed(speed);

    /* ── 3. Determine bitrate ──────────────────────────────────────── */
    let vidBitrate;
    if (bitrate > 0) {
        vidBitrate = bitrate;
    } else if (qualityPreset === 'original') {
        vidBitrate = originalQualityBitrate(videoTrack.bitrate, outW, outH);
    } else {
        vidBitrate = estimateBitrate(outW, outH);
    }

    if (onStatus) {
        const parts = [];
        if (needsResize) parts.push(`resize ${srcW}×${srcH} → ${outW}×${outH}`);
        else if (qualityPreset === 'original') parts.push('quality: original');
        if (doSpeed) parts.push(`speed ${speed}×`);
        parts.push(`${cfg.label} @ ${(vidBitrate / 1000).toFixed(0)}kbps`);
        if (!keepAudio) parts.push('no audio');
        onStatus(parts.join(', '));
    }

    /* ── 4. Build output ───────────────────────────────────────────── */
    const output = new Output({
        format: outputFormat,
        target: new BufferTarget(),
    });

    /* ── 5. Build codec conversion options ──────────────────────────── */
    const videoOpts = {
        codec: videoCodec,
        bitrate: vidBitrate,
        ...(needsResize ? { width: outW, height: outH, fit: 'contain' } : {}),
        ...(doSpeed ? {
            process: makeVideoProcessFn(speed),
            ...(needsResize ? { processedWidth: outW, processedHeight: outH } : {}),
        } : {}),
    };

    const audioOpts = {};
    if (!keepAudio) {
        audioOpts.discard = true;
    } else if (keepAudio && audioTrack && doSpeed) {
        audioOpts.process = makeAudioProcessFn(speed);
    }

    /* ── 6. Initialise conversion ──────────────────────────────────── */
    const conversion = await Conversion.init({
        input,
        output,
        video: videoOpts,
        audio: Object.keys(audioOpts).length > 0 ? audioOpts : undefined,
    });

    if (!conversion.isValid) {
        const reasons = conversion.discardedTracks.map(d => d.reason).join('; ');
        throw new Error(`Conversion invalid: ${reasons}`);
    }

    if (onConversionReady) onConversionReady(conversion);

    /* ── 7. Execute ────────────────────────────────────────────────── */
    conversion.onProgress = (p) => { if (onProgress) onProgress(p); };
    onStatus?.('Processing…');

    await conversion.execute();

    /* ── 8. Return ─────────────────────────────────────────────────── */
    const buffer = output.target.buffer;
    const mimeType = output.format.mimeType;
    const fileName = deriveOutputFileName(file.name, codec);

    return {
        buffer,
        fileName,
        mimeType,
        inputSize,
        outputSize: buffer.byteLength,
        srcDuration: effectiveDuration,
    };
}
