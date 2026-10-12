import { useMemo } from "react";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { useComposerDraftStore } from "../../composerDraftStore";
import { buildCodexContextWindowEditorKey } from "../../codexContextWindow";
import { useCodexContextWindowOverride } from "./useCodexContextWindowOverride";

const transport = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../../environments/runtime", () => ({
  resolveEnvironmentHttpUrl: () => {
    throw new Error(
      "Context metadata fixtures never resolve attachments or contact an HTTP environment",
    );
  },
  requireEnvironmentConnection: (environmentId: string) => ({
    client: {
      orchestration: {
        dispatchCommand: (command: unknown) => transport.dispatch(environmentId, command),
      },
    },
  }),
}));
const local = EnvironmentId.make("context-hook-local");
const remote = EnvironmentId.make("context-hook-remote");
const threadId = ThreadId.make("same-chat-id");
const instanceId = ProviderInstanceId.make("codex");

function Harness(props: { environmentId: EnvironmentId; model: string; onSettled: () => void }) {
  const target = useMemo(
    () => scopeThreadRef(props.environmentId, threadId),
    [props.environmentId],
  );
  const save = useCodexContextWindowOverride({
    environmentId: props.environmentId,
    threadId,
    target,
    isServerThread: true,
    supported: true,
    key: buildCodexContextWindowEditorKey({
      environmentId: props.environmentId,
      threadId,
      draftId: null,
      instanceId,
      model: props.model,
      isServerThread: true,
    }),
  });
  return (
    <button
      onClick={() => {
        void save(700_000).then(props.onSettled, props.onSettled);
      }}
    >
      Save fixture policy
    </button>
  );
}

describe("Codex context ACK scope across environments and unmount", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    transport.dispatch.mockReset();
  });
  it.each(["environment", "model", "unmount"] as const)(
    "does not install a late ACK overlay after %s retirement",
    async (transition) => {
      let release!: (ack: { sequence: number }) => void;
      transport.dispatch.mockImplementation(
        () =>
          new Promise<{ sequence: number }>((resolve) => {
            release = resolve;
          }),
      );
      const onSettled = vi.fn();
      mounted = await render(<Harness environmentId={local} model="gpt-5" onSettled={onSettled} />);
      await page.getByRole("button", { name: "Save fixture policy", exact: true }).click();
      expect(transport.dispatch).toHaveBeenCalledExactlyOnceWith(
        local,
        expect.objectContaining({
          type: "thread.meta.update",
          threadId,
          codexContextWindowOverride: 700_000,
        }),
      );
      if (transition === "unmount") {
        await mounted.unmount();
        mounted = undefined;
      } else {
        await mounted.rerender(
          <Harness
            environmentId={transition === "environment" ? remote : local}
            model={transition === "model" ? "gpt-5.6-sol" : "gpt-5"}
            onSettled={onSettled}
          />,
        );
        await mounted.rerender(
          <Harness environmentId={local} model="gpt-5" onSettled={onSettled} />,
        );
      }
      release({ sequence: 2 });
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
      expect(
        useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(local, threadId))
          ?.codexContextWindowOverride,
      ).toBeUndefined();
      expect(
        useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(remote, threadId))
          ?.codexContextWindowOverride,
      ).toBeUndefined();
    },
  );
});
