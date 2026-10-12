import { uiLabelList } from "@cafecode/shared/i18n";
import { uiText } from "@cafecode/shared/i18n";
import type { OrchestrationThreadActivity } from "@cafecode/contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ACTIONS: Record<string, readonly [string, string, string, string, string]> = {
  computer_select: uiLabelList([
    "Selecting an app",
    "Selected an app",
    () => uiText("Selecting an app…"),
    () => uiText("Selected an app"),
    () => uiText("Selecting an app failed"),
  ] as const),
  computer_observe: uiLabelList([
    "Reading the app",
    "Read the app",
    () => uiText("Reading the app…"),
    () => uiText("Read the app"),
    () => uiText("Reading the app failed"),
  ] as const),
  computer_act: uiLabelList([
    "Using the app",
    "Used the app",
    () => uiText("Using the app…"),
    () => uiText("Used the app"),
    () => uiText("Using the app failed"),
  ] as const),
  computer_advanced: uiLabelList([
    "Using a computer control",
    "Used a computer control",
    () => uiText("Using a computer control…"),
    () => uiText("Used a computer control"),
    () => uiText("Using a computer control failed"),
  ] as const),
  health: uiLabelList([
    "Checking computer access",
    "Checked computer access",
    () => uiText("Checking computer access…"),
    () => uiText("Checked computer access"),
    () => uiText("Checking computer access failed"),
  ] as const),
  click: uiLabelList([
    "Clicking",
    "Clicked",
    () => uiText("Clicking…"),
    () => uiText("Clicked"),
    () => uiText("Clicking failed"),
  ] as const),
  double_click: uiLabelList([
    "Double-clicking",
    "Double-clicked",
    () => uiText("Double-clicking…"),
    () => uiText("Double-clicked"),
    () => uiText("Double-clicking failed"),
  ] as const),
  right_click: uiLabelList([
    "Right-clicking",
    "Right-clicked",
    () => uiText("Right-clicking…"),
    () => uiText("Right-clicked"),
    () => uiText("Right-clicking failed"),
  ] as const),
  get_window_state: uiLabelList([
    "Reading the window",
    "Read the window",
    () => uiText("Reading the window…"),
    () => uiText("Read the window"),
    () => uiText("Reading the window failed"),
  ] as const),
  get_desktop_state: uiLabelList([
    "Looking at the desktop",
    "Viewed the desktop",
    () => uiText("Looking at the desktop…"),
    () => uiText("Viewed the desktop"),
    () => uiText("Looking at the desktop failed"),
  ] as const),
  get_accessibility_tree: uiLabelList([
    "Reading window controls",
    "Read window controls",
    () => uiText("Reading window controls…"),
    () => uiText("Read window controls"),
    () => uiText("Reading window controls failed"),
  ] as const),
  bring_to_front: uiLabelList([
    "Bringing the window forward",
    "Brought the window forward",
    () => uiText("Bringing the window forward…"),
    () => uiText("Brought the window forward"),
    () => uiText("Bringing the window forward failed"),
  ] as const),
  release_control: uiLabelList([
    "Releasing computer control",
    "Released computer control",
    () => uiText("Releasing computer control…"),
    () => uiText("Released computer control"),
    () => uiText("Releasing computer control failed"),
  ] as const),
  type_text: uiLabelList([
    "Typing text",
    "Typed text",
    () => uiText("Typing text…"),
    () => uiText("Typed text"),
    () => uiText("Typing text failed"),
  ] as const),
  set_value: uiLabelList([
    "Updating a field",
    "Updated a field",
    () => uiText("Updating a field…"),
    () => uiText("Updated a field"),
    () => uiText("Updating a field failed"),
  ] as const),
  press_key: uiLabelList([
    "Pressing a key",
    "Pressed a key",
    () => uiText("Pressing a key…"),
    () => uiText("Pressed a key"),
    () => uiText("Pressing a key failed"),
  ] as const),
  hotkey: uiLabelList([
    "Using a keyboard shortcut",
    "Used a keyboard shortcut",
    () => uiText("Using a keyboard shortcut…"),
    () => uiText("Used a keyboard shortcut"),
    () => uiText("Using a keyboard shortcut failed"),
  ] as const),
  scroll: uiLabelList([
    "Scrolling",
    "Scrolled",
    () => uiText("Scrolling…"),
    () => uiText("Scrolled"),
    () => uiText("Scrolling failed"),
  ] as const),
  drag: uiLabelList([
    "Dragging",
    "Dragged",
    () => uiText("Dragging…"),
    () => uiText("Dragged"),
    () => uiText("Dragging failed"),
  ] as const),
  move_cursor: uiLabelList([
    "Moving the cursor",
    "Moved the cursor",
    () => uiText("Moving the cursor…"),
    () => uiText("Moved the cursor"),
    () => uiText("Moving the cursor failed"),
  ] as const),
  get_cursor_position: uiLabelList([
    "Checking cursor position",
    "Checked cursor position",
    () => uiText("Checking cursor position…"),
    () => uiText("Checked cursor position"),
    () => uiText("Checking cursor position failed"),
  ] as const),
  list_apps: uiLabelList([
    "Finding open apps",
    "Found open apps",
    () => uiText("Finding open apps…"),
    () => uiText("Found open apps"),
    () => uiText("Finding open apps failed"),
  ] as const),
  list_windows: uiLabelList([
    "Finding open windows",
    "Found open windows",
    () => uiText("Finding open windows…"),
    () => uiText("Found open windows"),
    () => uiText("Finding open windows failed"),
  ] as const),
  launch_app: uiLabelList([
    "Opening an app",
    "Opened an app",
    () => uiText("Opening an app…"),
    () => uiText("Opened an app"),
    () => uiText("Opening an app failed"),
  ] as const),
  kill_app: uiLabelList([
    "Closing an app",
    "Closed an app",
    () => uiText("Closing an app…"),
    () => uiText("Closed an app"),
    () => uiText("Closing an app failed"),
  ] as const),
  open_url: uiLabelList([
    "Opening a web page",
    "Opened a web page",
    () => uiText("Opening a web page…"),
    () => uiText("Opened a web page"),
    () => uiText("Opening a web page failed"),
  ] as const),
  get_browser_state: uiLabelList([
    "Reading the web page",
    "Read the web page",
    () => uiText("Reading the web page…"),
    () => uiText("Read the web page"),
    () => uiText("Reading the web page failed"),
  ] as const),
  browser_prepare: uiLabelList([
    "Checking browser access",
    "Checked browser access",
    () => uiText("Checking browser access…"),
    () => uiText("Checked browser access"),
    () => uiText("Checking browser access failed"),
  ] as const),
  browser_click: uiLabelList([
    "Clicking on the web page",
    "Clicked on the web page",
    () => uiText("Clicking on the web page…"),
    () => uiText("Clicked on the web page"),
    () => uiText("Clicking on the web page failed"),
  ] as const),
  browser_type: uiLabelList([
    "Typing into the web page",
    "Typed into the web page",
    () => uiText("Typing into the web page…"),
    () => uiText("Typed into the web page"),
    () => uiText("Typing into the web page failed"),
  ] as const),
  browser_navigate: uiLabelList([
    "Navigating the browser",
    "Navigated the browser",
    () => uiText("Navigating the browser…"),
    () => uiText("Navigated the browser"),
    () => uiText("Navigating the browser failed"),
  ] as const),
  browser_pointer: uiLabelList([
    "Moving the browser cursor",
    "Moved the browser cursor",
    () => uiText("Moving the browser cursor…"),
    () => uiText("Moved the browser cursor"),
    () => uiText("Moving the browser cursor failed"),
  ] as const),
  browser_dialog: uiLabelList([
    "Handling a browser dialog",
    "Handled a browser dialog",
    () => uiText("Handling a browser dialog…"),
    () => uiText("Handled a browser dialog"),
    () => uiText("Handling a browser dialog failed"),
  ] as const),
  browser_set_input_files: uiLabelList([
    "Attaching files to the page",
    "Attached files to the page",
    () => uiText("Attaching files to the page…"),
    () => uiText("Attached files to the page"),
    () => uiText("Attaching files to the page failed"),
  ] as const),
  clipboard_read: uiLabelList([
    "Reading the clipboard",
    "Read the clipboard",
    () => uiText("Reading the clipboard…"),
    () => uiText("Read the clipboard"),
    () => uiText("Reading the clipboard failed"),
  ] as const),
  clipboard_write: uiLabelList([
    "Updating the clipboard",
    "Updated the clipboard",
    () => uiText("Updating the clipboard…"),
    () => uiText("Updated the clipboard"),
    () => uiText("Updating the clipboard failed"),
  ] as const),
  invoke_menu: uiLabelList([
    "Choosing a menu action",
    "Chose a menu action",
    () => uiText("Choosing a menu action…"),
    () => uiText("Chose a menu action"),
    () => uiText("Choosing a menu action failed"),
  ] as const),
  set_window_frame: uiLabelList([
    "Moving or resizing the window",
    "Moved or resized the window",
    () => uiText("Moving or resizing the window…"),
    () => uiText("Moved or resized the window"),
    () => uiText("Moving or resizing the window failed"),
  ] as const),
  get_screen_size: uiLabelList([
    "Checking screen size",
    "Checked screen size",
    () => uiText("Checking screen size…"),
    () => uiText("Checked screen size"),
    () => uiText("Checking screen size failed"),
  ] as const),
  verify_state: uiLabelList([
    "Checking the result",
    "Checked the result",
    () => uiText("Checking the result…"),
    () => uiText("Checked the result"),
    () => uiText("Checking the result failed"),
  ] as const),
  health_report: uiLabelList([
    "Checking computer access",
    "Checked computer access",
    () => uiText("Checking computer access…"),
    () => uiText("Checked computer access"),
    () => uiText("Checking computer access failed"),
  ] as const),
  page: uiLabelList([
    "Reading more of the page",
    "Read more of the page",
    () => uiText("Reading more of the page…"),
    () => uiText("Read more of the page"),
    () => uiText("Reading more of the page failed"),
  ] as const),
  zoom: uiLabelList([
    "Changing zoom",
    "Changed zoom",
    () => uiText("Changing zoom…"),
    () => uiText("Changed zoom"),
    () => uiText("Changing zoom failed"),
  ] as const),
  get_agent_cursor_state: uiLabelList([
    "Checking the computer-use cursor",
    "Checked the computer-use cursor",
    () => uiText("Checking the computer-use cursor…"),
    () => uiText("Checked the computer-use cursor"),
    () => uiText("Checking the computer-use cursor failed"),
  ] as const),
  set_agent_cursor_enabled: uiLabelList([
    "Updating the computer-use cursor",
    "Updated the computer-use cursor",
    () => uiText("Updating the computer-use cursor…"),
    () => uiText("Updated the computer-use cursor"),
    () => uiText("Updating the computer-use cursor failed"),
  ] as const),
  set_agent_cursor_motion: uiLabelList([
    "Updating cursor motion",
    "Updated cursor motion",
    () => uiText("Updating cursor motion…"),
    () => uiText("Updated cursor motion"),
    () => uiText("Updating cursor motion failed"),
  ] as const),
  set_agent_cursor_theme: uiLabelList([
    "Updating cursor appearance",
    "Updated cursor appearance",
    () => uiText("Updating cursor appearance…"),
    () => uiText("Updated cursor appearance"),
    () => uiText("Updating cursor appearance failed"),
  ] as const),
};

/** Recognize only Cafe's own bridge spellings. User text never becomes tool authority.
 * No typed text, clipboard content, URLs, arguments or private bridge ids are displayed. */
export function readComputerUsePresentation(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload" | "summary" | "tone">,
) {
  if (!activity.kind.startsWith("tool.")) return null;
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  const rawInput = record(data?.rawInput);
  let tool: string | undefined;
  const server = item?.server ?? item?.namespace;
  if (
    typeof server === "string" &&
    /^cafe-native-[A-Za-z0-9_-]+$/u.test(server) &&
    typeof item?.tool === "string"
  )
    tool = item.tool;
  for (const value of [
    payload?.detail,
    payload?.title,
    activity.summary,
    rawInput?.tool_name,
    rawInput?.name,
  ]) {
    if (tool || typeof value !== "string") continue;
    tool =
      /^(?:mcp__cafe-native-[A-Za-z0-9_-]+__|cafe-native-[A-Za-z0-9_-]+\.)([a-z_]+)(?=[:\s]|$)/u.exec(
        value,
      )?.[1];
  }
  if (!tool) return null;
  const [active, completed, displayActive, displayCompleted, displayFailed] = ACTIONS[tool] ?? [
    "Using the computer",
    "Used the computer",
    uiText("Using the computer…"),
    uiText("Used the computer"),
    uiText("Using the computer failed"),
  ];
  const failed = activity.tone === "error" || ["failed", "error"].includes(String(payload?.status));
  return {
    active: displayActive,
    displayLabel: failed
      ? displayFailed
      : activity.kind.endsWith(".completed")
        ? displayCompleted
        : displayActive,
    label: failed
      ? `${active} failed`
      : activity.kind.endsWith(".completed")
        ? completed
        : `${active}…`,
  };
}
