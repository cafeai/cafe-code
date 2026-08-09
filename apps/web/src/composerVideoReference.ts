import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@cafecode/contracts";

export const COMPOSER_VIDEO_REFERENCE_MAX_BYTES = 64 * 1024 * 1024;
export const COMPOSER_VIDEO_REFERENCE_MAX_DURATION_SECONDS = 30 * 60;
export const COMPOSER_VIDEO_REFERENCE_MAX_FRAMES = 12;

const VIDEO_METADATA_TIMEOUT_MS = 15_000;
const VIDEO_SEEK_TIMEOUT_MS = 10_000;
const ANALYSIS_CANVAS_WIDTH = 64;
const ANALYSIS_CANVAS_HEIGHT = 36;
const VIDEO_NAME_MAX_CHARS = 255;

const VIDEO_MIME_BY_EXTENSION = new Map<string, string>([
  [".webm", "video/webm"],
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".ogv", "video/ogg"],
  [".ogg", "video/ogg"],
  [".mkv", "video/x-matroska"],
]);

const VIDEO_MIME_TYPES = new Set(VIDEO_MIME_BY_EXTENSION.values());

export type ComposerVideoMotionClass = "subtle" | "moderate" | "high";

export interface ComposerVideoReferenceFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface ComposerVideoFrameSummary {
  readonly meanFrameDelta: number;
  readonly loopSimilarity: number;
  readonly motionClass: ComposerVideoMotionClass;
  readonly palette: readonly string[];
}

export interface ComposerVideoReferenceAnalysis extends ComposerVideoFrameSummary {
  readonly sourceName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
  readonly sampleTimestampsSeconds: readonly number[];
  readonly audioAnalyzed: false;
}

export interface ComposerVideoReferenceResult {
  readonly contactSheet: File;
  readonly analysis: ComposerVideoReferenceAnalysis;
}

type ComposerVideoReferenceCreator = (file: File) => Promise<ComposerVideoReferenceResult>;

let composerVideoReferenceCreatorOverride: ComposerVideoReferenceCreator | null = null;

/** Browser-test seam; production callers must leave this unset. */
export function __setComposerVideoReferenceCreatorForTests(
  creator: ComposerVideoReferenceCreator | null,
): void {
  composerVideoReferenceCreatorOverride = creator;
}

function extensionOf(name: string): string {
  const normalized = name.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex >= 0 ? normalized.slice(dotIndex) : "";
}

export function normalizeComposerVideoReferenceName(name: string): string {
  const baseName = name.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = Array.from(baseName.normalize("NFC"), (character) => {
    const codePoint = character.codePointAt(0);
    const unsafe =
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069) ||
        codePoint === 0x5b ||
        codePoint === 0x5d);
    return unsafe ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, VIDEO_NAME_MAX_CHARS).join("") || "video";
}

export function detectComposerVideoMimeType(
  file: Pick<ComposerVideoReferenceFile, "name" | "type">,
): string | null {
  const mimeEssence = file.type.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (VIDEO_MIME_TYPES.has(mimeEssence) || mimeEssence.startsWith("video/")) return mimeEssence;
  return VIDEO_MIME_BY_EXTENSION.get(extensionOf(file.name)) ?? null;
}

export function isComposerVideoReferenceFile(
  file: Pick<ComposerVideoReferenceFile, "name" | "type">,
): boolean {
  return detectComposerVideoMimeType(file) !== null;
}

export function buildVideoSampleTimestamps(
  durationSeconds: number,
  maxFrames = COMPOSER_VIDEO_REFERENCE_MAX_FRAMES,
): readonly number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const safeMaxFrames = Math.max(1, Math.min(COMPOSER_VIDEO_REFERENCE_MAX_FRAMES, maxFrames));
  const frameCount = Math.min(safeMaxFrames, Math.max(4, Math.ceil(durationSeconds / 2) + 1));
  if (frameCount === 1) return [Math.min(durationSeconds / 2, durationSeconds - 0.001)];

  const edgeInset = Math.min(0.05, durationSeconds * 0.01);
  const start = edgeInset;
  const end = Math.max(start, durationSeconds - edgeInset);
  return Array.from({ length: frameCount }, (_, index) => {
    const progress = index / (frameCount - 1);
    return start + (end - start) * progress;
  });
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function meanRgbDelta(first: Uint8ClampedArray, second: Uint8ClampedArray): number {
  if (first.length !== second.length || first.length === 0) return 0;
  let total = 0;
  let channels = 0;
  for (let index = 0; index + 3 < first.length; index += 4) {
    if (first[index + 3] === 0 || second[index + 3] === 0) continue;
    total +=
      Math.abs((first[index] ?? 0) - (second[index] ?? 0)) +
      Math.abs((first[index + 1] ?? 0) - (second[index + 1] ?? 0)) +
      Math.abs((first[index + 2] ?? 0) - (second[index + 2] ?? 0));
    channels += 3;
  }
  return channels === 0 ? 0 : total / (channels * 255);
}

export function summarizeVideoFrameSamples(
  samples: readonly Uint8ClampedArray[],
): ComposerVideoFrameSummary {
  if (samples.length === 0) {
    return { meanFrameDelta: 0, loopSimilarity: 0, motionClass: "subtle", palette: [] };
  }

  let totalDelta = 0;
  for (let index = 1; index < samples.length; index += 1) {
    totalDelta += meanRgbDelta(samples[index - 1]!, samples[index]!);
  }
  const meanFrameDelta = samples.length > 1 ? totalDelta / (samples.length - 1) : 0;
  const loopSimilarity =
    samples.length > 1 ? clampUnit(1 - meanRgbDelta(samples[0]!, samples.at(-1)!)) : 1;
  const motionClass: ComposerVideoMotionClass =
    meanFrameDelta < 0.035 ? "subtle" : meanFrameDelta < 0.12 ? "moderate" : "high";

  const colorCounts = new Map<number, number>();
  for (const sample of samples) {
    for (let index = 0; index + 3 < sample.length; index += 16) {
      if ((sample[index + 3] ?? 0) < 128) continue;
      const red = Math.min(224, Math.floor((sample[index] ?? 0) / 32) * 32);
      const green = Math.min(224, Math.floor((sample[index + 1] ?? 0) / 32) * 32);
      const blue = Math.min(224, Math.floor((sample[index + 2] ?? 0) / 32) * 32);
      const key = (red << 16) | (green << 8) | blue;
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    }
  }
  const palette = [...colorCounts.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, 5)
    .map(([color]) => formatHex((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff));

  return { meanFrameDelta, loopSimilarity, motionClass, palette };
}

function formatTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

export function formatComposerVideoReference(analysis: ComposerVideoReferenceAnalysis): string {
  const safeName = normalizeComposerVideoReferenceName(analysis.sourceName);
  const timestamps = analysis.sampleTimestampsSeconds.map(formatTimestamp).join(", ");
  return [
    `[Attached visual video reference: ${safeName}]`,
    "EffectRecreationSpec v1",
    `Source: ${analysis.mimeType}; ${analysis.width}x${analysis.height}; ${analysis.durationSeconds.toFixed(2)} seconds`,
    `Chronological contact sheet: ${analysis.sampleTimestampsSeconds.length} frames at ${timestamps}`,
    `Visual motion: ${analysis.motionClass} (normalized mean frame delta ${analysis.meanFrameDelta.toFixed(3)})`,
    `Likely loop similarity: ${(analysis.loopSimilarity * 100).toFixed(1)}%`,
    `Dominant sampled palette: ${analysis.palette.join(", ") || "undetermined"}`,
    "Audio analyzed: no. This reference contains sampled visuals only.",
    "Analyze the attached contact sheet in chronological order. If asked to recreate this as a Cafe Code atmosphere, build executable pointer-transparent, lifecycle-safe animation code using the existing effect/profile contracts, WebGL2 acceleration where appropriate, and the Canvas2D fallback. Do not merely embed or replay the source video unless explicitly requested.",
    `[End visual video reference: ${safeName}]`,
  ].join("\n");
}

export function appendComposerVideoReference(input: {
  readonly prompt: string;
  readonly analysis: ComposerVideoReferenceAnalysis;
  readonly maxChars?: number;
}): string | null {
  const block = formatComposerVideoReference(input.analysis);
  const nextPrompt = `${input.prompt}${input.prompt.length > 0 ? "\n\n" : ""}${block}`;
  return nextPrompt.length <= (input.maxChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    ? nextPrompt
    : null;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  successEvent: "durationchange" | "loadedmetadata" | "loadeddata" | "seeked",
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener(successEvent, onSuccess);
      video.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser could not decode this video."));
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while decoding this video."));
    }, timeoutMs);
    video.addEventListener(successEvent, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function resolveFiniteVideoDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  if (video.duration !== Number.POSITIVE_INFINITY) return video.duration;

  // MediaRecorder-produced WebM files commonly omit a cue-derived duration,
  // which Chromium initially reports as Infinity. A far seek asks the demuxer
  // to discover the final cluster and publish the finite duration.
  const durationReady = waitForVideoEvent(video, "durationchange", VIDEO_SEEK_TIMEOUT_MS);
  video.currentTime = Number.MAX_SAFE_INTEGER;
  await durationReady;
  return video.duration;
}

async function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (Math.abs(video.currentTime - seconds) < 0.001 && video.readyState >= 2) return;
  const completion = waitForVideoEvent(video, "seeked", VIDEO_SEEK_TIMEOUT_MS);
  video.currentTime = seconds;
  await completion;
}

function drawContainedVideo(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  context.drawImage(
    video,
    left + (width - drawWidth) / 2,
    top + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not create the video contact sheet."));
      },
      "image/jpeg",
      quality,
    );
  });
}

export async function createComposerVideoReference(
  file: File,
): Promise<ComposerVideoReferenceResult> {
  if (composerVideoReferenceCreatorOverride) {
    return composerVideoReferenceCreatorOverride(file);
  }
  const safeName = normalizeComposerVideoReferenceName(file.name);
  const mimeType = detectComposerVideoMimeType(file);
  if (!mimeType) {
    throw new Error(`'${safeName}' is not a supported video reference.`);
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error(`'${safeName}' is empty or has an unsafe size.`);
  }
  if (file.size > COMPOSER_VIDEO_REFERENCE_MAX_BYTES) {
    throw new Error(`'${safeName}' exceeds the 64 MiB local video-analysis limit.`);
  }

  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(file);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    const metadataReady = waitForVideoEvent(video, "loadedmetadata", VIDEO_METADATA_TIMEOUT_MS);
    video.load();
    await metadataReady;
    if (video.readyState < 2) {
      await waitForVideoEvent(video, "loadeddata", VIDEO_METADATA_TIMEOUT_MS);
    }

    const durationSeconds = await resolveFiniteVideoDuration(video);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`'${safeName}' does not report a finite video duration.`);
    }
    if (durationSeconds > COMPOSER_VIDEO_REFERENCE_MAX_DURATION_SECONDS) {
      throw new Error(`'${safeName}' exceeds the 30 minute local video-analysis limit.`);
    }
    if (
      !Number.isSafeInteger(video.videoWidth) ||
      !Number.isSafeInteger(video.videoHeight) ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0 ||
      video.videoWidth * video.videoHeight > 8_847_360
    ) {
      throw new Error(`'${safeName}' has unsupported video dimensions.`);
    }

    const sampleTimestampsSeconds = buildVideoSampleTimestamps(durationSeconds);
    const portrait = video.videoHeight > video.videoWidth;
    const columns = portrait ? 3 : 4;
    const rows = Math.ceil(sampleTimestampsSeconds.length / columns);
    const cellWidth = portrait ? 320 : 400;
    const cellHeight = portrait ? 440 : 240;
    const labelHeight = 24;
    const contactSheet = document.createElement("canvas");
    contactSheet.width = columns * cellWidth;
    contactSheet.height = rows * (cellHeight + labelHeight);
    const contactContext = contactSheet.getContext("2d");
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = ANALYSIS_CANVAS_WIDTH;
    analysisCanvas.height = ANALYSIS_CANVAS_HEIGHT;
    const analysisContext = analysisCanvas.getContext("2d", { willReadFrequently: true });
    if (!contactContext || !analysisContext) {
      throw new Error("This browser cannot analyze video frames with Canvas2D.");
    }
    contactContext.fillStyle = "#050505";
    contactContext.fillRect(0, 0, contactSheet.width, contactSheet.height);
    contactContext.font = "14px system-ui, sans-serif";
    contactContext.textBaseline = "middle";

    const samples: Uint8ClampedArray[] = [];
    for (const [index, timestamp] of sampleTimestampsSeconds.entries()) {
      await seekVideo(video, timestamp);
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = column * cellWidth;
      const top = row * (cellHeight + labelHeight);
      drawContainedVideo(contactContext, video, left, top, cellWidth, cellHeight);
      contactContext.fillStyle = "rgba(0, 0, 0, 0.82)";
      contactContext.fillRect(left, top + cellHeight, cellWidth, labelHeight);
      contactContext.fillStyle = "#f5f5f5";
      contactContext.fillText(
        formatTimestamp(timestamp),
        left + 8,
        top + cellHeight + labelHeight / 2,
      );

      analysisContext.drawImage(video, 0, 0, ANALYSIS_CANVAS_WIDTH, ANALYSIS_CANVAS_HEIGHT);
      samples.push(
        new Uint8ClampedArray(
          analysisContext.getImageData(0, 0, ANALYSIS_CANVAS_WIDTH, ANALYSIS_CANVAS_HEIGHT).data,
        ),
      );
    }

    let jpeg = await canvasToJpeg(contactSheet, 0.82);
    if (jpeg.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      jpeg = await canvasToJpeg(contactSheet, 0.64);
    }
    if (jpeg.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error(`The contact sheet for '${safeName}' exceeds the image attachment limit.`);
    }

    const baseName = safeName.replace(/\.[^.]+$/u, "") || "video";
    const summary = summarizeVideoFrameSamples(samples);
    return {
      contactSheet: new File([jpeg], `${baseName}-video-reference.jpg`, { type: "image/jpeg" }),
      analysis: {
        sourceName: safeName,
        mimeType,
        sizeBytes: file.size,
        durationSeconds,
        width: video.videoWidth,
        height: video.videoHeight,
        sampleTimestampsSeconds,
        audioAnalyzed: false,
        ...summary,
      },
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
