import type { OrchestrationThreadActivity } from "@cafecode/contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ACTIONS: Record<string, readonly [string, string]> = {
  computer_select: ["Selecting an app", "Selected an app"],
  computer_observe: ["Reading the app", "Read the app"],
  computer_act: ["Using the app", "Used the app"],
  computer_advanced: ["Using a computer control", "Used a computer control"],
  health: ["Checking computer access", "Checked computer access"],
  click: ["Clicking", "Clicked"],
  double_click: ["Double-clicking", "Double-clicked"],
  right_click: ["Right-clicking", "Right-clicked"],
  get_window_state: ["Reading the window", "Read the window"],
  get_desktop_state: ["Looking at the desktop", "Viewed the desktop"],
  get_accessibility_tree: ["Reading window controls", "Read window controls"],
  bring_to_front: ["Bringing the window forward", "Brought the window forward"],
  release_control: ["Releasing computer control", "Released computer control"],
  type_text: ["Typing text", "Typed text"],
  set_value: ["Updating a field", "Updated a field"],
  press_key: ["Pressing a key", "Pressed a key"],
  hotkey: ["Using a keyboard shortcut", "Used a keyboard shortcut"],
  scroll: ["Scrolling", "Scrolled"],
  drag: ["Dragging", "Dragged"],
  move_cursor: ["Moving the cursor", "Moved the cursor"],
  get_cursor_position: ["Checking cursor position", "Checked cursor position"],
  list_apps: ["Finding open apps", "Found open apps"],
  list_windows: ["Finding open windows", "Found open windows"],
  launch_app: ["Opening an app", "Opened an app"],
  kill_app: ["Closing an app", "Closed an app"],
  open_url: ["Opening a web page", "Opened a web page"],
  get_browser_state: ["Reading the web page", "Read the web page"],
  browser_prepare: ["Checking browser access", "Checked browser access"],
  browser_click: ["Clicking on the web page", "Clicked on the web page"],
  browser_type: ["Typing into the web page", "Typed into the web page"],
  browser_navigate: ["Navigating the browser", "Navigated the browser"],
  browser_pointer: ["Moving the browser cursor", "Moved the browser cursor"],
  browser_dialog: ["Handling a browser dialog", "Handled a browser dialog"],
  browser_set_input_files: ["Attaching files to the page", "Attached files to the page"],
  clipboard_read: ["Reading the clipboard", "Read the clipboard"],
  clipboard_write: ["Updating the clipboard", "Updated the clipboard"],
  invoke_menu: ["Choosing a menu action", "Chose a menu action"],
  set_window_frame: ["Moving or resizing the window", "Moved or resized the window"],
  get_screen_size: ["Checking screen size", "Checked screen size"],
  verify_state: ["Checking the result", "Checked the result"],
  health_report: ["Checking computer access", "Checked computer access"],
  page: ["Reading more of the page", "Read more of the page"],
  zoom: ["Changing zoom", "Changed zoom"],
  get_agent_cursor_state: ["Checking the computer-use cursor", "Checked the computer-use cursor"],
  set_agent_cursor_enabled: ["Updating the computer-use cursor", "Updated the computer-use cursor"],
  set_agent_cursor_motion: ["Updating cursor motion", "Updated cursor motion"],
  set_agent_cursor_theme: ["Updating cursor appearance", "Updated cursor appearance"],
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
  const [active, completed] = ACTIONS[tool] ?? ["Using the computer", "Used the computer"];
  const failed = activity.tone === "error" || ["failed", "error"].includes(String(payload?.status));
  return {
    active: `${active}…`,
    label: failed
      ? `${active} failed`
      : activity.kind.endsWith(".completed")
        ? completed
        : `${active}…`,
  };
}
