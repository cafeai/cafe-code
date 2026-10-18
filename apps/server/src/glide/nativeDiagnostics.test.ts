import { expect, it } from "vitest";
import { makeGlideNativePhaseReader } from "./nativeDiagnostics.ts";

it("preserves only complete fixed phases across split stderr chunks", () => {
  const phases: string[] = [];
  const read = makeGlideNativePhaseReader((phase) => phases.push(phase));
  const encoder = new TextEncoder();
  read(encoder.encode("glide.phase=incom"));
  expect(phases).toEqual([]);
  read(
    encoder.encode("ing.observed\nglide.phase=incoming.admitted\nglide.phase=hosted.keyboard\n"),
  );
  expect(phases).toEqual(["incoming.observed", "incoming.admitted", "hosted.keyboard"]);
});

it("discards paths, arbitrary payloads and oversized lines without admitting a suffix", () => {
  const phases: string[] = [];
  const read = makeGlideNativePhaseReader((phase) => phases.push(phase));
  const encoder = new TextEncoder();
  read(
    encoder.encode(
      "/private/path glide.phase=incoming.admitted\nglide.phase=hosted.pointer /private/path\n",
    ),
  );
  read(encoder.encode("x".repeat(4096)));
  read(encoder.encode("glide.phase=incoming.admitted\nglide.phase=paste.restore\n"));
  expect(phases).toEqual(["paste.restore"]);
});

it("keeps diagnostics observational when the consumer throws", () => {
  let called = 0;
  const read = makeGlideNativePhaseReader(() => {
    called++;
    throw new Error("observer");
  });
  expect(() =>
    read(new TextEncoder().encode("glide.phase=incoming.refused\nglide.phase=incoming.expired\n")),
  ).not.toThrow();
  expect(called).toBe(2);
});
