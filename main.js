/**
 * main.js - Alpine.js application controller (zero static MediaBunny imports).
 * Exports a factory function for Alpine registration.
 */

import {
  RESOLUTION_PRESETS,
  CODEC_DEFINITIONS,
  AUDIO_CODEC_DEFINITIONS,
  getOutputContainer,
  normalizeAudioCodec,
} from "./core/video.js";

/** SDR-only codecs for HDR warning */
const SDR_ONLY_CODEC_IDS = ["h264", "vp8"];

/** Minimal i18n: pick strings by the page language (<html lang> / browser locale). */
const isZh = () =>
  (document.documentElement.lang || navigator.language || "en")
    .toLowerCase()
    .startsWith("zh");

const I18N = {
  targetSizeExceeded: (out, tgt) =>
    isZh()
      ? `压缩后大小 ${out} 仍超过目标 ${tgt}。可尝试降低分辨率或调小目标大小。`
      : `Compressed size ${out} still exceeds target ${tgt}. Try lowering the resolution or target size.`,
  gpuAccel: () =>
    isZh()
      ? "使用前请在浏览器设置中关闭实验性图形 API / GPU 加速，否则可能导致乱码、黑屏或转换失败。"
      : "Before using, disable Experimental Graphics API / GPU acceleration in your browser settings, otherwise it may cause garbled output, black screen, or conversion failure.",
  copyError: () =>
    isZh()
      ? "复制错误信息失败，请打开开发者工具查看 console.debug 日志。"
      : "Failed to copy error info. Open DevTools to view the console.debug log.",
  issueConfirm: () =>
    isZh()
      ? "错误信息已复制，是否提交 GitHub Issue？"
      : "Error info copied. Open a GitHub Issue?",
  stall: () =>
    isZh()
      ? "编码卡死：WebCodecs 硬件编码器无响应。请勾选「软件编码」，或在浏览器设置中关闭实验性图形 API / GPU 加速后重试。"
      : "Encoding stalled: the WebCodecs hardware encoder is unresponsive. Check \"Software encode\", or disable Experimental Graphics API / GPU acceleration in your browser settings and retry.",
};

export default function createApp() {
  return {
    /* ── state ──────────────────────────────────────────────────── */
    file: null,
    dragging: false,
    processing: false,
    progress: 0,
    error: null,
    errorDetails: "",
    errorCopied: false,
    statusMessage: "",
    downloadUrl: null,
    outputFileName: "",

    metadata: null,
    codecs: [],
    audioCodecs: [],
    sourceDecodeSupported: null,
    currentConversion: null,

    settings: {
      codec: "h264",
      outputMode: "muxed",
      resolution: "original",
      customHeight: null,
      speed: 1.0,
      bitrate: 0,
      bitrateMode: "auto",
      targetSizeMB: 10,
      audioCodec: "auto",
      audioBitrate: 128,
      qualityPreset: "auto",
      softwareEncode: false,
      autoDownload: true,
    },

    isHdrSource: false,

    presets: RESOLUTION_PRESETS,

    /* ── computed ───────────────────────────────────────────────── */
    get canStart() {
      return this.file && !this.processing && this.sourceDecodeSupported !== false;
    },

    get selectedCodecObj() {
      return this.codecs.find((c) => c.id === this.settings.codec) || null;
    },

    get audioCodecChoices() {
      const outputContainer = this.file
        ? getOutputContainer(this.file.name)
        : "mp4";
      const audioOnly = this.settings.outputMode === "audio-only";
      const allowed = audioOnly
        ? this.audioCodecs.map((c) => c.id)
        : (outputContainer === "webm" ? ["opus", "vorbis"] : ["aac", "mp3"]);
      const sourceCodec = normalizeAudioCodec(this.metadata?.audio?.codec);
      const autoLabel = sourceCodec
        ? `Auto (${sourceCodec} keep source codec)`
        : "Auto (keep source codec)";
      return [
        { id: "auto", label: autoLabel },
        ...this.audioCodecs
          .filter((c) => allowed.includes(c.id))
          .sort((a, b) => {
            const order = ["aac", "mp3", "opus", "vorbis"];
            return order.indexOf(a.id) - order.indexOf(b.id);
          }),
      ];
    },

    get selectedUnsupported() {
      const obj = this.selectedCodecObj;
      return obj && !obj.encodeSupported;
    },

    get unsupportedTooltip() {
      const codec = this.selectedCodecObj;
      if (!codec) return "";
      const warnings = [];
      if (!codec.encodeSupported) warnings.push("Encoding not supported");
      if (codec.outputDecodeSupported === false) {
        warnings.push("Output playback not supported");
      }
      return warnings.join(". ") || "Supported";
    },

    get showVideoOptions() {
      return this.settings.outputMode !== "audio-only";
    },

    get showAudioOptions() {
      return this.settings.outputMode !== "video-only";
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

    syncAudioCodec() {
      if (!this.audioCodecChoices.some((c) => c.id === this.settings.audioCodec)) {
        this.settings.audioCodec = "auto";
      }
    },

    setOutputMode(mode) {
      this.settings.outputMode = mode;
      if (mode === "audio-only") {
        const preferred = ["aac", "mp3"].find((id) =>
          this.audioCodecs.some((codec) => codec.id === id),
        );
        if (preferred) {
          this.settings.audioCodec = preferred;
          return;
        }
      }
      this.syncAudioCodec();
    },

    /* ── init: detect codecs ────────────────────────────────────── */
    async init() {
      await this._detectCodecs();
    },

    async _detectCodecs() {
      try {
        const mb = await import("mediabunny");
        await this._registerAudioFallbacks(mb);

        const results = await Promise.all(
          CODEC_DEFINITIONS.map(async (def) => {
            let encodeOk = false;
            let outputDecodeOk = null;

            // Check encoding support
            try {
              encodeOk = await mb.canEncodeVideo(def.mbCodec, {
                width: 1280,
                height: 720,
                bitrate: 1e6,
              });
            } catch {}

            // Check whether the browser can play the generated output.
            if (navigator.mediaCapabilities) {
              const mimeTypes = def.outputMimeTypes || [def.outputMimeType];
              const videoElement = document.createElement("video");
              const decodeResults = await Promise.all(
                mimeTypes.map(async (contentType) => {
                  try {
                    const mediaInfo = await navigator.mediaCapabilities.decodingInfo({
                      type: "file",
                      video: {
                        contentType,
                        width: 1280,
                        height: 720,
                        bitrate: 1e6,
                        framerate: 30,
                      },
                    });
                    return {
                      supported: mediaInfo.supported || videoElement.canPlayType(contentType) !== "",
                    };
                  } catch {
                    return {
                      supported: videoElement.canPlayType(contentType) !== "",
                    };
                  }
                }),
              );
              const supportedDecode = decodeResults.find((result) => result.supported);
              outputDecodeOk = Boolean(supportedDecode);
            }

            // MediaCapabilities describes file playback, while this app
            // processes tracks through WebCodecs. Accept a positive native
            // decoder result as well, especially for codecs such as HEVC
            // whose hvc1/hev1 MIME forms vary between browsers.
            if (!outputDecodeOk && "VideoDecoder" in window) {
              const decoderCodecs = [def.webCodecsCodec];
              if (def.id === "hevc") decoderCodecs.push("hvc1.1.6.L93.B0");
              const decoderResults = await Promise.all(
                decoderCodecs.map(async (codec) => {
                  try {
                    return await VideoDecoder.isConfigSupported({
                      codec,
                      codedWidth: 1280,
                      codedHeight: 720,
                    });
                  } catch {
                    return null;
                  }
                }),
              );
              outputDecodeOk = decoderResults.some((result) => result?.supported);
            }

            const result = {
              id: def.id,
              label: def.label,
              webCodecsCodec: def.webCodecsCodec,
              encodeSupported: encodeOk,
              outputDecodeSupported: outputDecodeOk,
            };
            return result;
          }),
        );

        this.codecs = results;
        const first = results.find((c) => c.encodeSupported);
        if (first) this.settings.codec = first.id;

        const audioResults = await Promise.all(
          AUDIO_CODEC_DEFINITIONS.map(async (def) => {
            let encodeSupported = false;
            try {
              encodeSupported = await mb.canEncodeAudio(def.id, {
                numberOfChannels: 2,
                sampleRate: 48000,
                bitrate: 128000,
              });
            } catch {}
            return { ...def, encodeSupported };
          }),
        );
        this.audioCodecs = audioResults.filter((c) => c.encodeSupported);
        this.syncAudioCodec();
      } catch (e) {
        console.warn("[codecs] detection failed", e);
        this.codecs = [
          { id: "h264", label: "H.264", webCodecsCodec: "avc1.42001f", encodeSupported: true, outputDecodeSupported: null },
        ];
        this.audioCodecs = [];
      }
    },

    async _registerAudioFallbacks(mb) {
      const fallbacks = [
        ["aac", "./vendor/mediabunny-aac-encoder.min.mjs", "registerAacEncoder"],
        ["mp3", "./vendor/mediabunny-mp3-encoder.min.mjs", "registerMp3Encoder"],
      ];
      for (const [codec, path, register] of fallbacks) {
        if (await mb.canEncodeAudio(codec)) continue;
        try {
          const plugin = await import(path);
          plugin[register]();
        } catch (error) {
          console.warn(`[codecs] ${codec} fallback unavailable`, error);
        }
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
      this.errorDetails = "";
      this.errorCopied = false;
      this.downloadUrl = null;
      this.metadata = null;
      this.sourceDecodeSupported = null;

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
        const inputFormat = await input.getFormat();
        const containerType = inputFormat?.name ?? "unknown";

        const videoTrack = await input.getPrimaryVideoTrack();
        const audioTrack = await input.getPrimaryAudioTrack();

        this.sourceDecodeSupported = videoTrack
          ? await this._checkSourceDecode(videoTrack)
          : false;

        let videoInfo = null;
        if (videoTrack) {
          const frameRateMetrics = await videoTrack.computeFrameRateMetrics({
            targetPacketCount: 256,
          });
          let videoBitrate = null;
          try {
            const videoStats = await videoTrack.computePacketStats();
            videoBitrate = videoStats?.averageBitrate ?? null;
          } catch {}
          const fps = frameRateMetrics?.bestGuessFrameRate ?? NaN;
          const ar = await videoTrack.getPixelAspectRatio();
          const par =
            ar &&
            ar.numerator != null &&
            ar.denominator != null &&
            ar.denominator !== 0
              ? `${ar.numerator}:${ar.denominator}`
              : "1:1";
          const cs = await videoTrack.getColorSpace();
          const colorName = cs
            ? cs.name || [cs.primaries, cs.transfer, cs.matrix].filter(Boolean).join("/") || "unknown"
            : "unknown";
          videoInfo = {
            codec: await videoTrack.getCodec(),
            codedW: await videoTrack.getCodedWidth(),
            codedH: await videoTrack.getCodedHeight(),
            displayW: await videoTrack.getDisplayWidth(),
            displayH: await videoTrack.getDisplayHeight(),
            fps: isFinite(fps) ? fps.toFixed(2) : "variable",
            rotation: (await videoTrack.getRotation()) || 0,
            bitrate: videoBitrate,
            aspectRatio: par,
            colorSpace: colorName,
          };
        }

        let audioInfo = null;
        if (audioTrack) {
          const audioChannels = await audioTrack.getNumberOfChannels();
          const audioSampleRate = await audioTrack.getSampleRate();
          let audioBitrate = null;
          try {
            const audioStats = await audioTrack.computePacketStats();
            audioBitrate = audioStats?.averageBitrate ?? null;
          } catch {}
          audioInfo = {
            codec: await audioTrack.getCodec(),
            channels: audioChannels,
            channelLabel: this._channelLabel(audioChannels),
            sampleRate: audioSampleRate,
            bitrate: audioBitrate,
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

        // Detect HDR source for user awareness
        this.isHdrSource = false;
        if (videoInfo?.colorSpace) {
          const cs = videoInfo.colorSpace.toLowerCase();
          if (cs.includes("bt2020") || cs.includes("pq") || cs.includes("hlg") || cs.includes("hdr")) {
            this.isHdrSource = true;
          }
        }
      } catch (e) {
        console.warn("[app] metadata read failed", e);
        this.sourceDecodeSupported = false;
      }
    },

    async _checkSourceDecode(videoTrack) {
      if (!videoTrack) return false;
      return await videoTrack.canDecode();
    },

    clearFile() {
      this.file = null;
      this.metadata = null;
      this.error = null;
      this.errorDetails = "";
      this.errorCopied = false;
      this.sourceDecodeSupported = null;
      this.downloadUrl = null;
      this.settings.resolution = "original";
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

    /** Validate that custom height doesn't exceed source */
    validateCustomResolution() {
      const srcH = this.metadata?.video?.displayH;
      if (!srcH) return true;

      const cH = this.settings.customHeight;

      if (cH && cH > srcH) {
        this.settings.customHeight = srcH;
        this.warning = `Height capped to source (${srcH}px).`;
        setTimeout(() => {
          this.warning = null;
        }, 3000);
      }
      return true;
    },

    /* ── processing ─────────────────────────────────────────────── */
    async startProcessing() {
      if (!this.file || this.processing) return;
      if (this.sourceDecodeSupported === false) {
        this.error = "The selected video cannot be decoded by this browser.";
        return;
      }

      // Safety check: custom resolution must not exceed source
      if (this.settings.resolution === "custom") {
        this.validateCustomResolution();
        if (this.warning) {
          this.error = this.warning;
          return;
        }
        if (!this.settings.customHeight) {
          this.error = "Please enter a target height for custom resolution.";
          return;
        }
      }

      // Warn about HDR→SDR conversion
      if (this.isHdrSource && SDR_ONLY_CODEC_IDS.includes(this.settings.codec)) {
        this.warning = "HDR source will be converted to SDR. Colors may appear washed.";
        setTimeout(() => {
          this.warning = null;
        }, 5000);
      }

      this.processing = true;
      this.progress = 0;
      this.error = null;
      this.errorDetails = "";
      this.errorCopied = false;
      this.statusMessage = "Initialising…";
      if (this.downloadUrl) {
        URL.revokeObjectURL(this.downloadUrl);
      }
      this.downloadUrl = null;
      this.currentConversion = null;

      let finalBitrate = 0;
      let finalAudioBitrate = null;
      let targetBytes = 0;

      if (this.settings.qualityPreset === "auto") {
        switch (this.settings.bitrateMode) {
          case "manual":
            finalBitrate = this.settings.bitrate * 1000;
            break;
          case "size": {
            // Target is the TOTAL output file size (video + audio + container),
            // so we subtract the audio budget from the video side.
            const duration = this.metadata?.duration ?? 0;
            if (duration > 0) {
              const speed = this.settings.speed && this.settings.speed !== 1 ? this.settings.speed : 1;
              const outDur = duration / speed;
              targetBytes = this.settings.targetSizeMB * 1024 * 1024; // MiB (binary)
              let audioBytes = 0;
              if (this.settings.outputMode !== "video-only" && this.metadata?.audio) {
                const willTranscode = this.settings.audioCodec !== "auto";
                const estAudioBps = willTranscode
                  ? this.settings.audioBitrate * 1000
                  : (this.metadata.audio.bitrate || this.settings.audioBitrate * 1000);
                audioBytes = (estAudioBps * outDur) / 8; // bits → bytes
              }
              if (this.settings.outputMode === "audio-only") {
                finalBitrate = 0;
                finalAudioBitrate = Math.floor(targetBytes * 8 / outDur);
              } else {
                const videoBytes = Math.max(0, targetBytes - audioBytes);
                // floor at 1 so the pipeline honours the (tiny) budget instead of
                // falling back to estimateBitrate when videoBytes is 0
                finalBitrate = videoBytes > 0 ? Math.floor((videoBytes * 8) / outDur) : 1;
              }
            }
            break;
          }
          default:
            finalBitrate = 0;
        }
      }

      try {
        const { processVideo } = await import("./core/pipeline.js");

        const baseOpts = {
          file: this.file,
          codec: this.settings.codec,
          resolution: this.settings.resolution,
          customHeight: this.settings.customHeight || undefined,
          speed: this.settings.speed || 1.0,
          audioCodec: this.settings.audioCodec,
          audioBitrate: finalAudioBitrate ?? this.settings.audioBitrate * 1000,
          outputMode: this.settings.outputMode,
          qualityPreset: this.settings.qualityPreset,
          softwareEncode: this.settings.softwareEncode,
          onProgress: (p) => {
            this.progress = p;
          },
          onStatus: (msg) => {
            this.statusMessage = msg;
          },
          onConversionReady: (conv) => {
            this.currentConversion = conv;
          },
        };

        let result = await processVideo({ ...baseOpts, bitrate: finalBitrate });

        // In target-size mode, if the first encode still exceeds the target,
        // warn the user that they can lower the resolution or target size.
        if (this.settings.bitrateMode === "size" && result.outputSize > targetBytes) {
          const msg = I18N.targetSizeExceeded(
            this.formatSize(result.outputSize),
            this.formatSize(targetBytes),
          );
          this.statusMessage = msg;
          alert(msg);
        }

        const blob = new Blob([result.file], { type: result.mimeType });
        const url = URL.createObjectURL(blob);
        this.downloadUrl = url;
        this.outputFileName = result.fileName;

        const pct = ((result.outputSize / result.inputSize) * 100).toFixed(1);
        this.statusMessage = `Done! ${this.formatSize(result.outputSize)} (${pct}% of source)`;

        if (this.settings.autoDownload) {
          this._triggerDownload(url, result.fileName);
        }
      } catch (err) {
        if (err?.name === "ConversionCanceledError") {
          this.statusMessage = "Cancelled.";
        } else if (err?.name === "ConversionStalledError") {
          this.statusMessage = I18N.stall();
        } else {
          this.errorDetails = this._formatErrorDetails(err);
          console.debug("[app] processing error details:\n%s", this.errorDetails);
          this.error = err?.message ?? "Unexpected error during processing.";
          alert(I18N.gpuAccel());
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

    _formatErrorDetails(error) {
      return [
        "[Video Compressor Error]",
        `message: ${error?.message ?? error ?? "Unknown error"}`,
        `name: ${error?.name ?? "Error"}`,
        error?.stack ? `stack:\n${error.stack}` : "",
      ].filter(Boolean).join("\n");
    },

    async copyError() {
      const text = this.errorDetails || this.error || "Unknown error";
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (error) {
        console.debug("[app] copy error details failed", error);
      }
      if (!copied) {
        alert(I18N.copyError());
        return;
      }

      this.errorCopied = true;
      if (confirm(I18N.issueConfirm())) {
        const params = new URLSearchParams({
          title: "Video processing failed",
          body: text.slice(0, 8000),
        });
        window.open(
          `https://github.com/kaixinol/webcodecs-compressor/issues/new?${params}`,
          "_blank",
          "noopener,noreferrer",
        );
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
