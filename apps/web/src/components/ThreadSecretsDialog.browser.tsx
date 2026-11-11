import { EnvironmentId, ThreadId, type ThreadSecretMetadata } from "@cafecode/contracts";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, type TestContext, vi } from "vitest";
import { page } from "vitest/browser";

import { useThreadSecretsDialogStore } from "../cafeSecrets/threadSecretsDialogStore";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { ThreadSecretsDialogHost } from "./ThreadSecretsDialog";

const localApi = vi.hoisted(() => ({
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  copyText: vi.fn<(value: string) => Promise<void>>(),
}));

const environmentId = EnvironmentId.make("env-secrets-dialog");
const threadA = ThreadId.make("thread-secrets-dialog-a");
const threadB = ThreadId.make("thread-secrets-dialog-b");

function metadata(id: string, label: string): ThreadSecretMetadata {
  return {
    id,
    label,
    reference: `[CAFE_SECRET_${id}]`,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
}
const secretA = metadata("0123456789abcdef0123456789abcdef", "Staging key");
const secretB = metadata("fedcba9876543210fedcba9876543210", "Other chat key");

type SecretsApi = ReturnType<typeof makeApi>;
function makeApi() {
  return {
    list: vi.fn(async ({ threadId }: { threadId: ThreadId }) => ({
      secrets: threadId === threadA ? [secretA] : [secretB],
    })),
    reveal: vi.fn(async (_input: { threadId: ThreadId; id: string }) => ({
      value: "hunter2-dialog",
    })),
    set: vi.fn(async (_input: Record<string, unknown>) => ({ secret: secretA })),
    remove: vi.fn(async (_input: { threadId: ThreadId; id: string }) => ({ removed: true })),
    clear: vi.fn(async (_input: { threadId: ThreadId }) => ({ removed: 1 })),
    capabilities: vi.fn(),
    prepare: vi.fn(),
  };
}

/**
 * One exact case owner, registered before render. Retirement (abort or
 * completion) closes the dialog store, joins every tracked async operation
 * and unmounts; the shared afterEach joins that same owner before any API
 * override or mock reset, since Vitest runs afterEach before onTestFinished.
 */
let ownerCleanup: (() => Promise<void>) | null = null;
function createSecretsFixture(context: TestContext, api: SecretsApi | null) {
  if (ownerCleanup) throw new Error("A secrets dialog fixture is already owned.");
  let retired = false;
  let rendering: ReturnType<typeof render> | undefined;
  let completion: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  const cleanup = () => {
    retired = true;
    for (const release of releases) release();
    return (completion ??= Promise.resolve().then(async () => {
      useThreadSecretsDialogStore.getState().close();
      await Promise.allSettled(pending);
      const mounted = await rendering?.catch(() => null);
      await mounted?.unmount();
      context.signal.removeEventListener("abort", retire);
    }));
  };
  const retire = () => {
    void cleanup().catch(() => {});
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(cleanup);
  ownerCleanup = cleanup;
  if (context.signal.aborted) retire();
  const assertActive = () => {
    if (retired) throw new Error("Secrets dialog fixture has retired.");
  };
  __setEnvironmentApiOverrideForTests(environmentId, (api ? { threadSecrets: api } : {}) as never);
  return {
    async mount() {
      assertActive();
      rendering = render(
        <ThreadSecretsDialogHost confirm={localApi.confirm} copyText={localApi.copyText} />,
      );
      await rendering;
      assertActive();
    },
    /** Replace the environment's connection-owned API under the same ID. */
    replaceApi(next: SecretsApi) {
      assertActive();
      __setEnvironmentApiOverrideForTests(environmentId, { threadSecrets: next } as never);
    },
    open(threadId: ThreadId) {
      assertActive();
      useThreadSecretsDialogStore.getState().open({ environmentId, threadId }, "Chat");
    },
    /** Holds the next call of `fn` until released; cleanup always releases. */
    hold<T>(fn: { mockImplementationOnce: (impl: () => Promise<T>) => unknown }, value: T) {
      assertActive();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.add(release);
      fn.mockImplementationOnce(() => {
        entered();
        const operation = gate.then(() => value);
        pending.add(operation);
        return operation;
      });
      return {
        started,
        release: () => {
          releases.delete(release);
          release();
        },
      };
    },
  };
}

async function joinOwner() {
  const owner = ownerCleanup;
  if (!owner) return;
  await owner();
  if (ownerCleanup === owner) ownerCleanup = null;
}

beforeEach(async () => {
  await joinOwner();
  localApi.confirm.mockReset().mockResolvedValue(true);
  localApi.copyText.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await joinOwner();
  __resetEnvironmentApiOverridesForTests();
});

const valueShown = () => document.body.textContent?.includes("hunter2-dialog") ?? false;

it("lists masked metadata and reveals a value only on explicit request", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();
  expect(valueShown()).toBe(false);
  expect(api.list).toHaveBeenCalledWith({ threadId: threadA });
  expect(api.reveal).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Reveal value" }).click();
  await expect.element(page.getByText("hunter2-dialog")).toBeVisible();
  expect(api.reveal).toHaveBeenCalledExactlyOnceWith({ threadId: threadA, id: secretA.id });

  await page.getByRole("button", { name: "Hide value" }).click();
  await expect.poll(valueShown).toBe(false);
});

it("never shows a reveal that resolves after the dialog moved to another chat", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();
  const held = fixture.hold(api.reveal, { value: "hunter2-dialog" });
  await page.getByRole("button", { name: "Reveal value" }).click();
  await held.started;

  fixture.open(threadB);
  await expect.element(page.getByText("Other chat key")).toBeVisible();
  held.release();
  await expect.poll(() => api.reveal.mock.results.length).toBe(1);
  await Promise.resolve(api.reveal.mock.results[0]!.value);
  expect(valueShown()).toBe(false);
  expect(document.body.textContent).not.toContain("Staging key");
  // Reopening the original chat starts masked again.
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();
  expect(valueShown()).toBe(false);
});

it("adds a secret with only its value when no label is given", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await page.getByRole("button", { name: "Add secret" }).click();
  await page.getByLabelText("Value", { exact: true }).fill("new-value");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => api.set.mock.calls.length).toBe(1);
  expect(api.set).toHaveBeenCalledWith({ threadId: threadA, value: "new-value" });
  await expect.poll(() => api.list.mock.calls.length).toBe(2);
});

it("edits a label while keeping the stored value, or replaces the value", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await page.getByRole("button", { name: "Edit secret" }).click();
  await page.getByLabelText("Label (optional)").fill("Renamed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => api.set.mock.calls.length).toBe(1);
  // Keeping the value reads it only for this explicit Save and never shows it.
  expect(api.reveal).toHaveBeenCalledExactlyOnceWith({ threadId: threadA, id: secretA.id });
  expect(api.set).toHaveBeenLastCalledWith({
    threadId: threadA,
    id: secretA.id,
    label: "Renamed",
    value: "hunter2-dialog",
  });
  expect(valueShown()).toBe(false);

  await page.getByRole("button", { name: "Edit secret" }).click();
  await page.getByLabelText("New value (leave empty to keep)").fill("rotated");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => api.set.mock.calls.length).toBe(2);
  expect(api.reveal).toHaveBeenCalledTimes(1);
  expect(api.set).toHaveBeenLastCalledWith({
    threadId: threadA,
    id: secretA.id,
    label: "Staging key",
    value: "rotated",
  });
});

it("removes and clears only after confirmation", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();

  localApi.confirm.mockResolvedValueOnce(false);
  await page.getByRole("button", { name: "Remove secret" }).click();
  await expect.poll(() => localApi.confirm.mock.calls.length).toBe(1);
  await expect.element(page.getByRole("button", { name: "Remove secret" })).toBeEnabled();
  expect(api.remove).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Remove secret" }).click();
  await expect.poll(() => api.remove.mock.calls.length).toBe(1);
  expect(api.remove).toHaveBeenCalledWith({ threadId: threadA, id: secretA.id });

  await expect.element(page.getByRole("button", { name: "Clear all" })).toBeEnabled();
  localApi.confirm.mockResolvedValueOnce(false);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect.poll(() => localApi.confirm.mock.calls.length).toBe(3);
  await expect.element(page.getByRole("button", { name: "Clear all" })).toBeEnabled();
  expect(api.clear).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect.poll(() => api.clear.mock.calls.length).toBe(1);
  expect(api.clear).toHaveBeenCalledWith({ threadId: threadA });
});

it("explains a server without the secrets API and offers no actions", async (context) => {
  const fixture = createSecretsFixture(context, null);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText(/does not support Cafe Secrets/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add secret" })).toBeDisabled();
});

it("admits exactly one action for repeated activation while a reveal is pending", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();
  const held = fixture.hold(api.reveal, { value: "hunter2-dialog" });
  const reveal = document.querySelector<HTMLButtonElement>('button[aria-label="Reveal value"]')!;
  const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy value"]')!;
  // Same-tick activations share one stale render; only the first is admitted.
  reveal.click();
  reveal.click();
  copy.click();
  await held.started;
  held.release();
  await expect.element(page.getByText("hunter2-dialog")).toBeVisible();
  expect(api.reveal).toHaveBeenCalledTimes(1);
  expect(localApi.copyText).not.toHaveBeenCalled();
});

it("copies through the clipboard only while the same connection still owns the dialog", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await expect.element(page.getByText("Staging key")).toBeVisible();

  await page.getByRole("button", { name: "Copy value" }).click();
  await expect.poll(() => localApi.copyText.mock.calls.length).toBe(1);
  expect(localApi.copyText).toHaveBeenCalledWith("hunter2-dialog");
  expect(valueShown()).toBe(false);

  // A replaced saved-server connection under the same EnvironmentId retires
  // the held copy before any clipboard side effect.
  const held = fixture.hold(api.reveal, { value: "hunter2-dialog" });
  await page.getByRole("button", { name: "Copy value" }).click();
  await held.started;
  const replacement = makeApi();
  fixture.replaceApi(replacement);
  held.release();
  await expect.poll(() => replacement.list.mock.calls.length).toBeGreaterThan(0);
  expect(localApi.copyText).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("never writes a kept value through a retired connection while editing", async (context) => {
  const api = makeApi();
  const fixture = createSecretsFixture(context, api);
  await fixture.mount();
  fixture.open(threadA);
  await page.getByRole("button", { name: "Edit secret" }).click();
  await page.getByLabelText("Label (optional)").fill("Renamed");
  const held = fixture.hold(api.reveal, { value: "hunter2-dialog" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await held.started;
  const replacement = makeApi();
  fixture.replaceApi(replacement);
  held.release();
  await expect.poll(() => replacement.list.mock.calls.length).toBeGreaterThan(0);
  expect(api.set).not.toHaveBeenCalled();
  expect(replacement.set).not.toHaveBeenCalled();
  expect(valueShown()).toBe(false);
});
