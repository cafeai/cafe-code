import { describe, expect, it, vi } from "vitest";
import {
  cancelsPendingGeneratedFontInstall,
  GeneratedVisualizationFontCommit,
  installFontReadyGeneratedDocument,
} from "./visualizationFontInstallation.ts";

describe("generated fixed-font installation ordering", () => {
  it("admits only a terminal fixed cancellation for generated pending readiness", () => {
    expect(cancelsPendingGeneratedFontInstall({ kind: "cancel-install" }, true)).toBe(true);
    expect(cancelsPendingGeneratedFontInstall({ kind: "cancel-install" }, false)).toBe(false);
    for (const value of [
      null,
      undefined,
      [],
      "cancel-install",
      { kind: "visibility", visible: false },
      { kind: "presentation-visibility", visible: false },
      { kind: "cancel-install", visible: false },
      { kind: "cancel-install", source: "private" },
    ])
      expect(cancelsPendingGeneratedFontInstall(value, true)).toBe(false);
  });
  it("never parses or acknowledges late faces after a terminal cancellation in a still-live bootstrap", async () => {
    let resolve!: (faces: readonly FontFace[]) => void;
    let cancelled = false;
    const pending = new Promise<readonly FontFace[]>((ready) => (resolve = ready));
    const replace = vi.fn(),
      refuse = vi.fn();
    const operation = installFontReadyGeneratedDocument(
      () => pending,
      () => !cancelled,
      async () => true,
      replace,
      refuse,
    );
    // The child is deliberately still alive: no pagehide event or forced crash
    // is assumed when native retirement has inconclusive exclusivity evidence.
    cancelled = cancelsPendingGeneratedFontInstall({ kind: "cancel-install" }, true);
    resolve([]);
    await operation;
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });
  it("leaves replacement and its pulse shutdown untouched until fixed faces are ready", async () => {
    let resolve!: (faces: readonly FontFace[]) => void;
    const faces = [Object.freeze({ status: "loaded" })] as unknown as readonly FontFace[];
    const pending = new Promise<readonly FontFace[]>((ready) => (resolve = ready));
    const replace = vi.fn(),
      refuse = vi.fn();
    const operation = installFontReadyGeneratedDocument(
      () => pending,
      () => true,
      async () => true,
      replace,
      refuse,
    );
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
    resolve(faces);
    await operation;
    expect(replace).toHaveBeenCalledExactlyOnceWith(faces);
    expect(refuse).not.toHaveBeenCalled();
  });

  it("never replaces a bootstrap retired while font loading was pending", async () => {
    let resolve!: (faces: readonly FontFace[]) => void;
    let current = true;
    const pending = new Promise<readonly FontFace[]>((ready) => (resolve = ready));
    const replace = vi.fn(),
      refuse = vi.fn();
    const operation = installFontReadyGeneratedDocument(
      () => pending,
      () => current,
      async () => true,
      replace,
      refuse,
    );
    current = false;
    resolve([]);
    await operation;
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });

  it("refuses a current decode or replacement failure without reporting private causes", async () => {
    for (const duringReplacement of [false, true]) {
      const cause = new Error("private fixed-font decode sentinel");
      const replace = vi.fn(() => {
        if (duringReplacement) throw cause;
      });
      const refuse = vi.fn();
      await installFontReadyGeneratedDocument(
        async () => {
          if (!duringReplacement) throw cause;
          return [];
        },
        () => true,
        async () => true,
        replace,
        refuse,
      );
      expect(replace).toHaveBeenCalledTimes(duringReplacement ? 1 : 0);
      expect(refuse).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it("does not send a late refusal for an already retired bootstrap", async () => {
    const replace = vi.fn(),
      refuse = vi.fn();
    await installFontReadyGeneratedDocument(
      async () => {
        throw new Error("private");
      },
      () => false,
      async () => true,
      replace,
      refuse,
    );
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });
});

describe("generated font native authorization ordering", () => {
  it("does not parse when native commit is refused even if cancellation was never delivered", async () => {
    const replace = vi.fn(),
      refuse = vi.fn(),
      commit = vi.fn(async () => false);
    await installFontReadyGeneratedDocument(
      async () => [],
      () => true,
      commit,
      replace,
      refuse,
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).toHaveBeenCalledExactlyOnceWith();
  });
  it("keeps the inert document until native authorization and rechecks terminal cancellation before parse", async () => {
    let resolve!: (value: boolean) => void;
    let current = true;
    const commit = new Promise<boolean>((ready) => (resolve = ready));
    const replace = vi.fn(),
      refuse = vi.fn();
    const operation = installFontReadyGeneratedDocument(
      async () => [],
      () => current,
      () => commit,
      replace,
      refuse,
    );
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
    current = false;
    resolve(true);
    await operation;
    expect(replace).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();
  });
});

describe("one-shot private generated font commit", () => {
  const nonce = "12ab3456-7890-4abc-8def-1234567890ab";
  it("refuses malformed or non-minted nonce spellings", () => {
    for (const value of [
      "",
      "-".repeat(36),
      nonce.toUpperCase(),
      nonce.replace("-4abc", "-1abc"),
      nonce + "x",
    ])
      expect(() => new GeneratedVisualizationFontCommit(value)).toThrow(
        "Generated visualization installation was refused.",
      );
  });
  it("accepts only one exact commit after one private readiness request", async () => {
    const gate = new GeneratedVisualizationFontCommit(nonce),
      send = vi.fn();
    expect(gate.receive({ kind: "commit-install", nonce })).toBe(false);
    const ready = gate.request(send);
    expect(gate.request(send)).toBe(ready);
    expect(send).toHaveBeenCalledExactlyOnceWith(nonce);
    for (const raw of [
      null,
      [],
      { kind: "commit-install", nonce: "foreign" },
      { kind: "commit-install", nonce, source: "private" },
      { kind: "visibility", nonce },
    ])
      expect(gate.receive(raw)).toBe(false);
    expect(gate.receive({ kind: "commit-install", nonce })).toBe(true);
    await expect(ready).resolves.toBe(true);
    expect(gate.receive({ kind: "commit-install", nonce })).toBe(false);
  });
  it("settles terminal cancellation false without needing pagehide and never admits a late commit", async () => {
    const gate = new GeneratedVisualizationFontCommit(nonce),
      send = vi.fn();
    const ready = gate.request(send);
    gate.cancel();
    await expect(ready).resolves.toBe(false);
    expect(gate.receive({ kind: "commit-install", nonce })).toBe(false);
    await expect(gate.request(send)).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
  it("does not request after pre-request cancellation or a failed private send", async () => {
    const gate = new GeneratedVisualizationFontCommit(nonce),
      send = vi.fn();
    gate.cancel();
    await expect(gate.request(send)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    const other = new GeneratedVisualizationFontCommit(nonce);
    await expect(
      other.request(() => {
        throw new Error("fixed send refused");
      }),
    ).resolves.toBe(false);
    expect(other.receive({ kind: "commit-install", nonce })).toBe(false);
  });
});
