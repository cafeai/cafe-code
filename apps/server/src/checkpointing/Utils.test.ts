import { describe, expect, it } from "vitest";
import { ProjectId, ThreadId } from "@cafecode/contracts";

import {
  checkpointRefForThreadTurn,
  isGeneratedHiddenCheckpointRef,
  isThreadOwnedHiddenCheckpointRef,
  legacyCheckpointRefAlias,
  resolveThreadWorkspaceDirectories,
} from "./Utils.ts";

it("binds new checkpoint namespaces to a durable association epoch without changing legacy refs", () => {
  const threadId = ThreadId.make("thread-1");
  const old = checkpointRefForThreadTurn(threadId, 1);
  const moved = checkpointRefForThreadTurn(threadId, 1, 42);
  expect(moved).not.toBe(old);
  expect(moved).not.toBe(checkpointRefForThreadTurn(threadId, 1, 43));
  expect(moved).toBe(checkpointRefForThreadTurn(threadId, 1, 42));
  expect(isGeneratedHiddenCheckpointRef(moved)).toBe(true);
});

it("keeps arbitrary legacy thread ids disjoint from association provenance paths", () => {
  const movedThreadId = ThreadId.make("victim");
  const hostileLegacyId = ThreadId.make("victim:association:42");
  const moved = checkpointRefForThreadTurn(movedThreadId, 1, 42);
  const legacy = checkpointRefForThreadTurn(hostileLegacyId, 1);
  expect(moved).not.toBe(legacy);
  expect(moved).toBe("refs/cafe/checkpoints/dmljdGlt/association/42/turn/1");
  expect(legacy).toBe("refs/cafe/checkpoints/dmljdGltOmFzc29jaWF0aW9uOjQy/turn/1");
  expect(isThreadOwnedHiddenCheckpointRef(movedThreadId, legacy)).toBe(false);
  expect(isThreadOwnedHiddenCheckpointRef(hostileLegacyId, moved)).toBe(false);

  // IDs are opaque data, including delimiter/newline-looking spellings; only
  // the generated ref grammar may ever reach Git's stdin command language.
  const hostileId = ThreadId.make("victim/association/42\n delete refs/heads/main");
  const encoded = checkpointRefForThreadTurn(hostileId, 1, 42);
  expect(isGeneratedHiddenCheckpointRef(encoded)).toBe(true);
  expect(encoded).not.toContain("\n");
  expect(isThreadOwnedHiddenCheckpointRef(hostileId, encoded)).toBe(true);
});

describe("isGeneratedHiddenCheckpointRef", () => {
  it("accepts only Cafe-owned hidden checkpoint refs", () => {
    expect(isGeneratedHiddenCheckpointRef("refs/cafe/checkpoints/thread_123-abc/turn/42")).toBe(
      true,
    );
    expect(isGeneratedHiddenCheckpointRef("refs/t3/checkpoints/thread_123-abc/turn/42")).toBe(true);
    expect(isGeneratedHiddenCheckpointRef("provider-diff:evt-1")).toBe(false);
    expect(isGeneratedHiddenCheckpointRef("refs/heads/main")).toBe(false);
    expect(
      isGeneratedHiddenCheckpointRef(
        "refs/cafe/checkpoints/thread/turn/1\n delete refs/heads/main",
      ),
    ).toBe(false);
  });

  it.each([
    "refs/cafe/checkpoints/thread/association/0/turn/1",
    "refs/cafe/checkpoints/thread/association/01/turn/1",
    "refs/cafe/checkpoints/thread/association/-1/turn/1",
    "refs/cafe/checkpoints/thread/association/1e3/turn/1",
    "refs/cafe/checkpoints/thread/association/42/association/43/turn/1",
    "refs/cafe/checkpoints/thread/association/42/turn/01",
    "refs/cafe/checkpoints/thread/association/42/turn/1\ncreate refs/heads/main",
    "refs/cafe/checkpoints/thread/association/42/turn/1\rdelete refs/heads/main",
    "refs/cafe/checkpoints/thread/association/42/turn/1\0",
    "refs/cafe/checkpoints/thread/association/42/../turn/1",
  ])("rejects a malformed association ref: %j", (ref) => {
    expect(isGeneratedHiddenCheckpointRef(ref)).toBe(false);
  });
});

describe("isThreadOwnedHiddenCheckpointRef", () => {
  it("grants cleanup only to the exact thread, retaining both installed ref prefixes", () => {
    const owner = ThreadId.make("source-thread");
    const copiedTarget = ThreadId.make("source-thread-copy");
    for (const associationSequence of [undefined, 42]) {
      const ref = checkpointRefForThreadTurn(owner, 3, associationSequence);
      const legacyAlias = legacyCheckpointRefAlias(ref);
      if (legacyAlias === null) throw new Error("Expected a generated legacy alias");
      expect(isThreadOwnedHiddenCheckpointRef(owner, ref)).toBe(true);
      expect(isThreadOwnedHiddenCheckpointRef(owner, legacyAlias)).toBe(true);
      expect(isThreadOwnedHiddenCheckpointRef(copiedTarget, ref)).toBe(false);
      expect(isThreadOwnedHiddenCheckpointRef(copiedTarget, legacyAlias)).toBe(false);
      expect(isThreadOwnedHiddenCheckpointRef(owner, `${ref}\n delete refs/heads/main`)).toBe(
        false,
      );
    }
    expect(isThreadOwnedHiddenCheckpointRef(owner, "provider-diff:evt-1")).toBe(false);
  });
});

describe("resolveThreadWorkspaceDirectories", () => {
  it("revokes stale project and worktree roots for a standalone chat", () => {
    expect(
      resolveThreadWorkspaceDirectories({
        thread: { projectId: null, worktreePath: "/former-worktree" },
        projects: [
          {
            id: ProjectId.make("former"),
            workspaceRoot: "/former",
            additionalWorkspaceRoots: ["/secret-root"],
          },
        ],
      }),
    ).toEqual({ cwd: undefined, additionalDirectories: [] });
  });
  it("keeps worktree cwd primary and excludes duplicate additional roots", () => {
    const result = resolveThreadWorkspaceDirectories({
      thread: {
        projectId: ProjectId.make("project-1"),
        worktreePath: "/repo-worktree",
      },
      projects: [
        {
          id: ProjectId.make("project-1"),
          workspaceRoot: "/repo",
          additionalWorkspaceRoots: ["/repo-worktree", "/docs", "/docs/"],
        },
      ],
    });

    expect(result).toEqual({
      cwd: "/repo-worktree",
      additionalDirectories: ["/docs"],
    });
  });
});
