import { useId, useState } from "react";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import type { ProviderInstanceId, ServerProvider } from "@cafecode/contracts";

import { Button } from "../ui/button";
import {
  readWorkspaceEnvironmentId,
  useWorkspaceEnvironmentId,
} from "../../environments/workspace";

import {
  captureProviderUpdateFailure,
  providerUpdateOutputForDisplay,
  providerUpdatePhaseLabel,
  providerUpdateCategoryLabel,
  sameProviderUpdateFailure,
  type FailureSnapshot,
} from "./ProviderUpdateFailureDetails.logic";

/** The wrapper deliberately unmounts the local reveal when the failure clears.
 * Never borrow another account's result based only on a matching driver. */
export function ProviderUpdateFailureDetails(props: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly provider: ServerProvider | undefined;
}) {
  const environmentId = useWorkspaceEnvironmentId();
  const provider = props.provider;
  if (
    !environmentId ||
    !provider ||
    provider.instanceId !== props.instanceId ||
    provider.driver !== props.driver ||
    provider.updateState?.status !== "failed"
  )
    return null;
  return (
    <ProviderUpdateFailurePanel
      snapshot={{
        environmentId,
        instanceId: provider.instanceId,
        driver: provider.driver,
        state: provider.updateState,
      }}
    />
  );
}

function ProviderUpdateFailurePanel({ snapshot }: { readonly snapshot: FailureSnapshot }) {
  const uiLocale = useUiLocale();
  const panelId = useId();
  const [revealed, setRevealed] = useState<FailureSnapshot | null>(null);
  const open =
    readWorkspaceEnvironmentId() === snapshot.environmentId &&
    revealed !== null &&
    sameProviderUpdateFailure(revealed, snapshot);
  const state = snapshot.state;
  const diagnostics = state.diagnostics;
  // Do not even mount received output until this exact snapshot is explicitly
  // revealed. A changed snapshot is collapsed during render, before paint.
  const output =
    open && !diagnostics?.timedOut && state.output !== null
      ? providerUpdateOutputForDisplay(state.output)
      : null;
  return (
    <section
      className="rounded-lg border border-status-error/25 px-3 py-2 text-xs"
      aria-label={uiText("Provider update failure", undefined, undefined, uiLocale)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 break-words text-status-error">
          {state.message ?? uiText("Provider update failed.", undefined, undefined, uiLocale)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() =>
            setRevealed(
              readWorkspaceEnvironmentId() === snapshot.environmentId && !open
                ? captureProviderUpdateFailure(snapshot)
                : null,
            )
          }
        >
          {open
            ? uiText("Hide failure details", undefined, undefined, uiLocale)
            : uiText("Show failure details", undefined, undefined, uiLocale)}
        </Button>
      </div>
      {open ? (
        <div id={panelId} className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            {uiText(
              "Command output may contain local paths or account details.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
          {diagnostics ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt>{uiText("Phase", undefined, undefined, uiLocale)}</dt>
              <dd>{providerUpdatePhaseLabel(diagnostics.phase, uiLocale)}</dd>
              <dt>{uiText("Failure category", undefined, undefined, uiLocale)}</dt>
              <dd>{providerUpdateCategoryLabel(diagnostics.category, uiLocale)}</dd>
              <dt>{uiText("Exit code", undefined, undefined, uiLocale)}</dt>
              <dd>
                {diagnostics.exitCode ?? uiText("Not recorded", undefined, undefined, uiLocale)}
              </dd>
            </dl>
          ) : (
            <p>
              {uiText(
                "Detailed status was not recorded by this Cafe Code version.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          )}
          {diagnostics?.timedOut ? (
            <p>{uiText("The update command timed out.", undefined, undefined, uiLocale)}</p>
          ) : null}
          {diagnostics?.outputTruncated ? (
            <p>
              {uiText("Captured command output was truncated.", undefined, undefined, uiLocale)}
            </p>
          ) : null}
          {output?.controlsEscaped ? (
            <p>
              {uiText(
                "Nonprinting and directional controls are shown as Unicode escapes.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : null}
          {output?.displayTruncated ? (
            <p>
              {uiText("Displayed command output was truncated.", undefined, undefined, uiLocale)}
            </p>
          ) : null}
          {output && output.text.length > 0 ? (
            <pre
              translate="no"
              dir="ltr"
              tabIndex={0}
              aria-label={uiText("Captured update command output", undefined, undefined, uiLocale)}
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs [unicode-bidi:plaintext]"
            >
              {output.text}
            </pre>
          ) : (
            <p>
              {diagnostics?.timedOut
                ? uiText(
                    "Command output is unavailable because the update timed out.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "No command output is available for this update.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
