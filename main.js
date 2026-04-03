/**
 * main.js - Alpine.js application controller (zero static MediaBunny imports).
 * Exports a factory function for Alpine registration.
 */

import { RESOLUTION_PRESETS } from "./core/video.js";

export default function createApp() {
  return {
    /* ── state ──────────────────────────────────────────────────── */
    file: null,
    dragging: false,
    processing: false,
    progress: 0,
    error: null,
    statusMessage: "",
    downloadUrl: null,
    outputFileName: "",

    metadata: null,
    codecs: [],
    hoveredCodec: null,
    badgeTooltipId: null,

    currentConversion: null,

    settings: {
      codec: "h264",
      resolution: "original",
      customWidth: null,
      customHeight: null,
      speed: 1.0,
      bitrate: 0,
      keepAudio: true,
      qualityPreset: "auto",
      autoDownload: true,
    },

    presets: RESOLUTION_PRESETS,

    /* ── computed ───────────────────────────────────────────────── */
    get canStart() {
      return this.file && !this.processing;
    },

    get disabledCodecs() {
      return this.codecs.filter((c) => !c.supported);
    },

    get selectedCodecObj() {
      return this.codecs.find((c) => c.id === this.settings.codec) || null;
    },

    get selectedUnsupported() {
      const obj = this.selectedCodecObj;
      return obj && !obj.supported;
    },

    get unsupportedTooltip() {
      return this.selectedCodecObj?.tooltip || "Not supported";
    },

    get resolutionDisabled() {
      return (preset) => {
        if (!this.metadata?.video) return false;
        if (preset.id === "original" || preset.id === "custom") return false;

        const srcH = this.metadata.video.displayH;
        if (!srcH) return false;

        return preset.height != null && preset.height > srcH;
      };
    },

    get resolutionTooltip() {
      return (preset) => {
        if (!this.metadata?.video) return "";
        if (preset.id === "original" || preset.id === "custom") return "";

        const srcH = this.metadata.video.displayH;
        if (!srcH) return "";

        if (preset.height != null && preset.height > srcH) {
          return `Higher than source (${srcH}p)`;
        }
        return "";
      };
    },

    /* ── init: detect codecs ────────────────────────────────────── */
    async init() {
      await this._detectCodecs();
    },

    async _detectCodecs() {
      try {
        const mb = await import("mediabunny");
        const tests = [
          { id: "h264", label: "H.264 (MP4)", mbCodec: "avc" },
          { id: "hevc", label: "H.265 / HEVC (MP4)", mbCodec: "hevc" },
          { id: "vp8", label: "VP8 (WebM)", mbCodec: "vp8" },
          { id: "vp9", label: "VP9 (WebM)", mbCodec: "vp9" },
          { id: "av1", label: "AV1 (MP4/WebM)", mbCodec: "av1" },
        ];

        const results = await Promise.all(
          tests.map(async (t) => {
            try {
              const ok = await mb.canEncodeVideo(t.mbCodec, {
                width: 1280,
                height: 720,
                bitrate: 1e6,
              });
              return {
                id: t.id,
                label: t.label,
                supported: ok,
                tooltip: ok
                  ? ""
                  : `Browser does not support encoding ${t.label}`,
              };
            } catch {
              return {
                id: t.id,
                label: t.label,
                supported: false,
                tooltip: `Cannot check ${t.label}`,
              };
            }
          }),
        );

        this.codecs = results;
        const first = results.find((c) => c.supported);
        if (first) this.settings.codec = first.id;
      } catch (e) {
        console.warn("[codecs] detection failed", e);
        this.codecs = [
          { id: "h264", label: "H.264 (MP4)", supported: true, tooltip: "" },
        ];
      }
    },

    /* ── file handling ──────────────────────────────────────────── */
    handleFileSelect(event) {
      const f = event.target.files?.[0];
      if (f) this.setFile(f);
    },

    handleDrop(event) {
      this.dragging = false;
      const f = event.dataTransfer?.files?.[0];
      if (f) this.setFile(f);
    },

    async setFile(file) {
      this.file = file;
      this.error = null;
      this.downloadUrl = null;
      this.metadata = null;

      try {
        const { Input, ALL_FORMATS, BlobSource } = await import("mediabunny");
        const input = new Input({
          source: new BlobSource(file),
          formats: ALL_FORMATS,
        });

        const size = await input.source.getSize();
        const duration = await input.computeDuration();
        const firstTs = await input.getFirstTimestamp();
        const effDuration = duration - firstTs;
        const containerType = input.format?.name ?? "unknown";

        const videoTrack = await input.getPrimaryVideoTrack();
        const audioTrack = await input.getPrimaryAudioTrack();

        let videoInfo = null;
        if (videoTrack) {
          const fps = videoTrack.duration ? 1 / videoTrack.duration : NaN;
          const ar = videoTrack.pixelAspectRatio;
          const par =
            ar &&
            ar.numerator != null &&
            ar.denominator != null &&
            ar.denominator !== 0
              ? `${ar.numerator}:${ar.denominator}`
              : "1:1";
          const cs = videoTrack.colorSpace;
          const colorName =
            cs && cs.name ? cs.name : cs ? JSON.stringify(cs) : "unknown";
          videoInfo = {
            codec: videoTrack.codec,
            codedW: videoTrack.codedWidth,
            codedH: videoTrack.codedHeight,
            displayW: videoTrack.displayWidth,
            displayH: videoTrack.displayHeight,
            fps: isFinite(fps) ? fps.toFixed(2) : "variable",
            rotation: videoTrack.rotation || 0,
            bitrate: videoTrack.bitrate,
            aspectRatio: par,
            colorSpace: colorName,
            keyFrameInterval: videoTrack.keyFrameDistance,
          };
        }

        let audioInfo = null;
        if (audioTrack) {
          audioInfo = {
            codec: audioTrack.codec,
            channels: audioTrack.numberOfChannels,
            channelLabel: this._channelLabel(audioTrack.numberOfChannels),
            sampleRate: audioTrack.sampleRate,
            bitrate: audioTrack.bitrate,
          };
        }

        const totalBitrate = effDuration > 0 ? (size * 8) / effDuration : null;

        this.metadata = {
          fileName: file.name,
          fileSize: size,
          fileSizeStr: this.formatSize(size),
          container: containerType,
          duration: effDuration,
          durationStr: this.formatDuration(effDuration),
          totalBitrate,
          totalBitrateStr: totalBitrate
            ? `${(totalBitrate / 1000).toFixed(0)} kbps`
            : "N/A",
          video: videoInfo,
          audio: audioInfo,
        };

        // Auto-suggest 720p for sources > 720p
        if (videoInfo && videoInfo.displayH > 720) {
          this.settings.resolution = "720";
        }
      } catch (e) {
        console.warn("[app] metadata read failed", e);
      }
    },

    clearFile() {
      this.file = null;
      this.metadata = null;
      this.error = null;
      this.downloadUrl = null;
      this.settings.resolution = "original";
      this.settings.customWidth = null;
      this.settings.customHeight = null;
      if (this.$refs?.fileInput) this.$refs.fileInput.value = "";
    },

    /* ── resolution safety: never upscale ───────────────────────── */
    warning: null,

    setResolution(id) {
      const srcH = this.metadata?.video?.displayH;
      if (!srcH || id === "original") {
        this.settings.resolution = id;
        return;
      }

      const preset = this.presets.find((p) => p.id === id);
      if (!preset) return;

      if (preset.height === "custom") {
        this.settings.resolution = "custom";
        return;
      }

      if (preset.height != null && preset.height > srcH) {
        // Cap to original resolution
        this.settings.resolution = "original";
        this.warning = `Selected resolution would exceed source (${srcH}p). Capped to original.`;
        // Auto-clear warning after 3s
        setTimeout(() => {
          this.warning = null;
        }, 3000);
        return;
      }

      this.settings.resolution = id;
      this.warning = null;
    },

    /** Validate that custom dimensions don't exceed source */
    validateCustomResolution() {
      const srcW = this.metadata?.video?.displayW;
      const srcH = this.metadata?.video?.displayH;
      if (!srcW || !srcH) return true;

      const cW = this.settings.customWidth;
      const cH = this.settings.customHeight;

      if (cW && cW > srcW) {
        this.settings.customWidth = srcW;
        this.warning = `Width capped to source (${srcW}px).`;
        setTimeout(() => {
          this.warning = null;
        }, 3000);
      }
      if (cH && cH > srcH) {
        this.settings.customHeight = srcH;
        this.warning = `Height capped to source (${srcH}px).`;
        setTimeout(() => {
          this.warning = null;
        }, 3000);
      }
      return true;
    },

    /* ── codec tooltip ──────────────────────────────────────────── */
    onCodecHover() {
      if (this.selectedUnsupported) {
        this.hoveredCodec = this.settings.codec;
      } else {
        this.hoveredCodec = null;
      }
    },

    showBadgeTooltip(id) {
      if (this.badgeTooltipId === id) {
        this.badgeTooltipId = null;
      } else {
        this.badgeTooltipId = id;
        alert(this.codecs.find((c) => c.id === id)?.tooltip || "Not supported");
      }
    },

    /* ── processing ─────────────────────────────────────────────── */
    async startProcessing() {
      if (!this.file || this.processing) return;

      // Safety check: custom resolution must not exceed source
      if (this.settings.resolution === "custom") {
        this.validateCustomResolution();
        if (this.warning) {
          this.error = this.warning;
          return;
        }
        if (!this.settings.customWidth || !this.settings.customHeight) {
          this.error =
            "Please enter both width and height for custom resolution.";
          return;
        }
      }

      this.processing = true;
      this.progress = 0;
      this.error = null;
      this.statusMessage = "Initialising…";
      this.downloadUrl = null;
      this.currentConversion = null;

      try {
        const { processVideo } = await import("./core/pipeline.js");

        const result = await processVideo({
          file: this.file,
          codec: this.settings.codec,
          resolution: this.settings.resolution,
          customWidth: this.settings.customWidth || undefined,
          customHeight: this.settings.customHeight || undefined,
          speed: this.settings.speed || 1.0,
          keepAudio: this.settings.keepAudio,
          bitrate: this.settings.bitrate ? this.settings.bitrate * 1000 : 0,
          qualityPreset: this.settings.qualityPreset,
          onProgress: (p) => {
            this.progress = p;
          },
          onStatus: (msg) => {
            this.statusMessage = msg;
          },
          onConversionReady: (conv) => {
            this.currentConversion = conv;
          },
        });

        const blob = new Blob([result.buffer], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        this.downloadUrl = url;
        this.outputFileName = result.fileName;

        const pct = ((result.outputSize / result.inputSize) * 100).toFixed(1);
        this.statusMessage = `Done! ${this.formatSize(result.outputSize)} (${pct}% of source)`;

        if (this.settings.autoDownload) {
          this._triggerDownload(url, result.fileName);
        }
      } catch (err) {
        console.error("[app] processing error", err);
        if (err?.name === "ConversionCanceledError") {
          this.statusMessage = "Cancelled.";
        } else {
          this.error = err?.message ?? "Unexpected error during processing.";
          this.statusMessage = "";
        }
      } finally {
        this.processing = false;
        this.currentConversion = null;
      }
    },

    async cancelProcessing() {
      if (this.currentConversion) {
        await this.currentConversion.cancel();
      }
    },

    /* ── helpers ─────────────────────────────────────────────────── */
    _channelLabel(n) {
      const map = {
        1: "Mono",
        2: "Stereo",
        6: "5.1 Surround",
        8: "7.1 Surround",
      };
      return map[n] || `${n}ch`;
    },

    formatSize(bytes) {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      let i = 0,
        n = bytes;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
      }
      return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
    },

    formatDuration(sec) {
      if (!sec || isNaN(sec)) return "--:--";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      if (h > 0) {
        return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    },

    _triggerDownload(url, filename) {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      requestAnimationFrame(() => {
        if (a.parentNode) a.remove();
      });
    },
  };
}
