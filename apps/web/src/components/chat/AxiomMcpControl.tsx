import { useLayoutEffect, useRef, useState } from "react";
import { PlugIcon, RefreshCwIcon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderMcpInput,
  ProviderMcpState,
  ProviderSecurityInput,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

/** Reads and executable edits are explicit owner actions. No mounting probe,
 * saved credentials, provider startup, or inference is performed by this control. */
export function AxiomMcpControl({
  environmentId,
  input,
  connected,
  idle,
  onRevision,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  input: ProviderSecurityInput | null;
  connected: boolean;
  idle: boolean;
  onRevision: (revision: number) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const locale = useUiLocale();
  const key = JSON.stringify([environmentId, input, connected]);
  const current = useRef(key);
  useLayoutEffect(() => {
    current.current = key;
  }, [key]);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [received, setReceived] = useState<{ key: string; state: ProviderMcpState } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pending = pendingKey === key;
  const [error, setError] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [env, setEnv] = useState("");
  const [enabled, setEnabled] = useState(true);
  const state = received?.key === key ? received.state : null;
  const available = input !== null && connected && idle && !pending;
  const act = async (action: ProviderMcpInput["action"]) => {
    if (!input || !available || (action.kind !== "list" && !state)) return;
    const started = key;
    setPendingKey(key);
    setError(false);
    try {
      const { requireEnvironmentConnection } = await import("../../environments/runtime");
      if (!mounted.current || current.current !== started) return;
      const result = await requireEnvironmentConnection(
        environmentId,
      ).client.server.manageProviderMcp({
        ...input,
        action,
        ...(action.kind !== "list" ? { expectedRevision: state!.revision } : {}),
      });
      if (!mounted.current || current.current !== started) return;
      if (!result.state) {
        setReceived(null);
        setError(true);
        return;
      }
      setReceived({ key: started, state: result.state });
      onRevision(result.state.revision);
    } catch {
      if (mounted.current && current.current === started) {
        setError(true);
        setReceived(null);
      }
    } finally {
      if (mounted.current && current.current === started) {
        setPendingKey(null);
        setEnv("");
      }
    }
  };
  const save = () => {
    try {
      const values: unknown = JSON.parse(args);
      const environment: unknown = env.trim() ? JSON.parse(env) : undefined;
      if (
        !Array.isArray(values) ||
        values.some((value) => typeof value !== "string") ||
        (environment !== undefined &&
          (environment === null ||
            Array.isArray(environment) ||
            typeof environment !== "object" ||
            Object.values(environment).some((value) => typeof value !== "string")))
      ) {
        setError(true);
        return;
      }
      void act({
        kind: "save",
        server: {
          name,
          command,
          args: values,
          enabled,
          ...(environment ? { env: environment as Record<string, string> } : {}),
        },
      });
    } catch {
      setError(true);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        onOpenChange?.(value);
        setEnv("");
        setError(false);
      }}
    >
      <DialogTrigger
        render={<button type="button" className="cafe-composer-tab-action" data-axiom-mcp="true" />}
      >
        <PlugIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span>{uiText("MCP tools", undefined, undefined, locale)}</span>
      </DialogTrigger>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{uiText("Axiom MCP tools", undefined, undefined, locale)}</DialogTitle>
          <DialogDescription>
            {uiText(
              "Servers are saved to this Axiom account. Tool selection applies to this conversation. Changes require idle work.",
              undefined,
              undefined,
              locale,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Button
            variant="outline"
            disabled={!available}
            onClick={() => void act({ kind: "list" })}
          >
            <RefreshCwIcon className="size-3.5" />
            {uiText("Refresh", undefined, undefined, locale)}
          </Button>
          {!input ? (
            <p className="text-sm text-muted-foreground">
              {uiText(
                "Start an Axiom conversation to manage its MCP tools.",
                undefined,
                undefined,
                locale,
              )}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {uiText(
                "MCP action could not complete. Check the input, refresh settings, and wait for active work to finish. A lost response may have applied the change.",
                undefined,
                undefined,
                locale,
              )}
            </p>
          ) : null}
          {state?.servers.map((server) => (
            <div key={server.name} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="mr-auto break-all text-sm">{server.name}</strong>
                <span className="text-xs text-muted-foreground">{server.status}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available}
                  onClick={() => {
                    setName(server.name);
                    setCommand(server.command);
                    setArgs(JSON.stringify(server.args));
                    setEnv("");
                    setEnabled(server.enabled);
                  }}
                >
                  {uiText("Edit", undefined, undefined, locale)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available}
                  onClick={() => void act({ kind: "test", name: server.name })}
                >
                  {uiText("Test", undefined, undefined, locale)}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!available}
                  onClick={() => void act({ kind: "delete", name: server.name })}
                >
                  {uiText("Delete", undefined, undefined, locale)}
                </Button>
              </div>
              {server.environmentKeys.length ? (
                <p className="break-all text-xs text-muted-foreground">
                  {server.environmentKeys.join(", ")}
                </p>
              ) : null}
              {server.error ? (
                <p className="text-xs text-muted-foreground">{server.error}</p>
              ) : null}
              {server.tools.map((tool) => (
                <label key={tool.name} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={state.selectedTools.includes(tool.name)}
                    disabled={!available || !server.enabled}
                    onChange={(event) =>
                      void act({
                        kind: "select",
                        tools: event.target.checked
                          ? [...state.selectedTools, tool.name]
                          : state.selectedTools.filter((value) => value !== tool.name),
                      })
                    }
                  />
                  <span className="min-w-0 break-words">
                    <span>{tool.name}</span>
                    <span className="block text-xs text-muted-foreground">{tool.description}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          <div className="space-y-2 border-t pt-3">
            <label className="block text-sm">
              {uiText("Server name", undefined, undefined, locale)}
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!available || !state}
              />
            </label>
            <label className="block text-sm">
              {uiText("Command", undefined, undefined, locale)}
              <Input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!available || !state}
              />
            </label>
            <label className="block text-sm">
              {uiText("Arguments (JSON array)", undefined, undefined, locale)}
              <Input
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                disabled={!available || !state}
              />
            </label>
            <label className="block text-sm">
              {uiText(
                "Environment (JSON object; blank preserves secrets, an empty object clears them)",
                undefined,
                undefined,
                locale,
              )}
              <Input
                type="password"
                autoComplete="off"
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                disabled={!available || !state}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={!available || !state}
              />
              {uiText("Enabled", undefined, undefined, locale)}
            </label>
            <Button
              disabled={!available || !state || !name.trim() || !command.trim()}
              onClick={save}
            >
              {uiText("Save server", undefined, undefined, locale)}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
