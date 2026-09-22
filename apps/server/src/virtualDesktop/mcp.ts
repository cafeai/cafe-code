import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  VirtualDesktopError,
  DESKTOP_MIN_DIMENSION,
  DESKTOP_MAX_DIMENSION,
} from "@cafecode/contracts";
import { actInput, observeInput } from "./interactionSchema.ts";
import { desktopToolResult } from "./toolResult.ts";
import {
  focusInput,
  windowInput,
  layoutInput,
  workspaceInput,
  swayCommandInput,
  swayQueryInput,
} from "./swayTools.ts";

export function makeDesktopMcpServer(
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  const server = new McpServer(
    { name: "cafe-desktop", version: "1.0.0" },
    {
      // Pixel deduplication alone still emits console screenshots after every
      // typed command. Teach observation admission at the decision boundary;
      // explicit image requests and the existing ownership guards stay intact.
      instructions: [
        "Control only this conversation's selected virtual desktop. Observe an unfamiliar desktop before acting. Group known steps in act.actions. Use observeAfter: none (the default) for intermediate typing, shortcuts and script chunks. Use if_changed when the next decision needs pixels or to visually verify a completed operation; even console text or cursor changes can produce an image. Inspect an image already returned by act before requesting another observation. Observe fully after unexpected results or uncertain input.",
        "Prefer an application's scripting interface for repetitive structured work, such as Blender's Python console. Check errors/results through text output where available and visually verify at meaningful checkpoints, rather than after each script chunk. If you already viewed the output render, request a desktop screenshot only when its UI state matters. Use waitFor for bounded local waits; a screen change does not prove an app is ready.",
        "For repeat visual checks, use observe({since: latestObservationId}) to omit identical pixels. Use a region/windowId crop when only a dialog or part of the app matters, preserving native pixels; include the latest observationId in act and use crop-local coordinates. since alone keeps the prior crop. Observe the full desktop after a new turn, expired reference, control/geometry change or when you need to reorient. force:true always returns pixels. Full screenshots use desktop coordinates at scale 1.",
        "Use get_display/set_display to inspect or change resolution, then observe again. Prefer list_apps/launch for apps and windows/workspaces/window/layout/workspace/focus for window management. To give two terminals full space, set their parent container to tabbed layout and focus a window. Use sway_query and sway_command for advanced operations. Sway commands have full user authority, including exec and exit. Calls can have completed even if a connection fails: observe before retrying; never blindly repeat. Human input requires explicit viewer takeover. While the human has control, ordinary mutations are blocked. Use take_control deliberately to reclaim ownership when appropriate, then observe again; never automatically reclaim on every action. This desktop uses the user's real files and app profiles.",
      ].join(" "),
    },
  );
  const register = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    readOnlyHint: boolean,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint,
          destructiveHint: !readOnlyHint,
          idempotentHint: readOnlyHint,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        try {
          const result = await call(name, args, extra.signal);
          const output = desktopToolResult(result);
          return {
            ...(output.observation
              ? { structuredContent: { desktopObservation: output.observation } }
              : {}),
            ...(output.isError ? { isError: true } : {}),
            content: [
              { type: "text" as const, text: output.text },
              ...(output.image
                ? [{ type: "image" as const, mimeType: "image/png", data: output.image }]
                : []),
            ],
          };
        } catch (error) {
          // Errors across provider/HTTP boundaries may carry arguments or paths.
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof VirtualDesktopError
                    ? JSON.stringify({
                        code: error.code,
                        message: error.message,
                        observeBeforeRetry: true,
                      })
                    : "Desktop operation unavailable. It may have completed; observe before retrying. Check that Desktop Control is enabled, the conversation has an active turn, and you have explicitly reclaimed control with take_control if needed.",
              },
            ],
          };
        }
      },
    );
  };
  register(
    "take_control",
    "Explicitly reclaim this conversation's desktop from the human viewer. Cancels held human input and makes the viewer read-only until the human presses Take control again. This changes ownership; do not call automatically on every action or repeatedly fight the user. Observe after taking control before performing any mutation.",
    {},
    false,
  );
  register(
    "observe",
    "Inspect pixels when the next decision needs them. Reuse an image already returned by act; avoid an immediate extra screenshot. For repeat checks pass since: latestObservationId to omit identical pixels. Prefer region for a small area or windowId for a visible window; crops preserve native pixels. Cropped actions require the latest observationId and crop-local coordinates. since alone keeps its prior crop. Empty arguments recover the full desktop; force always returns pixels. References expire after five minutes or turn/control/geometry changes. Images are tool content, never paths.",
    observeInput,
    true,
  );
  register(
    "get_display",
    "Read this desktop's current width and height in pixels and whether it supports display changes.",
    {},
    true,
  );
  register(
    "set_display",
    "Change this session's desktop resolution at scale 1. Does not change defaults for new desktops. Requires model control and a prior observation; human control blocks this call. Observe again after resizing before sending more input. A lost reply is uncertain: get_display and observe before retrying.",
    {
      width: z.number().int().min(DESKTOP_MIN_DIMENSION).max(DESKTOP_MAX_DIMENSION),
      height: z.number().int().min(DESKTOP_MIN_DIMENSION).max(DESKTOP_MAX_DIMENSION),
    },
    false,
  );
  register(
    "list_apps",
    "List installed application IDs and names. Use query to filter names/IDs before listing the full catalog.",
    { query: z.string().max(160).optional() },
    true,
  );
  register(
    "windows",
    "Inspect compact windows with IDs, parentId, workspace, visibility and geometry. detail=true also includes containers, layouts, floating/fullscreen and scratchpad details. Includes hidden windows; truncated=true means incomplete. Use parentId for sibling layout changes.",
    { detail: z.boolean().optional() },
    true,
  );
  register(
    "focus",
    "Focus a windowId (including on another workspace), or move focus in a direction: left/right/up/down/next/prev/parent/child/tiling/floating. Supply exactly one field. Observe first.",
    focusInput,
    false,
  );
  register(
    "window",
    "Manage one windowId. action.type: fullscreen/floating/sticky (enabled), resize (width/height in pixels), move (direction), position (x/y, floating only), center (floating only), swap (otherWindowId), close, hide (scratchpad), restore (hidden scratchpad only). Observe after changes; close asks the app to close and may show an unsaved-work dialog.",
    windowInput,
    false,
  );
  register(
    "layout",
    "Set an explicit containerId's layout with action={type:'set',layout:'tabbed'|'stacking'|'splith'|'splitv'|'default'}, or choose the next split with action={type:'split',direction:'horizontal'|'vertical'|'none'}. For tabs across siblings, target their parentId, not a leaf window.",
    layoutInput,
    false,
  );
  register(
    "workspaces",
    "List Sway workspaces with IDs, names, focus, visibility, urgency, output and geometry. Empty inactive workspaces disappear automatically.",
    {},
    true,
  );
  register(
    "workspace",
    "Switch/create a named workspace, navigate next/prev/back_and_forth, rename an existing workspace, or move a windowId to one. action.type selects switch (name), navigate (direction), rename (name/newName), or move (windowId/name). Moving does not switch focus to the destination. Names use letters, numbers, spaces, _ . : + or -; advanced syntax uses sway_command.",
    workspaceInput,
    false,
  );
  register(
    "sway_query",
    "Read bounded Sway IPC state: tree/workspaces/outputs/marks/inputs/seats/version/binding_modes/binding_state. Optional containerId selects a tree subtree. Maximum result 64 KiB; request a subtree if too large. The socket always belongs to the selected Cafe desktop.",
    swayQueryInput,
    true,
  );
  register(
    "sway_command",
    "Execute unrestricted Sway command syntax in this private desktop, e.g. [con_id=6] fullscreen enable. Full user authority: exec executes a shell command; exit ends this desktop and its apps. Prefer structured tools and launch for common tasks. Observe first. Returns actual per-command results and partial failure; earlier commands may succeed even if later ones fail. No automatic retry, rollback, socket override or extra approval. A lost/oversized response is an uncertain outcome: observe before proceeding. Maximum 8192 UTF-8 bytes.",
    swayCommandInput,
    false,
  );
  register(
    "launch",
    "Launch an installed appId, or a command plus structured arguments. terminal=true runs the command in the user's terminal. Uses real profiles; an existing host instance can intercept a launch. outcome distinguishes a new window, terminal wrapper only, exited launcher (exitCode/signal), still running without a window, or unverified. A launcher can fork; its exit is not proof the app failed. Inspect before retrying.",
    {
      appId: z.string().min(1).max(256).optional(),
      command: z.string().min(1).max(4096).optional(),
      args: z.array(z.string().max(8192)).max(64).optional(),
      terminal: z.boolean().optional(),
    },
    false,
  );
  register(
    "act",
    "Perform a single action or batch up to 24 known steps (4096 total UTF-8 text bytes, 45 seconds). kind: move/click/drag/scroll/text/key. Click button: 272 left, 273 right, 274 middle. Scroll amount: signed steps. key: XKB names (Control_L, Shift_L, Return, Escape, Tab, a). text: Unicode, no host clipboard. observeAfter defaults to none: use it for intermediate typing, shortcuts and script chunks. Choose if_changed only at a visual decision or verification checkpoint; typing alone changes pixels. always forces an image. Inspect any returned image before another observe call. Stop batching when the next step depends on unseen UI state. waitFor waits locally for screen_change or a visible window (windowId/appId), at most 5000ms; screen changes are not readiness proof, and timeout does not retry input. Crop-local coordinates require the latest screenshot observationId. All steps are validated before input. Failure stops the sequence and reports completed and any uncertainStep (1-based); never replay automatically. Human takeover cancels input immediately.",
    actInput,
    false,
  );
  return server;
}
