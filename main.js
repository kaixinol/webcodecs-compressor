/**
 * main.js - Alpine.js application controller (zero static MediaBunny imports).
 * Exports a factory function for Alpine registration.
 */

import {
  RESOLUTION_PRESETS,
  CODEC_DEFINITIONS,
  AUDIO_CODEC_DEFINITIONS,
  getOutputContainer,
} from "./core/video.js";

/** SDR-only codecs for HDR warning */
const SDR_ONLY_CODEC_IDS = ["h264", "vp8"];

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
    audioCodecs: [],
    sourceDecodeSupported: null,
    gpuDiagnosticStatus: "idle",
    gpuDiagnosticMessage: "",

    currentConversion: null,

    settings: {
      codec: "h264",
      outputMode: "muxed",
      resolution: "original",
      customWidth: null,
      customHeight: null,
      speed: 1.0,
      bitrate: 0,
      audioCodec: "auto",
      audioBitrate: 128,
      qualityPreset: "auto",
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
      const allowed = this.settings.outputMode === "audio-only"
        ? this.audioCodecs.map((c) => c.id)
        : (outputContainer === "webm" ? ["opus", "vorbis"] : ["aac"]);
      return [
        { id: "auto", label: "Auto (keep source codec)" },
        ...this.audioCodecs.filter((c) => allowed.includes(c.id)),
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

    async _testVideoCodec(codec) {
      if (!("VideoEncoder" in window) || !("VideoDecoder" in window)) {
        throw new Error("WebCodecs is unavailable");
      }

      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const chunks = [];
      const decodedColors = [];
      let encoder = null;
      let decoder = null;

      try {
        const config = {
          codec: codec.webCodecsCodec,
          width: canvas.width,
          height: canvas.height,
          bitrate: 500_000,
          framerate: 30,
          hardwareAcceleration: "prefer-hardware",
        };
        let encoderConfig = config;
        let hardwareRequested = true;
        let supported = await VideoEncoder.isConfigSupported(encoderConfig);
        if (!supported.supported) {
          // A browser may support the codec through MediaBunny or software
          // WebCodecs while rejecting the hardware preference. Retry without
          // the hint before treating the diagnostic as unavailable.
          encoderConfig = { ...config };
          delete encoderConfig.hardwareAcceleration;
          hardwareRequested = false;
          supported = await VideoEncoder.isConfigSupported(encoderConfig);
        }
        if (!supported.supported) {
          const error = new Error("Native WebCodecs configuration unsupported");
          error.code = "unsupported";
          throw error;
        }

        let decoderConfig = null;
        let encoderError = null;
        encoder = new VideoEncoder({
          output: (chunk, metadata) => {
            chunks.push(chunk);
            decoderConfig ||= metadata?.decoderConfig || null;
          },
          error: (error) => {
            encoderError = error;
          },
        });
        encoder.configure(supported.config || encoderConfig);

        for (const [timestamp, color] of [[0, "#e53935"], [33_333, "#1e88e5"]]) {
          context.fillStyle = color;
          context.fillRect(0, 0, canvas.width, canvas.height);
          const frame = new VideoFrame(canvas, { timestamp });
          encoder.encode(frame, { keyFrame: timestamp === 0 });
          frame.close();
        }
        await encoder.flush();
        if (encoderError) throw encoderError;
        encoder.close();
        encoder = null;

        if (!chunks.length) throw new Error("Encoder produced no frames");
        let decoderError = null;
        decoder = new VideoDecoder({
          output: (frame) => {
            try {
              context.drawImage(frame, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, 1, 1).data;
              decodedColors.push([pixels[0], pixels[1], pixels[2]]);
            } finally {
              frame.close();
            }
          },
          error: (error) => {
            decoderError = error;
          },
        });
        decoder.configure(decoderConfig || encoderConfig);
        for (const chunk of chunks) decoder.decode(chunk);
        await decoder.flush();
        if (decoderError) throw decoderError;
        if (decodedColors.length < 2) throw new Error("Decoder produced too few frames");

        const colorDistance = decodedColors[0].reduce(
          (sum, value, index) => sum + Math.abs(value - decodedColors[1][index]),
          0,
        );
        if (colorDistance < 30) throw new Error("Decoded test frames look identical");
        return { hardwareRequested };
      } finally {
        try { encoder?.close(); } catch {}
        try { decoder?.close(); } catch {}
      }
    },

    async runGpuDiagnostic() {
      if (this.gpuDiagnosticStatus === "running") return;

      this.gpuDiagnosticStatus = "running";
      this.gpuDiagnosticMessage = "";

      const codecs = this.codecs.filter(
        (codec) => codec.encodeSupported && codec.webCodecsCodec,
      );
      if (!codecs.length) {
        this.gpuDiagnosticStatus = "failed";
        this.gpuDiagnosticMessage = "No encodable video codecs detected";
        return;
      }

      const results = [];
      for (const codec of codecs) {
        try {
          const result = await this._testVideoCodec(codec);
          results.push(`${codec.label}: passed${result.hardwareRequested ? " (hardware preferred)" : " (software/standard path)"}`);
        } catch (error) {
          console.warn(`[diagnostic] ${codec.id} test failed`, error);
          const status = error?.code === "unsupported" ? "unavailable" : "failed";
          results.push(`${codec.label}: ${status} (${error?.message || "unknown error"})`);
        }
      }

      const failed = results.some((result) => result.includes(": failed"));
      const unavailable = results.some((result) => result.includes(": unavailable"));
      this.gpuDiagnosticStatus = failed ? "failed" : unavailable ? "partial" : "passed";
      this.gpuDiagnosticMessage = results.join("; ");
    },

    /* ── init: detect codecs ────────────────────────────────────── */
    async init() {
      await this._detectCodecs();
    },

    async _detectCodecs() {
      try {
        const mb = await import("mediabunny");

        const results = await Promise.all(
          CODEC_DEFINITIONS.map(async (def) => {
            let encodeOk = false;
            let outputDecodeOk = null;
            let hardwareDecode = null;

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
                      powerEfficient: mediaInfo.powerEfficient,
                    };
                  } catch {
                    return {
                      supported: videoElement.canPlayType(contentType) !== "",
                      powerEfficient: false,
                    };
                  }
                }),
              );
              const supportedDecode = decodeResults.find((result) => result.supported);
              outputDecodeOk = Boolean(supportedDecode);
              hardwareDecode = supportedDecode?.powerEfficient ?? false;
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

            const tooltipParts = [];
            if (!encodeOk) tooltipParts.push("Encode not supported");
            if (outputDecodeOk === false) tooltipParts.push("Output may not play in this browser");
            if (outputDecodeOk && hardwareDecode === false) tooltipParts.push("May not use hardware acceleration");

            const result = {
              id: def.id,
              label: def.label,
              audioCodecs: def.audioCodecs,
              webCodecsCodec: def.webCodecsCodec,
              encodeSupported: encodeOk,
              outputDecodeSupported: outputDecodeOk,
              hardwareDecode,
              tooltip: tooltipParts.join(". ") || "Encoding supported",
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
          { id: "h264", label: "H.264", audioCodecs: ["aac"], webCodecsCodec: "avc1.42001f", encodeSupported: true, outputDecodeSupported: null, hardwareDecode: null, tooltip: "" },
        ];
        this.audioCodecs = [];
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
          const videoBitrate = await videoTrack.getAverageBitrate();
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
          const colorName =
            cs && cs.name ? cs.name : cs ? JSON.stringify(cs) : "unknown";
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
            keyFrameInterval: videoTrack.keyFrameDistance,
          };
        }

        let audioInfo = null;
        if (audioTrack) {
          const audioChannels = await audioTrack.getNumberOfChannels();
          const audioSampleRate = await audioTrack.getSampleRate();
          const audioBitrate = await audioTrack.getAverageBitrate();
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
      this.sourceDecodeSupported = null;
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
        if (!this.settings.customWidth || !this.settings.customHeight) {
          this.error =
            "Please enter both width and height for custom resolution.";
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
          audioCodec: this.settings.audioCodec,
          audioBitrate: this.settings.audioBitrate * 1000,
          outputMode: this.settings.outputMode,
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
