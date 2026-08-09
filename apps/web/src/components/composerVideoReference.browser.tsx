import { describe, expect, it } from "vitest";

import {
  COMPOSER_VIDEO_REFERENCE_MAX_FRAMES,
  createComposerVideoReference,
} from "../composerVideoReference";

async function recordCanvasWebM(): Promise<File> {
  if (typeof MediaRecorder !== "function") {
    throw new Error("Chromium did not expose MediaRecorder for the WebM decoder smoke test.");
  }
  const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType) {
    throw new Error("Chromium did not expose a supported WebM recording codec.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 54;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas2D unavailable in browser smoke test.");
  const stream = canvas.captureStream(12);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener("error", () => reject(new Error("MediaRecorder failed.")), {
      once: true,
    });
  });

  try {
    recorder.start(100);
    for (let frame = 0; frame < 10; frame += 1) {
      context.fillStyle = frame % 2 === 0 ? "#00e050" : "#102040";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(frame * 8, 10, 12, 34);
      await new Promise((resolve) => window.setTimeout(resolve, 55));
    }
    recorder.stop();
    await stopped;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }

  const blob = new Blob(chunks, { type: "video/webm" });
  if (blob.size === 0) throw new Error("MediaRecorder created an empty WebM fixture.");
  return new File([blob], "generated-falling-reference.webm", { type: "video/webm" });
}

describe("composer video reference browser decoder", () => {
  it("decodes a real WebM into a bounded JPEG contact sheet and visual summary", async () => {
    const source = await recordCanvasWebM();
    const result = await createComposerVideoReference(source);

    expect(result.contactSheet.name).toBe("generated-falling-reference-video-reference.jpg");
    expect(result.contactSheet.type).toBe("image/jpeg");
    expect(result.contactSheet.size).toBeGreaterThan(100);
    expect(result.analysis.sourceName).toBe("generated-falling-reference.webm");
    expect(result.analysis.mimeType).toBe("video/webm");
    expect(result.analysis.width).toBe(96);
    expect(result.analysis.height).toBe(54);
    expect(result.analysis.durationSeconds).toBeGreaterThan(0);
    expect(result.analysis.sampleTimestampsSeconds.length).toBeGreaterThanOrEqual(4);
    expect(result.analysis.sampleTimestampsSeconds.length).toBeLessThanOrEqual(
      COMPOSER_VIDEO_REFERENCE_MAX_FRAMES,
    );
    expect(result.analysis.palette.length).toBeGreaterThan(0);
    expect(result.analysis.audioAnalyzed).toBe(false);
  });
});
