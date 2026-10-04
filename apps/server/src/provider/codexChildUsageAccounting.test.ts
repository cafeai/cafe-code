import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { UsageAccountingSnapshot } from "@cafecode/contracts";
import {
  CODEX_CHILD_USAGE_LIMIT,
  codexChildUsageMetadata,
  makeCodexChildUsageAccounting,
} from "./codexChildUsageAccounting.ts";
const decodeAccountingSnapshot = Schema.decodeUnknownSync(UsageAccountingSnapshot);

const metadata = (id = "child", parent = "root", model: unknown = "gpt-6.1-sol") => ({
  id,
  parentThreadId: parent,
  model,
  source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
  // This content must never survive the bounded metadata projection.
  cwd: "/private/work",
  preview: "private prompt",
  turns: [{ secret: "private output" }],
});
const counts = (
  inputTokens: number,
  outputTokens = 0,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
  reasoningOutputTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  reasoningOutputTokens,
  totalTokens: inputTokens + outputTokens,
});
function fixture() {
  const collector = makeCodexChildUsageAccounting();
  const routes = new Map<string, string>();
  const observe = (method: string, payload: unknown, rootId = "root") =>
    collector.observe({ rootId, routes, method, payload });
  const add = (id = "child", parent = "root", model: unknown = "gpt-6.1-sol") => {
    routes.set(id, `owner-${id}`);
    observe("thread/started", { thread: metadata(id, parent, model) });
  };
  const usage = (value: unknown, id = "child", rootId = "root") =>
    observe("thread/tokenUsage/updated", { threadId: id, tokenUsage: { total: value } }, rootId);
  return { collector, routes, observe, add, usage };
}

describe("prospective Codex child accounting", () => {
  it("anchors inherited history then accumulates disjoint increments once", () => {
    const f = fixture();
    f.add();
    expect(f.usage(counts(1000, 100, 500, 50, 20))).toBeUndefined();
    const first = f.usage(counts(1100, 140, 550, 60, 30))!;
    expect(decodeAccountingSnapshot(first)).toEqual(first);
    expect(first).toMatchObject({
      revision: 1,
      completeness: "partial",
      models: [
        {
          model: "gpt-6.1-sol",
          inputTokens: 100,
          cachedInputTokens: 50,
          cacheWriteInputTokens: 10,
          outputTokens: 40,
          reasoningOutputTokens: 10,
        },
      ],
    });
    expect(f.usage(counts(1100, 140, 550, 60, 30))).toBeUndefined();
    const next = f.usage(counts(1200, 150, 600, 60, 30))!;
    expect(next.scopeId).toBe(first.scopeId);
    expect(next.revision).toBe(2);
    expect(next.models[0]?.inputTokens).toBe(200);
    expect(next.models[0]?.outputTokens).toBe(50);
    expect(first.models[0]?.inputTokens).toBe(100);
    expect(JSON.stringify(next)).not.toMatch(/root|child|owner|private/);
  });

  it("excludes parent counters, unknown routes and unrelated ancestry", () => {
    const f = fixture();
    f.add();
    f.add("foreign", "unowned");
    for (const id of ["root", "missing", "foreign"]) {
      expect(f.usage(counts(0), id)).toBeUndefined();
      expect(f.usage(counts(100), id)).toBeUndefined();
    }
    f.routes.set("unattested", "owner");
    expect(f.usage(counts(0), "unattested")).toBeUndefined();
    expect(f.usage(counts(100), "unattested")).toBeUndefined();
    expect(f.usage(counts(0))).toBeUndefined();
    expect(f.usage(counts(20))?.models[0]?.inputTokens).toBe(20);
  });

  it("admits nested exact descendants once metadata and routes are present", () => {
    const f = fixture();
    f.add("grandchild", "child");
    expect(f.usage(counts(20), "grandchild")).toBeUndefined();
    f.add();
    expect(f.usage(counts(30), "grandchild")).toBeUndefined();
    expect(f.usage(counts(50), "grandchild")?.models[0]?.inputTokens).toBe(20);
    expect(f.usage(counts(100))).toBeUndefined();
    expect(f.usage(counts(120))?.models[0]?.inputTokens).toBe(20);
  });

  it("does not reset accounting on reuse or duplicated metadata", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    const first = f.usage(counts(25))!;
    f.add();
    f.observe("turn/started", { threadId: "child", turn: { id: "new-turn" } });
    const next = f.usage(counts(30))!;
    expect(next.scopeId).toBe(first.scopeId);
    expect(next.models[0]?.inputTokens).toBe(30);
    f.routes.set("child", "different-owner");
    expect(f.usage(counts(35))).toBeUndefined();
    f.routes.set("child", "owner-child");
    expect(f.usage(counts(40))).toBeUndefined();
  });

  it("binds one root/account runtime and never rebinds an epoch", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    expect(f.usage(counts(10))).toBeDefined();
    expect(f.usage(counts(20), "child", "another-root")).toBeUndefined();
    expect(f.usage(counts(30))).toBeUndefined();
  });

  it("restarts and forks subtract observed history instead of charging it again", () => {
    const first = fixture();
    first.add();
    first.usage(counts(0));
    const old = first.usage(counts(100))!;
    const resumed = fixture();
    resumed.add();
    expect(resumed.usage(counts(150))).toBeUndefined();
    const current = resumed.usage(counts(180))!;
    expect(current.scopeId).not.toBe(old.scopeId);
    expect(current.models[0]?.inputTokens).toBe(30);
    // A hard crash before journalling cannot justify historical reconstruction.
    const afterCrash = fixture();
    afterCrash.add();
    expect(afterCrash.usage(counts(200))).toBeUndefined();
    expect(afterCrash.usage(counts(210))?.models[0]?.inputTokens).toBe(10);
  });

  it.each([
    [counts(9, 10), counts(10, 10)],
    [counts(100, 10, 60), counts(100, 10, 50)],
    [counts(100, 20, 0, 0, 11), counts(100, 20, 0, 0, 10)],
  ])("freezes on reordered or regressing independent categories", (lower, baseline) => {
    const f = fixture();
    f.add();
    f.usage(baseline);
    expect(f.usage(lower)).toBeUndefined();
    expect(f.usage(counts(500, 100, 60, 10, 20))).toBeUndefined();
  });

  it("rejects context-full synthetic reset and never uses totalTokens as spend", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    expect(f.usage({ ...counts(10), totalTokens: 999999 })?.models[0]?.inputTokens).toBe(10);
    expect(f.usage({ ...counts(0), totalTokens: 272000 })).toBeUndefined();
    expect(f.usage(counts(100))).toBeUndefined();
  });

  it.each([
    counts(-1),
    counts(1.2),
    counts(Number.MAX_SAFE_INTEGER + 1),
    counts(5, 0, 6),
    counts(5, 0, 3, 3),
    counts(0, 1, 0, 0, 2),
    { ...counts(1), inputTokens: "1" },
    { ...counts(1), cachedInputTokens: undefined },
  ])("fails closed on malformed counters", (bad) => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    expect(f.usage(bad)).toBeUndefined();
    expect(f.usage(counts(100))).toBeUndefined();
  });

  it("supports omitted legacy cache-write counters without guessing other fields", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    const { cacheWriteInputTokens: _write, ...legacy } = counts(10, 5);
    expect(f.usage(legacy)?.models[0]).toMatchObject({ cacheWriteInputTokens: 0, inputTokens: 10 });
  });

  it("keeps models separate and anchors uncertain transition intervals", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    f.usage(counts(20));
    f.observe("thread/settings/updated", {
      threadId: "child",
      threadSettings: { model: "gpt-6-astra" },
    });
    expect(f.usage(counts(40))).toBeUndefined();
    expect(f.usage(counts(50))?.models).toMatchObject([
      { model: "gpt-6.1-sol", inputTokens: 20 },
      { model: "gpt-6-astra", inputTokens: 10 },
    ]);
    f.observe("model/rerouted", { threadId: "child", toModel: "private/invalid" });
    expect(f.usage(counts(55))).toBeUndefined();
    expect(f.usage(counts(60))?.models.at(-1)).toMatchObject({ model: "unknown", inputTokens: 5 });
  });

  it("uses unknown, never the root's model, when native child metadata is absent", () => {
    const f = fixture();
    f.add("child", "root", null);
    f.usage(counts(0));
    f.observe("model/rerouted", { threadId: "root", toModel: "gpt-6-astra" });
    expect(f.usage(counts(10))?.models[0]?.model).toBe("unknown");
  });

  it("bounds model rows without evicting previously billed attribution", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    let last: UsageAccountingSnapshot | undefined;
    for (let i = 0; i < 64; i += 1) {
      f.observe("model/rerouted", { threadId: "child", toModel: `model-${i}` });
      f.usage(counts(i * 2));
      last = f.usage(counts(i * 2 + 1));
    }
    expect(last?.models).toHaveLength(64);
    f.observe("model/rerouted", { threadId: "child", toModel: "overflow" });
    f.usage(counts(128));
    expect(f.usage(counts(129))).toBeUndefined();
    expect(last?.models).toHaveLength(64);
  });

  it("bounds identities and retains existing watermarks after overflow", () => {
    const f = fixture();
    for (let i = 0; i <= CODEX_CHILD_USAGE_LIMIT; i += 1) f.add(`child-${i}`);
    f.usage(counts(0), "child-0");
    expect(f.usage(counts(10), "child-0")?.models[0]?.inputTokens).toBe(10);
    expect(f.usage(counts(0), `child-${CODEX_CHILD_USAGE_LIMIT}`)).toBeUndefined();
    expect(f.usage(counts(10), `child-${CODEX_CHILD_USAGE_LIMIT}`)).toBeUndefined();
  });

  it("rejects cycles, overdeep ancestry and changed native parent identity", () => {
    const f = fixture();
    f.add("a", "b");
    f.add("b", "a");
    expect(f.usage(counts(0), "a")).toBeUndefined();
    expect(f.usage(counts(10), "a")).toBeUndefined();
    for (let i = 0; i < 33; i += 1) f.add(`deep-${i}`, i === 0 ? "root" : `deep-${i - 1}`);
    f.usage(counts(0), "deep-31");
    expect(f.usage(counts(1), "deep-31")).toBeDefined();
    f.usage(counts(0), "deep-32");
    expect(f.usage(counts(1), "deep-32")).toBeUndefined();
    f.add();
    f.usage(counts(0));
    f.observe("thread/started", { thread: metadata("child", "other") });
    expect(f.usage(counts(10))).toBeUndefined();
  });

  it("rejects overflow across disjoint totals without partially advancing a ledger", () => {
    const f = fixture();
    f.add();
    f.usage(counts(0));
    expect(f.usage(counts(Number.MAX_SAFE_INTEGER, 1))).toBeUndefined();
    expect(f.usage(counts(10))).toBeUndefined();
  });

  it.each([false, true])(
    "rejects cumulative processed overflow across snapshots (model switch: %s)",
    (switchModel) => {
      const f = fixture();
      f.add();
      f.usage(counts(0));
      const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
      const settled = f.usage(counts(half, half))!;
      expect(settled.revision).toBe(1);
      if (switchModel) {
        f.observe("model/rerouted", { threadId: "child", toModel: "gpt-6-astra" });
        expect(f.usage(counts(half, half))).toBeUndefined();
      }
      // Each field and the new 2-token delta remain individually safe. Their
      // cumulative processed sum does not, so the whole publication must fail.
      expect(f.usage(counts(half + 1, half + 1))).toBeUndefined();
      expect(f.usage(counts(half + 2, half + 2))).toBeUndefined();
      const { totalTokens: _total, ...expected } = counts(half, half);
      expect(settled.models).toEqual([{ model: "gpt-6.1-sol", ...expected }]);
    },
  );

  it("copies bounded metadata from existing liveness reads, never content", () => {
    const value = codexChildUsageMetadata(metadata())!;
    expect(value).toEqual({ id: "child", parentThreadId: "root", model: "gpt-6.1-sol" });
    for (const invalid of [
      metadata("root", "root"),
      metadata("x".repeat(513)),
      { ...metadata(), source: { subAgent: "review" } },
      { ...metadata(), parentThreadId: "wrong" },
      { ...metadata(), id: "child\n" },
    ]) {
      expect(codexChildUsageMetadata(invalid)).toBeUndefined();
    }
    const f = fixture();
    f.routes.set("child", "owner");
    f.collector.observeMetadata(value, "root");
    f.usage(counts(0));
    expect(f.usage(counts(5))?.models[0]?.inputTokens).toBe(5);
  });

  it("bounds combined child publications in one runtime", () => {
    const f = fixture();
    f.add();
    f.add("second");
    f.usage(counts(0));
    f.usage(counts(0), "second");
    expect(f.usage(counts(Number.MAX_SAFE_INTEGER - 1))).toBeDefined();
    expect(f.usage(counts(1), "second")).toBeDefined();
    expect(f.usage(counts(2), "second")).toBeUndefined();
    expect(f.usage(counts(Number.MAX_SAFE_INTEGER))).toBeUndefined();
  });
});
