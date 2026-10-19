import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vitest";
import { copyStagedYarnProject, stagedYarnProjectFiles } from "./staged-yarn-project.ts";

describe("staged Yarn inputs", () => {
  it("includes Yarn-generated scoped patch filenames with dotted versions", () => {
    const patch = ".yarn/patches/@legendapp-list-npm-3.0.0-beta.44-3d8b008deb.patch";
    expect(
      stagedYarnProjectFiles(
        `"patch:@legendapp/list@npm%3A3.0.0-beta.44#~/${patch}"`,
        `"patch:@legendapp/list@npm%3A3.0.0-beta.44#~/${patch}::version=3.0.0-beta.44&hash=00638d"`,
      ).filter((file) => file.endsWith(".patch")),
    ).toEqual([patch]);
  });

  it.each([
    ".yarn/patches/../secret.patch",
    ".yarn/patches/nested/secret.patch",
    ".yarn/patches/..\\secret.patch",
    ".yarn/patches/.hidden.patch",
  ])("rejects unsafe patch path %s", (patch) => {
    expect(() => stagedYarnProjectFiles(`"${patch}"`, "")).toThrow(
      "Invalid staged Yarn patch path",
    );
  });

  it("includes every patch referenced by either input and rejects traversal", () => {
    expect(
      stagedYarnProjectFiles(
        '"./.yarn/patches/effect.patch"',
        "effect#./.yarn/patches/effect-vitest.patch&hash=abc\nfuture#./.yarn/patches/future.patch",
      ),
    ).toEqual(
      expect.arrayContaining([
        ".yarn/patches/effect.patch",
        ".yarn/patches/effect-vitest.patch",
        ".yarn/patches/future.patch",
      ]),
    );
    expect(() => stagedYarnProjectFiles('".yarn/patches/../../secret.patch"', "")).toThrow(
      "Invalid staged Yarn patch path",
    );
  });

  it("fails before copying when a newly required patch is absent", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          const output = path.join(root, "output");
          const manifest = '{"resolutions":{"x":"patch:x#./.yarn/patches/missing.patch"}}';
          for (const relative of stagedYarnProjectFiles(manifest, "")) {
            if (relative.endsWith(".patch")) continue;
            const file = path.join(root, relative);
            yield* fs.makeDirectory(path.dirname(file), { recursive: true });
            yield* fs.writeFileString(file, relative === "package.json" ? manifest : "");
          }
          const result = yield* Effect.exit(copyStagedYarnProject(root, output));
          expect(String(result)).toContain(
            "Missing required staged Yarn input: .yarn/patches/missing.patch",
          );
          expect(yield* fs.exists(output)).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("copies a scoped patch into the staged project with its exact contents", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          const output = path.join(root, "output");
          const patch = ".yarn/patches/@legendapp-list-npm-3.0.0-beta.44-3d8b008deb.patch";
          const manifest = `{"dependencies":{"@legendapp/list":"patch:@legendapp/list@npm%3A3.0.0-beta.44#~/${patch}"}}`;
          const patchContents = "diff --git a/package.json b/package.json\n";
          for (const relative of stagedYarnProjectFiles(manifest, "")) {
            const file = path.join(root, relative);
            yield* fs.makeDirectory(path.dirname(file), { recursive: true });
            yield* fs.writeFileString(
              file,
              relative === "package.json" ? manifest : relative === patch ? patchContents : "",
            );
          }
          yield* copyStagedYarnProject(root, output);
          expect(yield* fs.readFileString(path.join(output, patch))).toBe(patchContents);
          expect(yield* fs.readFileString(path.join(output, "package.json"))).toBe(manifest);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
