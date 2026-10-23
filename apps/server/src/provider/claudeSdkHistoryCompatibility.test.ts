import {
  forkSession,
  getSubagentMessages,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { vi } from "vitest";

const SOURCE_SESSION = "19200000-0000-4000-8000-000000000001";
const FIRST_USER = "19200000-0000-4000-8000-000000000002";
const PROGRESS = "19200000-0000-4000-8000-000000000003";
const FIRST_ASSISTANT = "19200000-0000-4000-8000-000000000004";
const CHILD_ASSISTANT = "19200000-0000-4000-8000-000000000005";
const SECOND_USER = "19200000-0000-4000-8000-000000000006";
const SECOND_ASSISTANT = "19200000-0000-4000-8000-000000000007";
const LATER_USER = "19200000-0000-4000-8000-000000000008";
const MISSING_MESSAGE = "19200000-0000-4000-8000-000000000009";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// SDK 0.3.305 can override the cwd-derived store key with
// CLAUDE_CODE_PROJECT_DIR_NAME when CLAUDE_CONFIG_DIR (or its private diskless
// state) selects that namespace. These tests never enter diskless/query state;
// isolate only the two public namespace inputs, without reading their values.
// Vitest owns exact restoration, registered in this test's Effect scope before
// any SDK await, so failures/cancellation cannot leak our overrides to a case.
const isolateSdkNamespace = Effect.acquireRelease(
  Effect.sync(() => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    vi.stubEnv("CLAUDE_CODE_PROJECT_DIR_NAME", undefined);
  }),
  () => Effect.sync(() => vi.unstubAllEnvs()),
);

class HistoryStoreRefusal extends Data.TaggedError("HistoryStoreRefusal")<{
  readonly reason:
    | "child-subpath"
    | "foreign-key"
    | "duplicate-operation"
    | "oversized-publication";
}> {}

function sourceHistory(): SessionStoreEntry[] {
  const row = (
    type: string,
    uuid: string,
    parentUuid: string | null,
    text: string,
  ): SessionStoreEntry => ({
    type,
    uuid,
    parentUuid,
    sessionId: SOURCE_SESSION,
    timestamp: "2026-10-21T12:00:00.000Z",
    isSidechain: false,
    message: { role: type, content: [{ type: "text", text }] },
  });
  return [
    row("user", FIRST_USER, null, "First root request"),
    row("progress", PROGRESS, FIRST_USER, "Transient progress, not resumable conversation"),
    row("assistant", FIRST_ASSISTANT, PROGRESS, "First root answer"),
    {
      ...row("assistant", CHILD_ASSISTANT, FIRST_ASSISTANT, "Child-only sentinel"),
      isSidechain: true,
      agentId: "child-sentinel",
    },
    row("user", SECOND_USER, FIRST_ASSISTANT, "Second root request"),
    row("assistant", SECOND_ASSISTANT, SECOND_USER, "Second root answer"),
    row("user", LATER_USER, SECOND_ASSISTANT, "Later root request"),
  ];
}

/**
 * Match Cafe's deliberately root-only publication boundary, not the SDK's
 * general-purpose in-memory store. Each invocation owns one source snapshot and
 * at most one new root publication. Any attempted child/foreign key fails before
 * source access or publication; unexpected extra calls cannot hide in a cache.
 */
function guardedStore(projectKey: string) {
  const source = sourceHistory();
  const sourceSnapshot = structuredClone(source);
  const loads: SessionKey[] = [];
  const loadedSnapshots: SessionStoreEntry[][] = [];
  const publications: { key: SessionKey; entries: SessionStoreEntry[] }[] = [];
  const store: SessionStore = {
    async load(key) {
      if (loads.length !== 0) throw new HistoryStoreRefusal({ reason: "duplicate-operation" });
      loads.push(structuredClone(key));
      if (key.subpath !== undefined) throw new HistoryStoreRefusal({ reason: "child-subpath" });
      if (key.projectKey !== projectKey || key.sessionId !== SOURCE_SESSION)
        throw new HistoryStoreRefusal({ reason: "foreign-key" });
      const snapshot = structuredClone(source);
      loadedSnapshots.push(snapshot);
      return snapshot;
    },
    async append(key, entries) {
      if (key.subpath !== undefined) throw new HistoryStoreRefusal({ reason: "child-subpath" });
      if (
        key.projectKey !== projectKey ||
        key.sessionId === SOURCE_SESSION ||
        !UUID.test(key.sessionId)
      )
        throw new HistoryStoreRefusal({ reason: "foreign-key" });
      if (publications.length !== 0)
        throw new HistoryStoreRefusal({ reason: "duplicate-operation" });
      // This fixture has seven source records; a fork can add only its title.
      // The bound rejects unexpected expansion instead of accepting unbounded
      // batches while testing the SDK's current copy contract.
      if (entries.length > source.length + 1)
        throw new HistoryStoreRefusal({ reason: "oversized-publication" });
      publications.push({ key: structuredClone(key), entries: structuredClone(entries) });
    },
  };
  return { store, source, sourceSnapshot, loads, loadedSnapshots, publications };
}

it.layer(NodeServices.layer)("actual Claude SDK root-only history compatibility", (it) => {
  for (const scenario of [
    {
      name: "copies the complete root without progress or child history",
      cutoff: undefined,
      expectedIds: [FIRST_USER, FIRST_ASSISTANT, SECOND_USER, SECOND_ASSISTANT, LATER_USER],
    },
    {
      name: "copies only the inclusive native cutoff and remaps its retained lineage",
      cutoff: FIRST_ASSISTANT,
      expectedIds: [FIRST_USER, FIRST_ASSISTANT],
    },
  ]) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        yield* isolateSdkNamespace;
        const fs = yield* FileSystem.FileSystem;
        // The SDK canonicalizes only this owned empty directory. All history
        // lives in the supplied store: no query(), CLI, credentials or native
        // transcript search is involved, and scoped cleanup precedes the test's
        // first asynchronous SDK operation.
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-sdk-history-" });
        const canonicalDirectory = yield* fs.realPath(directory);
        const projectKey = canonicalDirectory.replace(/[^a-zA-Z0-9]/g, "-");
        const fixture = guardedStore(projectKey);
        const fork = yield* Effect.promise(() =>
          forkSession(SOURCE_SESSION, {
            dir: directory,
            title: "Offline fork compatibility",
            ...(scenario.cutoff ? { upToMessageId: scenario.cutoff } : {}),
            sessionStore: fixture.store,
          }),
        );

        expect(fork.sessionId).toMatch(UUID);
        expect(fork.sessionId).not.toBe(SOURCE_SESSION);
        expect(fixture.loads).toEqual([{ projectKey, sessionId: SOURCE_SESSION }]);
        expect(fixture.publications).toHaveLength(1);
        const publication = fixture.publications[0]!;
        expect(publication.key).toEqual({ projectKey, sessionId: fork.sessionId });
        expect(publication.entries).toHaveLength(scenario.expectedIds.length + 1);
        const copied = publication.entries.slice(0, -1);
        expect(copied.map((entry) => entry.forkedFrom)).toEqual(
          scenario.expectedIds.map((messageUuid) => ({ sessionId: SOURCE_SESSION, messageUuid })),
        );
        expect(new Set(publication.entries.map((entry) => entry.uuid)).size).toBe(
          publication.entries.length,
        );
        copied.forEach((entry, index) => {
          const original = fixture.sourceSnapshot.find(
            (candidate) => candidate.uuid === scenario.expectedIds[index],
          )!;
          expect(entry.uuid).toMatch(UUID);
          expect(fixture.sourceSnapshot.some((candidate) => candidate.uuid === entry.uuid)).toBe(
            false,
          );
          expect(entry).toMatchObject({
            type: original.type,
            message: original.message,
            sessionId: fork.sessionId,
            parentUuid: index === 0 ? null : copied[index - 1]!.uuid,
            isSidechain: false,
          });
        });
        expect(publication.entries.at(-1)).toMatchObject({
          type: "custom-title",
          sessionId: fork.sessionId,
          customTitle: "Offline fork compatibility",
          uuid: expect.stringMatching(UUID),
        });
        // Check both the owned source and the exact object returned to the SDK:
        // an SDK mutation must not be hidden merely by our load-time cloning.
        expect(fixture.source).toEqual(fixture.sourceSnapshot);
        expect(fixture.loadedSnapshots).toEqual([fixture.sourceSnapshot]);
      }),
    );
  }

  it.effect("refuses a missing native cutoff without publishing a fallback root", () =>
    Effect.gen(function* () {
      yield* isolateSdkNamespace;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-sdk-history-" });
      const projectKey = (yield* fs.realPath(directory)).replace(/[^a-zA-Z0-9]/g, "-");
      const fixture = guardedStore(projectKey);
      yield* Effect.promise(async () => {
        await expect(
          forkSession(SOURCE_SESSION, {
            dir: directory,
            upToMessageId: MISSING_MESSAGE,
            sessionStore: fixture.store,
          }),
        ).rejects.toThrow(`Message ${MISSING_MESSAGE} not found in session ${SOURCE_SESSION}`);
      });
      expect(fixture.loads).toEqual([{ projectKey, sessionId: SOURCE_SESSION }]);
      expect(fixture.publications).toEqual([]);
      expect(fixture.source).toEqual(fixture.sourceSnapshot);
      expect(fixture.loadedSnapshots).toEqual([fixture.sourceSnapshot]);
    }),
  );

  it.effect("rejects an actual SDK child-history read at the root-only store boundary", () =>
    Effect.gen(function* () {
      yield* isolateSdkNamespace;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-sdk-history-" });
      const projectKey = (yield* fs.realPath(directory)).replace(/[^a-zA-Z0-9]/g, "-");
      const fixture = guardedStore(projectKey);
      yield* Effect.promise(async () => {
        await expect(
          getSubagentMessages(SOURCE_SESSION, "child-sentinel", {
            dir: directory,
            sessionStore: fixture.store,
          }),
        ).rejects.toMatchObject({ _tag: "HistoryStoreRefusal", reason: "child-subpath" });
      });
      expect(fixture.loads).toEqual([
        { projectKey, sessionId: SOURCE_SESSION, subpath: "subagents/agent-child-sentinel" },
      ]);
      expect(fixture.loadedSnapshots).toEqual([]);
      expect(fixture.publications).toEqual([]);
      expect(fixture.source).toEqual(fixture.sourceSnapshot);
    }),
  );
});
