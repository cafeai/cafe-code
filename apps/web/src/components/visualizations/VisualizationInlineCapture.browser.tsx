import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";
import { afterEach, describe, expect, it } from "vitest";

import { captureInlineVisualization } from "./visualizationInlineCapture";

const frames: HTMLIFrameElement[] = [];
async function fixture(source: string, width = 300, height = 200) {
  const frame = document.createElement("iframe");
  frame.title = "Current inline chart PNG fixture";
  frame.style.cssText = `width:${width}px;height:${height}px;border:0;display:block`;
  frames.push(frame);
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  // This synthetic fixture permits only its own fixed inline code/data fonts;
  // no network, user profile, OS input, native host or live source is involved.
  frame.srcdoc = `<!doctype html><html data-cafe-visible="true"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><style>html,body{margin:0;width:100%;height:100%;box-sizing:border-box;overflow:hidden;--background:#16181c;color:#fff;font:14px 'DM Sans Variable',sans-serif}*{box-sizing:border-box}</style>${GENERATED_VISUALIZATION_FONT_APPENDIX}</head><body>${source}</body></html>`;
  document.body.append(frame);
  await loaded;
  await frame.contentDocument!.fonts.ready;
  return frame;
}

async function pixel(blob: Blob, x: number, y: number) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      color: Array.from(context.getImageData(x, y, 1, 1).data),
    };
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Inspect real decoded foreground pixels, not a declared scale or mocked
 * geometry. This fixture never allocates above the capture's own output. */
async function paintBounds(
  blob: Blob,
  matches: (red: number, green: number, blue: number, alpha: number) => boolean,
) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const values = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let left = bitmap.width,
      right = -1,
      top = bitmap.height,
      bottom = -1;
    for (let y = 0; y < bitmap.height; y++)
      for (let x = 0; x < bitmap.width; x++) {
        const offset = (y * bitmap.width + x) * 4;
        if (
          !matches(values[offset]!, values[offset + 1]!, values[offset + 2]!, values[offset + 3]!)
        )
          continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    expect(right).toBeGreaterThanOrEqual(left);
    expect(bottom).toBeGreaterThanOrEqual(top);
    return { width: right - left + 1, height: bottom - top + 1 };
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

describe("current direct-frame PNG capture", () => {
  afterEach(() => {
    for (const frame of frames.splice(0)) frame.remove();
  });

  it("captures full current HTML dimensions with resolved theme and fixed chat fonts", async () => {
    const frame = await fixture(
      '<div style="width:100%;height:100%;background:#2355ff;padding:12px"><h2>Current chart</h2><button style="background:#e5358f;color:white">Filter 30 days</button></div>',
    );
    const png = await captureInlineVisualization(frame, new AbortController().signal);
    expect(png.type).toBe("image/png");
    expect(await pixel(png, 250, 150)).toEqual({
      width: 300,
      height: 200,
      color: [35, 85, 255, 255],
    });
    expect(frame.contentDocument!.querySelector("button")?.textContent).toBe("Filter 30 days");
  });

  it("keeps actual SVG gradient paints without a network or stylesheet reference", async () => {
    const frame = await fixture(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" style="display:block"><defs><linearGradient id="paint"><stop offset="0%" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/></linearGradient></defs><rect width="300" height="200" fill="url(#paint)"/></svg>',
    );
    const png = await captureInlineVisualization(frame, new AbortController().signal);
    const left = (await pixel(png, 10, 100)).color;
    const right = (await pixel(png, 290, 100)).color;
    expect(left[0]).toBeGreaterThan(230);
    expect(left[2]).toBeLessThan(25);
    expect(right[0]).toBeLessThan(25);
    expect(right[2]).toBeGreaterThan(230);
  });

  it("uniformly captures a 4096px chat frame into the unchanged 1600px output without stretching paints or fonts", async () => {
    const frame = await fixture(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="512" style="display:block;position:absolute;left:0;top:0"><circle cx="256" cy="256" r="128" fill="#00ffff"/></svg><span id="wide-label" style="position:absolute;left:1200px;top:100px;font-size:80px;font-weight:400;line-height:1;white-space:pre;color:#ffffff">Wide</span>',
      4096,
      512,
    );
    const label = frame.contentDocument!.getElementById("wide-label")!;
    const style = frame.contentWindow!.getComputedStyle(label);
    expect(style.fontFamily).toContain("DM Sans Variable");
    // Canvas text measurement uses this exact loaded frame's FontFaceSet,
    // not an ambient worker page that might resolve the same family to fallback.
    const fontProbe = frame.contentDocument!.createElement("canvas");
    const context = fontProbe.getContext("2d")!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ink = context.measureText(label.textContent!);
    fontProbe.width = 0;
    fontProbe.height = 0;
    const originalDocument = frame.contentDocument;
    const png = await captureInlineVisualization(frame, new AbortController().signal);
    expect(await pixel(png, 1500, 150)).toEqual({
      width: 1600,
      height: 200,
      color: [22, 24, 28, 255],
    });
    const circle = await paintBounds(
      png,
      (r, g, b, a) => r < 10 && g > 245 && b > 245 && a === 255,
    );
    expect(circle.width).toBe(100);
    expect(circle.height).toBe(100);
    const text = await paintBounds(png, (r, g, b, a) => r > 245 && g > 245 && b > 245 && a === 255);
    const scale = 1600 / 4096;
    expect(
      Math.abs(text.width - (ink.actualBoundingBoxLeft + ink.actualBoundingBoxRight) * scale),
    ).toBeLessThan(3);
    expect(
      Math.abs(text.height - (ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent) * scale),
    ).toBeLessThan(3);
    // Scaling an inert export must not reflow or replace the running document.
    expect(frame.contentDocument).toBe(originalDocument);
    expect(frame.contentWindow!.innerWidth).toBe(4096);
    expect(frame.contentWindow!.innerHeight).toBe(512);
  });

  it("refuses a 4097px source viewport before snapshot instead of enlarging export bounds", async () => {
    const frame = await fixture(
      '<div style="height:100%;background:#22aa55">Wide chart</div>',
      4097,
      200,
    );
    await expect(captureInlineVisualization(frame, new AbortController().signal)).rejects.toThrow(
      "This image could not be exported.",
    );
  });

  it("captures the current canvas backing pixels again after data changes, never a stored preview", async () => {
    const frame = await fixture(
      '<canvas width="300" height="200" style="display:block;width:300px;height:200px"></canvas>',
    );
    const source = frame.contentDocument!.querySelector("canvas")!;
    const context = source.getContext("2d")!;
    context.fillStyle = "#ff4400";
    context.fillRect(0, 0, 300, 200);
    const first = await captureInlineVisualization(frame, new AbortController().signal);
    expect((await pixel(first, 150, 100)).color).toEqual([255, 68, 0, 255]);
    context.fillStyle = "#0088ff";
    context.fillRect(0, 0, 300, 200);
    const second = await captureInlineVisualization(frame, new AbortController().signal);
    expect((await pixel(second, 150, 100)).color).toEqual([0, 136, 255, 255]);
  });

  it("captures a preserved current WebGL buffer without native screenshot authority", async () => {
    const frame = await fixture(
      '<canvas width="300" height="200" style="display:block;width:300px;height:200px"></canvas>',
    );
    const canvas = frame.contentDocument!.querySelector("canvas")!;
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    expect(gl).not.toBeNull();
    gl!.clearColor(0, 0.75, 0.5, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    const png = await captureInlineVisualization(frame, new AbortController().signal);
    const color = (await pixel(png, 150, 100)).color;
    expect(color[0]).toBe(0);
    expect(color[1]).toBeGreaterThanOrEqual(190);
    expect(color[1]).toBeLessThanOrEqual(192);
    expect(color[2]).toBeGreaterThanOrEqual(127);
    expect(color[2]).toBeLessThanOrEqual(129);
    expect(color[3]).toBe(255);
  });

  it("does not execute received scripts/events or reveal closed disclosure content in the image", async () => {
    const frame = await fixture(
      '<script>window.fixtureRuns=(window.fixtureRuns||0)+1</script><a href="https://example.invalid/private" onclick="window.fixtureRuns+=100">Visible link label</a><details><summary>Details</summary><p>Closed private text</p></details>',
    );
    const view = frame.contentWindow as Window & { fixtureRuns: number };
    expect(view.fixtureRuns).toBe(1);
    const png = await captureInlineVisualization(frame, new AbortController().signal);
    expect(png.type).toBe("image/png");
    expect(view.fixtureRuns).toBe(1);
    expect(frame.contentDocument!.querySelector("details")?.open).toBe(false);
    expect(frame.contentDocument!.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.invalid/private",
    );
  });

  it.each([
    '<div style="width:100px;height:100px;background-image:url(https://example.invalid/capture.png)">Chart</div>',
    '<iframe title="Unsupported child document" style="width:100px;height:100px"></iframe>',
    '<input type="password" value="private secret">',
    '<style>p::before{content:"Generated visible content"}</style><p>Chart</p>',
  ])(
    "refuses unsupported visible resource/content instead of fabricating pixels %#",
    async (source) => {
      const frame = await fixture(source);
      await expect(captureInlineVisualization(frame, new AbortController().signal)).rejects.toThrow(
        "This image could not be exported.",
      );
    },
  );

  it("rejects a source canvas that cannot expose its current pixels without leaking its failure", async () => {
    const frame = await fixture('<canvas width="300" height="200"></canvas>');
    frame.contentDocument!.querySelector("canvas")!.toDataURL = () => {
      throw new Error("private unreadable canvas payload");
    };
    await expect(captureInlineVisualization(frame, new AbortController().signal)).rejects.toThrow(
      "This image could not be exported.",
    );
  });

  it("rejects publication after the caller's exact frame ownership changes during decode", async () => {
    const frame = await fixture('<div style="height:100%;background:#22aa55">Current chart</div>');
    let current = true;
    const result = captureInlineVisualization(frame, new AbortController().signal, () => current);
    current = false;
    await expect(result).rejects.toThrow("This image could not be exported.");
  });

  it("rejects a removed frame and caller cancellation during async rasterization", async () => {
    const frame = await fixture('<div style="height:100%;background:#22aa55">Current chart</div>');
    const controller = new AbortController();
    const result = captureInlineVisualization(frame, controller.signal);
    frame.remove();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
