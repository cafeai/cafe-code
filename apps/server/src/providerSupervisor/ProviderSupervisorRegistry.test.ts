import {
  ProviderInstanceId,
  ProviderSupervisorId,
  ProviderSupervisorOwnerId,
  ProviderSupervisorSessionId,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProviderSupervisorOwnershipError,
  makeProviderSupervisorRegistry,
} from "./ProviderSupervisorRegistry.ts";

const supervisorId = ProviderSupervisorId.make("supervisor-test");
const firstOwnerId = ProviderSupervisorOwnerId.make("owner-a");
const secondOwnerId = ProviderSupervisorOwnerId.make("owner-b");

describe("ProviderSupervisorRegistry", () => {
  it("creates and restores durable supervisor sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeProviderSupervisorRegistry;
        const created = yield* registry.createSession({
          sessionId: ProviderSupervisorSessionId.make("session-1"),
          supervisorId,
          ownerId: firstOwnerId,
          ownerKind: "provider-daemon",
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerKind: "codex",
          providerPid: 123,
          commandDisplay: "codex app-server",
          cwd: "/tmp/cafe-code-test",
          socketPath: "/tmp/cafe-code-test.sock",
          protocolVersion: 1,
        });
        const restoredRegistry = yield* makeProviderSupervisorRegistry;
        const restored = yield* restoredRegistry.getSession(created.sessionId);

        expect(restored).toMatchObject({
          sessionId: created.sessionId,
          supervisorId,
          ownerId: firstOwnerId,
          ownerKind: "provider-daemon",
          threadId: ThreadId.make("thread-1"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerPid: 123,
          ioGeneration: 1,
          rawByteCursor: 0,
          parserCursor: 0,
          transferState: "running",
        });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("increments IO generation on adoption and rejects stale owners", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeProviderSupervisorRegistry;
        const created = yield* registry.createSession({
          sessionId: ProviderSupervisorSessionId.make("session-2"),
          supervisorId,
          ownerId: firstOwnerId,
          ownerKind: "provider-daemon",
        });
        const adopted = yield* registry.adoptSession({
          sessionId: created.sessionId,
          nextOwnerId: secondOwnerId,
          ownerKind: "provider-daemon",
        });

        expect(adopted.ownerId).toBe(secondOwnerId);
        expect(adopted.ioGeneration).toBe(2);

        const staleExit = yield* Effect.exit(
          registry.detachSession({
            sessionId: created.sessionId,
            ownerId: firstOwnerId,
            ioGeneration: 1,
          }),
        );
        expect(staleExit._tag).toBe("Failure");
        if (staleExit._tag === "Failure") {
          expect(staleExit.cause.toString()).toContain(ProviderSupervisorOwnershipError.name);
        }

        const afterStale = yield* registry.getSession(created.sessionId);
        expect(afterStale?.ownerId).toBe(secondOwnerId);
        expect(afterStale?.transferState).toBe("running");
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("persists transfer states and cursor updates with monotonic cursors", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* makeProviderSupervisorRegistry;
        const created = yield* registry.createSession({
          sessionId: ProviderSupervisorSessionId.make("session-3"),
          supervisorId,
          ownerId: firstOwnerId,
          ownerKind: "provider-daemon",
        });
        const proof = {
          sessionId: created.sessionId,
          ownerId: firstOwnerId,
          ioGeneration: created.ioGeneration,
        };

        const preparing = yield* registry.markTransferState(proof, "preparing-transfer");
        const withBytes = yield* registry.recordIoEvent(proof, {
          streamKind: "stdout",
          byteLength: 10,
          sha256: "hash-a",
        });
        const withParser = yield* registry.advanceParserCursor(proof, 7);
        const unchangedParser = yield* registry.advanceParserCursor(proof, 3);
        const snapshot = yield* registry.snapshot;

        expect(preparing.transferState).toBe("preparing-transfer");
        expect(withBytes.rawByteCursor).toBe(10);
        expect(withParser.parserCursor).toBe(7);
        expect(unchangedParser.parserCursor).toBe(7);
        expect(snapshot.sessionCount).toBe(1);
        expect(snapshot.transferringSessionCount).toBe(1);
        expect(snapshot.maxRawByteCursor).toBe(10);
        expect(snapshot.maxParserCursor).toBe(7);
        expect(snapshot.sessions[0]?.sessionId).toBe(created.sessionId);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });
});
