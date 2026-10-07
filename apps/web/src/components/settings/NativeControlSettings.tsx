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
export function NativeControlSettings({
  bridge = window.desktopBridge,
}: { bridge?: ControlBridge } = {}) {
  const [state, setState] = useState<NativeControlState>();
  const [permissions, setPermissions] = useState<NativeControlPermissionsState>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
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
          if (active)
            setFeedback("Could not read the local controller state. Restart Cafe or refresh.");
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
      setFeedback("Could not read the local controller state.");
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
      setFeedback("Could not open permission setup. Use System Settings → Privacy & Security.");
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
      setFeedback("Could not change desktop control. Refresh before retrying.");
    } finally {
      setPending(false);
    }
  };
  const showResult = (result: NativeControlResult) => {
    const text = result.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    setFeedback(
      text.slice(0, 8192) ||
        (result.isError
          ? "The native operation failed. Check permissions and refresh."
          : "Native operation completed."),
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
      setFeedback(
        "The controller could not complete this check. Refresh its state before retrying.",
      );
    } finally {
      setPending(false);
    }
  };
  if (!bridge?.getNativeControlState || (state && state.platform !== "darwin")) return null;
  return (
    <SettingsSection title="Local desktop control" icon={<MonitorIcon className="size-3.5" />}>
      <SettingsRow
        title="Codex and Claude"
        description="Allow desktop tools to observe and control this computer through local Cua. Available by default on Mac; use the composer button to turn computer use on or off for each chat. No Cua account or subscription is needed."
        control={
          <Switch
            aria-label="Enable local desktop control"
            checked={state?.enabled ?? false}
            disabled={pending || !state?.runtimeAvailable || !bridge?.setNativeControlEnabled}
            onCheckedChange={(value) => {
              void enabled(value);
            }}
          />
        }
      />
      <div className="space-y-3 px-5 py-3.5 text-sm text-muted-foreground">
        <p>{state?.detail ?? "Reading local controller state…"}</p>
        {state && !state.runtimeAvailable && (
          <p>
            The reviewed native runtime is unavailable for this build. Complete the local runtime
            setup before enabling control, then refresh.
          </p>
        )}
        {state?.platform === "darwin" && (
          <p>
            Allow Cafe Code in System Settings → Privacy &amp; Security. A restart may be required
            after granting access.
          </p>
        )}
        {permissions && (
          <p role="status">
            Accessibility:{" "}
            {permissions.accessibility === "granted"
              ? "Allowed"
              : permissions.accessibility === "unknown"
                ? "Unknown"
                : "Needed"}
            {" · "}
            Screen Recording:{" "}
            {permissions.screenRecording === "granted"
              ? "Allowed"
              : permissions.screenRecording === "unknown"
                ? "Unknown"
                : "Needed"}
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
            Refresh state
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !state?.enabled}
            onClick={() => {
              void check(false);
            }}
          >
            Check permissions
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
            Set up permissions
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !state?.enabled}
            onClick={() => {
              void check(true);
            }}
          >
            Test screenshot
          </Button>
        </div>
        {state?.enabled && (
          <p>
            Use a new Codex or Claude session, or normally stop/resume an existing session, to
            connect its desktop tools. Ask it to check desktop health, observe before acting, and
            release control when finished.
          </p>
        )}
        {feedback && (
          <pre
            role="status"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs"
          >
            {feedback}
          </pre>
        )}
        {preview && (
          <img
            alt="Native desktop test screenshot"
            src={preview}
            className="max-h-96 w-full rounded-md border object-contain"
          />
        )}
      </div>
    </SettingsSection>
  );
}
