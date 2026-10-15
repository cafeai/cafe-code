import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeImageCanvasPng } from "../../lib/imageExport";
import {
  admitInlineVisualizationCaptureSize,
  admitInlineVisualizationCaptureSourceSize,
} from "./visualizationInlineCapture";

describe("bounded current inline visualization PNG capture", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [1, 1],
    [1600, 2000],
    [600, 420],
  ])("admits exact viewport %sx%s", (width, height) => {
    expect(admitInlineVisualizationCaptureSize(width, height)).toEqual({ width, height });
  });
  it.each([
    [0, 200],
    [400, 0],
    [1601, 200],
    [400, 2001],
    [1.5, 200],
    [400, Number.NaN],
    [Infinity, 200],
  ])("refuses invalid viewport %sx%s before allocation", (width, height) =>
    expect(() => admitInlineVisualizationCaptureSize(width, height)).toThrow(),
  );

  it.each([
    [300, 200, 300, 200],
    [1600, 2000, 1600, 2000],
    [1601, 2000, 1600, 1999],
    [4096, 512, 1600, 200],
    [4096, 2000, 1600, 782],
    [4096, 1, 1600, 1],
  ])(
    "fits the original CSS %sx%s document into bounded %sx%s pixels without changing its coordinates",
    (width, height, outputWidth, outputHeight) => {
      const geometry = admitInlineVisualizationCaptureSourceSize(width, height);
      expect(geometry).toEqual({
        source: { width, height },
        output: { width: outputWidth, height: outputHeight },
      });
      expect(geometry.output.width * geometry.output.height).toBeLessThanOrEqual(3_200_000);
      expect(admitInlineVisualizationCaptureSize(outputWidth, outputHeight)).toEqual(
        geometry.output,
      );
      const scale = Math.min(outputWidth / width, outputHeight / height);
      // Rounding may leave less than one physical pixel at either edge, but
      // meet mapping always uses this same scalar for both axes.
      expect(outputWidth - width * scale).toBeLessThan(1);
      expect(outputHeight - height * scale).toBeLessThan(1);
    },
  );
  it.each([
    [0, 200],
    [4097, 200],
    [4096, 2001],
    [4096.5, 200],
    [4096, Number.NaN],
    [Infinity, 200],
  ])("refuses invalid CSS source %sx%s before serialization", (width, height) =>
    expect(() => admitInlineVisualizationCaptureSourceSize(width, height)).toThrow(),
  );

  it("settles a PNG once and removes its original deadline", async () => {
    vi.useFakeTimers();
    const png = new Blob(["fixture png"], { type: "image/png" });
    let callback: BlobCallback | undefined;
    const canvas = {
      toBlob: (value: BlobCallback) => {
        callback = value;
      },
    } as HTMLCanvasElement;
    const controller = new AbortController();
    const result = serializeImageCanvasPng(canvas, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    callback!(png);
    callback!(null);
    controller.abort();
    await expect(result).resolves.toBe(png);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a stalled serialization without accepting a late PNG", async () => {
    vi.useFakeTimers();
    let callback: BlobCallback | undefined;
    const canvas = {
      toBlob: (value: BlobCallback) => {
        callback = value;
      },
    } as HTMLCanvasElement;
    const controller = new AbortController();
    const result = serializeImageCanvasPng(canvas, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    controller.abort();
    await rejected;
    callback!(new Blob(["late png"], { type: "image/png" }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the exact fifteen-second serialization deadline", async () => {
    vi.useFakeTimers();
    const canvas = { toBlob: () => {} } as unknown as HTMLCanvasElement;
    const result = serializeImageCanvasPng(canvas, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears its deadline and listener after a synchronous browser failure", async () => {
    vi.useFakeTimers();
    const canvas = {
      toBlob: () => {
        throw new Error("private browser failure");
      },
    } as unknown as HTMLCanvasElement;
    await expect(serializeImageCanvasPng(canvas, new AbortController().signal)).rejects.toThrow(
      "This image could not be exported.",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not call the browser for an already cancelled capture", () => {
    const toBlob = vi.fn();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      serializeImageCanvasPng({ toBlob } as unknown as HTMLCanvasElement, controller.signal),
    ).toThrow();
    expect(toBlob).not.toHaveBeenCalled();
  });
});
