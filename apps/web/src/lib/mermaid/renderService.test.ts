import { describe, expect, it, vi } from "vitest";
import { createMermaidRenderService } from "./renderService";
import { admitMermaidSource } from "./policy";

const result = { svg: "<svg/>", width: 10, height: 10, title: "Diagram" };

describe("Mermaid admission and bounded scheduler", () => {
  it("allows five families but rejects configuration, unsupported syntax and byte overflow", () => {
    for (const source of [
      "graph TD\nA-->B",
      "sequenceDiagram",
      "classDiagram",
      "stateDiagram-v2",
      "erDiagram",
    ]) {
      expect(() => admitMermaidSource(source)).not.toThrow();
    }
    for (const source of [
      "---\nconfig: {}\n---\ngraph TD",
      "%%{init: {}}%%\ngraph TD",
      "pie",
      `graph TD\n${"字".repeat(11_000)}`,
    ]) {
      expect(() => admitMermaidSource(source)).toThrow("Diagram unavailable");
    }
  });

  it("deduplicates complete-source/theme identities and serializes jobs", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renderer = vi.fn(async () => {
      await barrier;
      return result;
    });
    const service = createMermaidRenderService(renderer);
    const a = service("graph TD\nA-->B", "dark");
    expect(service("graph TD\nA-->B", "dark")).toBe(a);
    const b = service("graph TD\nA-->C", "dark");
    const c = service("graph TD\nA-->B", "light");
    await Promise.resolve();
    expect(renderer).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b, c]);
    expect(renderer).toHaveBeenCalledTimes(3);
    expect(await service("graph TD\nA-->B", "dark")).toBe(result);
    expect(renderer).toHaveBeenCalledTimes(3);
  });

  it("sanitizes errors, caches failures, and runs later diagrams", async () => {
    const renderer = vi
      .fn()
      .mockRejectedValueOnce(new Error("private DSL"))
      .mockResolvedValue(result);
    const service = createMermaidRenderService(renderer);
    await expect(service("graph TD\nbroken", "dark")).rejects.toThrow("Diagram unavailable");
    await expect(service("graph TD\nbroken", "dark")).rejects.not.toThrow("private DSL");
    expect(await service("graph TD\nA-->B", "dark")).toBe(result);
    expect(renderer).toHaveBeenCalledTimes(2);
  });

  it("bounds pending jobs and evicts least recently used results", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renderer = vi.fn(async () => {
      await barrier;
      return result;
    });
    const service = createMermaidRenderService(renderer);
    const pending = Array.from({ length: 64 }, (_, i) => service(`graph TD\nn${i}`, "dark"));
    await expect(service("graph TD\noverflow", "dark")).rejects.toThrow("Diagram unavailable");
    release();
    await Promise.all(pending);
    for (let i = 64; i < 130; i++) await service(`graph TD\nn${i}`, "dark");
    await service("graph TD\nn0", "dark");
    expect(renderer).toHaveBeenCalledTimes(131);
  });

  it("does not retain a single output larger than the cache budget", async () => {
    const renderer = vi.fn(async () => ({ ...result, svg: "x".repeat(9 * 1024 * 1024) }));
    const service = createMermaidRenderService(renderer);
    await service("graph TD\nA", "dark");
    await service("graph TD\nA", "dark");
    expect(renderer).toHaveBeenCalledTimes(2);
  });
});
