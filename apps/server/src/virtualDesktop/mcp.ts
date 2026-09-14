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
      instructions:
        "Control only this conversation's selected virtual desktop. Observe an unfamiliar desktop before acting. Group known steps in act.actions, use waitFor for bounded local waits, and observeAfter: if_changed at decision points. Avoid separate screenshots between predictable keystrokes. Observe fully after unexpected results. observe({since: observationId}) omits an identical image; force:true always returns pixels. Use explicit region/windowId crops for small dialogs, preserving native pixels; include their observationId in act so coordinates are translated safely. Full screenshots use desktop coordinates at scale 1. A screen change does not prove an app is ready. Prefer an application’s scripting interface for repetitive structured work (for example Blender’s Python console), then visually verify. Use get_display/set_display to inspect or change resolution, then observe again. Prefer list_apps/launch for apps and windows/workspaces/window/layout/workspace/focus for window management. To give two terminals full space, set their parent container to tabbed layout and focus a window. Use sway_query and sway_command for advanced operations. Sway commands have full user authority, including exec and exit. Calls can have completed even if a connection fails: observe before retrying; never blindly repeat. Human input requires explicit viewer takeover. While the human has control, ordinary mutations are blocked. Use take_control deliberately to reclaim ownership when appropriate, then observe again; never automatically reclaim on every action. This desktop uses the user's real files and app profiles.",
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
    "See a lossless screenshot. Optional since compares the prior observationId and omits identical pixels; force always returns an image. region crops desktop pixels; windowId crops a visible window. Cropped actions require observationId and use crop-local coordinates. No target gives full desktop; since alone keeps its prior crop. References expire after five minutes or control/geometry changes. Images are tool content, never paths.",
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
    "Perform a single action or a sequence of up to 24 actions (4096 total UTF-8 text bytes, 45 seconds). kind: move/click/drag/scroll/text/key. Click button: 272 left, 273 right, 274 middle. Scroll amount: signed steps. key: XKB names (Control_L, Shift_L, Return, Escape, Tab, a). text: Unicode, no host clipboard. Prefer actions plus observeAfter: if_changed to combine known steps and a screenshot; always forces an image, none omits it. waitFor waits locally for screen_change or a visible window (windowId/appId), at most 5000ms; timeout does not retry input. Crop-local coordinates require the screenshot observationId. All steps are validated before input. Failure stops the sequence and reports completed and any uncertainStep (1-based); never replay automatically. Human takeover cancels input immediately.",
    actInput,
    false,
  );
  return server;
}
