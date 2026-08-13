import {
  CommandId,
  EventId,
  THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION,
  type OrchestrationEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const firstStopAt = "2026-08-12T01:00:00.000Z";
const secondStopAt = "2026-08-12T01:01:00.000Z";

async function apply(
  readModel: ReturnType<typeof createEmptyReadModel>,
  planned: Omit<OrchestrationEvent, "sequence">,
) {
  return Effect.runPromise(
    projectEvent(readModel, {
      ...planned,
      sequence: readModel.snapshotSequence + 1,
    } as OrchestrationEvent),
  );
}

describe("global Auto Nudge authority", () => {
  it("advances on every Stop and requires an exact revision to Allow", async () => {
    const initial = createEmptyReadModel("2026-08-12T00:00:00.000Z");
    const firstStop = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "auto-nudge.stop-all",
          commandId: CommandId.make("global-stop-1"),
          createdAt: firstStopAt,
        },
      }),
    );
    expect(Array.isArray(firstStop)).toBe(false);
    const firstEvent = firstStop as Omit<OrchestrationEvent, "sequence">;
    expect(firstEvent).toMatchObject({
      aggregateKind: "system",
      aggregateId: "auto-nudge-authority",
      type: "system.auto-nudge-authority-changed",
      payload: { authority: { authorityRevision: 1, status: "stopped" } },
    });

    const afterFirstStop = await apply(initial, firstEvent);
    const secondStop = (await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: afterFirstStop,
        command: {
          type: "auto-nudge.stop-all",
          commandId: CommandId.make("global-stop-2"),
          createdAt: secondStopAt,
        },
      }),
    )) as Omit<OrchestrationEvent, "sequence">;
    expect(secondStop.payload).toMatchObject({
      authority: { authorityRevision: 2, status: "stopped", stoppedAt: secondStopAt },
    });

    const afterSecondStop = await apply(afterFirstStop, secondStop);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: afterSecondStop,
          command: {
            type: "auto-nudge.allow",
            commandId: CommandId.make("stale-global-allow"),
            expectedAuthorityRevision: 1,
            createdAt: "2026-08-12T01:02:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Global Auto Nudge authority revision is stale");

    const allow = (await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: afterSecondStop,
        command: {
          type: "auto-nudge.allow",
          commandId: CommandId.make("exact-global-allow"),
          expectedAuthorityRevision: 2,
          createdAt: "2026-08-12T01:03:00.000Z",
        },
      }),
    )) as Omit<OrchestrationEvent, "sequence">;
    expect(allow.payload).toMatchObject({
      authority: { authorityRevision: 3, status: "allowed", stoppedAt: null },
    });
  });

  it("projects the global authority independently of thread count", async () => {
    const model = createEmptyReadModel("2026-08-12T00:00:00.000Z");
    const projected = await Effect.runPromise(
      projectEvent(model, {
        sequence: 9,
        eventId: EventId.make("global-authority-event"),
        aggregateKind: "system",
        aggregateId: "auto-nudge-authority",
        type: "system.auto-nudge-authority-changed",
        occurredAt: firstStopAt,
        commandId: CommandId.make("global-authority-command"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          authority: {
            authorityRevision: 4,
            status: "stopped",
            stoppedAt: firstStopAt,
            updatedAt: firstStopAt,
          },
        },
      }),
    );
    expect(projected.threads).toEqual([]);
    expect(projected.autoNudgeAuthority).toEqual({
      authorityRevision: 4,
      status: "stopped",
      stoppedAt: firstStopAt,
      updatedAt: firstStopAt,
    });
  });

  it("fails closed when Stop reaches the authority revision ceiling", async () => {
    const initial = {
      ...createEmptyReadModel("2026-08-12T00:00:00.000Z"),
      autoNudgeAuthority: {
        authorityRevision: THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION,
        status: "allowed" as const,
        stoppedAt: null,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    };
    const stopped = (await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: initial,
        command: {
          type: "auto-nudge.stop-all",
          commandId: CommandId.make("global-stop-at-ceiling"),
          createdAt: firstStopAt,
        },
      }),
    )) as Omit<OrchestrationEvent, "sequence">;

    expect(stopped.payload).toMatchObject({
      authority: {
        authorityRevision: THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION,
        status: "stopped",
      },
    });
    const afterStop = await apply(initial, stopped);
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: afterStop,
          command: {
            type: "auto-nudge.allow",
            commandId: CommandId.make("global-allow-after-ceiling"),
            expectedAuthorityRevision: THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION,
            createdAt: secondStopAt,
          },
        }),
      ),
    ).rejects.toThrow("revision is exhausted");
  });
});
