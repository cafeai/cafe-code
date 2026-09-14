import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { desktopRuntimeDirectory } from "@cafecode/shared/desktopRuntime";
import { ThreadId } from "@cafecode/contracts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as TestSqliteClient from "../src/persistence/TestSqliteClient.ts";
import { DesktopManager } from "../src/virtualDesktop/DesktopManager.ts";
import { makeDesktopStore } from "../src/virtualDesktop/store.ts";
import { executable, nativeRequest, processIdentity } from "../src/virtualDesktop/nativeClient.ts";

const enabled = process.platform === "linux" && process.env.CAFE_CODE_VIRTUAL_DESKTOP_E2E === "1";

it.skipIf(!enabled)(
  "recovers a failed GLES2 attempt into a private pixman desktop",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const store = yield* makeDesktopStore;
          yield* Effect.promise(async () => {
            const sway = await executable("sway");
            if (!sway) throw new Error("Install Sway for the desktop fallback probe.");
            const fixtures = await fs.mkdtemp(path.join(tmpdir(), "cafe-desktop-fallback-"));
            const stateDir = `/fixture-${randomUUID()}`;
            const root = desktopRuntimeDirectory(stateDir, process.getuid!());
            const originalPath = process.env.PATH;
            const helper =
              process.env.CAFE_CODE_DESKTOP_TEST_HELPER ??
              fileURLToPath(new URL("../dist/cafe-desktop-native", import.meta.url));
            const manager = new DesktopManager({
              store,
              stateDir,
              helper,
              mcpPort: 12345,
              policy: {
                virtualDesktopsEnabled: true,
                desktopControlMcpEnabled: true,
                desktopObservationRetention: 0,
              },
              observations: {
                save: async () => {
                  throw new Error("Not used by this capture probe.");
                },
                setRetention: async () => {},
              },
            });
            try {
              // This test-only executable fails after the real worker has created
              // its exclusive D-Bus files. execve preserves Sway's PID/ownership on
              // the second attempt; no provider process or user application is used.
              await fs.writeFile(
                path.join(fixtures, "sway"),
                `#!${process.execPath}\nif (process.env.WLR_RENDERER === "gles2") process.exit(1);\nprocess.execve(${JSON.stringify(sway)}, [${JSON.stringify(sway)}, ...process.argv.slice(2)], process.env);\n`,
                { mode: 0o700 },
              );
              process.env.PATH = `${fixtures}${path.delimiter}${originalPath ?? ""}`;
              const state = await manager.manage({
                operation: "create",
                threadId: ThreadId.make("fallback"),
                name: "CPU fallback",
              });
              expect(state.desktops).toHaveLength(1);
              expect(state.desktops[0]).toMatchObject({ state: "ready", renderer: "pixman" });
              const [definition] = await store.list();
              expect(definition?.pid).toBeTypeOf("number");
              const frame = await nativeRequest(
                helper,
                path.join(definition!.directory, "bootstrap.json"),
                { method: "observe" },
              );
              expect(frame).toMatchObject({
                width: 1280,
                height: 800,
                renderer: "pixman",
                transfer: "shared-memory",
              });
              expect(Buffer.from(String(frame.image), "base64").subarray(0, 8)).toEqual(
                Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
              );
              const unchanged = await nativeRequest(
                helper,
                path.join(definition!.directory, "bootstrap.json"),
                {
                  method: "observe",
                  sinceHash: frame.pixelHash,
                  sinceEpoch: frame.controlEpoch,
                  sinceWidth: frame.width,
                  sinceHeight: frame.height,
                },
              );
              expect(unchanged).toMatchObject({ unchanged: true });
              expect(unchanged).not.toHaveProperty("image");
              expect((await fs.stat(definition!.directory)).mode & 0o777).toBe(0o700);
              await manager.manage({
                operation: "set-display",
                id: definition!.id,
                resolution: { width: 720, height: 1280 },
              });
              expect(
                await nativeRequest(helper, path.join(definition!.directory, "bootstrap.json"), {
                  method: "observe",
                }),
              ).toMatchObject({
                width: 720,
                height: 1280,
                renderer: "pixman",
                transfer: "shared-memory",
              });
              expect(
                await nativeRequest(helper, path.join(definition!.directory, "bootstrap.json"), {
                  method: "observe",
                  preview: true,
                }),
              ).toMatchObject({ width: 270, height: 480 });
              await manager.manage({ operation: "terminate", id: definition!.id });
              expect(await processIdentity(definition!.pid!)).toBeNull();
            } finally {
              if (originalPath === undefined) delete process.env.PATH;
              else process.env.PATH = originalPath;
              await manager.terminateAll();
              await manager.close();
              await fs.rm(root, { recursive: true, force: true });
              await fs.rm(fixtures, { recursive: true, force: true });
            }
          });
        }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
      ),
    );
  },
  60_000,
);
