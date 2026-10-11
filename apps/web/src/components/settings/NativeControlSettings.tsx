import { useUiLocale } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { useEffect, useState } from "react";
import type {
  DesktopBridge,
  NativeControlPermissionsState,
  NativeControlResult,
  NativeControlState,
} from "@cafecode/contracts";
import { MonitorIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ControlBridge = Pick<
  DesktopBridge,
  | "getNativeControlState"
  | "setNativeControlEnabled"
  | "getNativeControlDiagnostics"
  | "captureNativeControlPreview"
  | "getNativeControlPermissions"
  | "requestNativeControlPermissions"
  | "onNativeControlChanged"
>;

/**
 * Retain provenance, not a translated result: changing the interface language
 * can redraw Cafe's feedback without repeating an IPC operation. Received
 * controller output remains opaque even if it happens to match a catalog key.
 */
type NativeControlFeedback =
  | { readonly kind: "received"; readonly text: string }
  | {
      readonly kind:
        | "initial-state-failed"
        | "state-failed"
        | "permission-setup-failed"
        | "enable-failed"
        | "operation-failed"
        | "operation-completed"
        | "check-failed";
    };

function formatNativeControlFeedback(feedback: NativeControlFeedback, locale: UiLocale): string {
  switch (feedback.kind) {
    case "received":
      return feedback.text;
    case "initial-state-failed":
      return uiText(
        "Could not read the local controller state. Restart Cafe or refresh.",
        undefined,
        undefined,
        locale,
      );
    case "state-failed":
      return uiText("Could not read the local controller state.", undefined, undefined, locale);
    case "permission-setup-failed":
      return uiText(
        "Could not open permission setup. Use System Settings → Privacy & Security.",
        undefined,
        undefined,
        locale,
      );
    case "enable-failed":
      return uiText(
        "Could not change desktop control. Refresh before retrying.",
        undefined,
        undefined,
        locale,
      );
    case "operation-failed":
      return uiText(
        "The native operation failed. Check permissions and refresh.",
        undefined,
        undefined,
        locale,
      );
    case "operation-completed":
      return uiText("Native operation completed.", undefined, undefined, locale);
    case "check-failed":
      return uiText(
        "The controller could not complete this check. Refresh its state before retrying.",
        undefined,
        undefined,
        locale,
      );
  }
}

export function NativeControlSettings({
  bridge = window.desktopBridge,
}: { bridge?: ControlBridge } = {}) {
  const uiLocale = useUiLocale();

  const [state, setState] = useState<NativeControlState>();
  const [permissions, setPermissions] = useState<NativeControlPermissionsState>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<NativeControlFeedback>();
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    let active = true;
    const update = () => {
      if (!bridge?.getNativeControlState) return;
      void Promise.all([bridge.getNativeControlState(), bridge.getNativeControlPermissions?.()])
        .then(([next, grants]) => {
          if (active) {
            setState(next);
            setPermissions(grants);
          }
        })
        .catch(() => {
          if (active) setFeedback({ kind: "initial-state-failed" });
        });
    };
    update();
    window.addEventListener("focus", update);
    const unsubscribe = bridge?.onNativeControlChanged?.(update);
    return () => {
      active = false;
      window.removeEventListener("focus", update);
      unsubscribe?.();
    };
  }, [bridge]);

  const refresh = async () => {
    setPending(true);
    setFeedback(undefined);
    try {
      setState(await bridge!.getNativeControlState!());
      setPermissions(await bridge?.getNativeControlPermissions?.());
    } catch {
      setFeedback({ kind: "state-failed" });
    } finally {
      setPending(false);
    }
  };
  const requestPermissions = async () => {
    setPending(true);
    setFeedback(undefined);
    try {
      setPermissions(await bridge!.requestNativeControlPermissions!());
      setState(await bridge!.getNativeControlState!());
    } catch {
      setFeedback({ kind: "permission-setup-failed" });
    } finally {
      setPending(false);
    }
  };
  const enabled = async (value: boolean) => {
    setPending(true);
    setFeedback(undefined);
    setPreview(undefined);
    try {
      setState(await bridge!.setNativeControlEnabled!(value));
    } catch {
      setFeedback({ kind: "enable-failed" });
    } finally {
      setPending(false);
    }
  };
  const showResult = (result: NativeControlResult) => {
    const text = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    const receivedText = text.slice(0, 8192);
    setFeedback(
      receivedText
        ? { kind: "received", text: receivedText }
        : { kind: result.isError ? "operation-failed" : "operation-completed" },
    );
    const image = result.content.find(
      (item) =>
        item.type === "image" && item.mimeType === "image/png" && typeof item.data === "string",
    );
    setPreview(image ? `data:image/png;base64,${image.data as string}` : undefined);
  };
  const check = async (capture: boolean) => {
    setPending(true);
    setFeedback(undefined);
    setPreview(undefined);
    try {
      showResult(
        await (capture
          ? bridge!.captureNativeControlPreview!()
          : bridge!.getNativeControlDiagnostics!()),
      );
      setState(await bridge!.getNativeControlState!());
    } catch {
      setFeedback({ kind: "check-failed" });
    } finally {
      setPending(false);
    }
  };
  if (!bridge?.getNativeControlState || (state && state.platform !== "darwin")) return null;
  return (
    <SettingsSection
      title={uiText("Local desktop control", undefined, undefined, uiLocale)}
      icon={<MonitorIcon className="size-3.5" />}
    >
      <SettingsRow
        title={uiText("Codex and Claude", undefined, undefined, uiLocale)}
        description={uiText(
          "Allow desktop tools through local Cua. Each chat starts with computer use off; click the cursor beside the thinking settings to enable it. No Cua account or subscription is needed.",
          undefined,
          undefined,
          uiLocale,
        )}
        control={
          <Switch
            aria-label={uiText("Enable local desktop control", undefined, undefined, uiLocale)}
            checked={state?.enabled ?? false}
            disabled={pending || !state?.runtimeAvailable || !bridge?.setNativeControlEnabled}
            onCheckedChange={(value) => {
              void enabled(value);
            }}
          />
        }
      />
      <div className="space-y-3 px-5 py-3.5 text-sm text-muted-foreground">
        <p>
          {state?.detail ??
            uiText("Reading local controller state…", undefined, undefined, uiLocale)}
        </p>
        {state && !state.runtimeAvailable && (
          <p>
            {uiText(
              "The reviewed native runtime is unavailable for this build. Complete the local runtime setup before enabling control, then refresh.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        )}
        {state?.platform === "darwin" && (
          <p>
            {uiText(
              "Allow Cafe Code in System Settings → Privacy & Security. A restart may be required after granting access.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        )}
        {permissions && (
          <p role="status">
            <UiMessage
              message="Accessibility: {accessibility, select, granted {Allowed} unknown {Unknown} other {Needed}} · Screen Recording: {screenRecording, select, granted {Allowed} unknown {Unknown} other {Needed}}"
              values={{
                accessibility: permissions.accessibility,
                screenRecording: permissions.screenRecording,
              }}
            />
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !bridge?.getNativeControlState}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCwIcon className="mr-1.5 size-3.5" />
            {uiText("Refresh state", undefined, undefined, uiLocale)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !state?.enabled}
            onClick={() => {
              void check(false);
            }}
          >
            {uiText("Check permissions", undefined, undefined, uiLocale)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending ||
              !state?.enabled ||
              !bridge?.requestNativeControlPermissions ||
              (permissions?.accessibility === "granted" &&
                permissions.screenRecording === "granted")
            }
            onClick={() => {
              void requestPermissions();
            }}
          >
            {uiText("Set up permissions", undefined, undefined, uiLocale)}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !state?.enabled}
            onClick={() => {
              void check(true);
            }}
          >
            {uiText("Test screenshot", undefined, undefined, uiLocale)}
          </Button>
        </div>
        {state?.enabled && (
          <p>
            {uiText(
              "Use a new Codex or Claude session, or normally stop/resume an existing session, to connect its desktop tools. Ask it to check desktop health, observe before acting, and release control when finished.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
        )}
        {feedback && (
          <pre
            role="status"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs"
          >
            {formatNativeControlFeedback(feedback, uiLocale)}
          </pre>
        )}
        {preview && (
          <img
            alt={uiText("Native desktop test screenshot", undefined, undefined, uiLocale)}
            src={preview}
            className="max-h-96 w-full rounded-md border object-contain"
          />
        )}
      </div>
    </SettingsSection>
  );
}
