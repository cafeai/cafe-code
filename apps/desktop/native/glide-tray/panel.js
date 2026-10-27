/* The production DOM adapter for Claude's approved Cafe panel. All app/window
 * strings use text nodes; only the fixed Lucide symbols above are referenced. */
const byId = (id) => document.getElementById(id);
const node = (tag, cls, text) => {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
};
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i s35");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#" + name);
  svg.append(use);
  return svg;
};
const send = (action, owner) =>
  window.webkit.messageHandlers.cafe.postMessage({ action, ...(owner ? { owner } : {}) });
let latest = { state: "unavailable", rows: [] };
let pending = false;
const labels = {
  title: "Computer use",
  about: "About this list",
  settings: "Computer use settings",
  explanation:
    "Screenshots are taken only when a chat asks. Each preview is the last one Cafe actually received, with its time.",
  unavailable: "Status unavailable",
  unconfirmed: "Stop has not been confirmed.",
  off: "Off in every chat",
  empty: "Computer use is off",
  emptyHint: "No screenshots, text reading or input in any chat.",
  noScreenshot: "No screenshot yet",
  ready: "Ready",
  unused: "Ready · not used yet",
  capturing: "Capturing",
  reading: "Reading text",
  acting: "Controlling",
  stopping: "Stopping…",
  stop: "Stop all",
  stopped: "All computer use stopped",
  waiting: "Stop requested · waiting for this Mac",
  stopHint: "Stays off until you turn it on again in a chat.",
  offHint: "Turn it on again from a chat’s composer.",
  stoppingHint: "Blocking new actions, then cancelling active ones.",
  unknownHint: "Not confirmed yet. It will apply when Cafe reconnects.",
  open: "Open chat",
  stopChat: "Stop for this chat",
  nothing: "nothing running",
};
window.renderSnapshot = (snapshot) => {
  latest = snapshot;
  pending = false;
  Object.assign(labels, snapshot.labels ?? {});
  document.documentElement.classList.toggle("dark", snapshot.theme === "dark");
  document.documentElement.lang = snapshot.locale ?? "en";
  if (snapshot.accent) document.documentElement.style.setProperty("--primary", snapshot.accent);
  else document.documentElement.style.removeProperty("--primary");
  byId("cu-title").textContent = labels.title;
  byId("about").setAttribute("aria-label", labels.about);
  byId("settings-button").setAttribute("aria-label", labels.settings);
  byId("tip").textContent = labels.explanation;
  const unknown = snapshot.state === "unavailable";
  const stopping = snapshot.state === "stopping";
  // Only a durable Stop all receipt proves every saved grant is off. No
  // connected rows is idle and must leave the global Stop available.
  const off = snapshot.state === "stopped";
  const empty = off || snapshot.rows.length === 0;
  const owners = new Set(snapshot.rows.map((row) => row.owner)).size;
  const count =
    snapshot.accessSummary ?? (owners === 1 ? "1 active chat" : `${owners} active chats`);
  byId("cu-sum").textContent = unknown
    ? labels.unavailable
    : stopping
      ? labels.stopping
      : off
        ? labels.off
        : count;
  byId("notice").hidden = !unknown;
  byId("notice").textContent = `${labels.unavailable}. ${labels.unconfirmed}`;
  byId("empty").hidden = !empty;
  byId("empty").querySelector(".h").textContent = labels.empty;
  byId("empty").querySelector(".d").textContent = labels.emptyHint;
  const roster = byId("roster");
  roster.hidden = empty;
  const focused = document.activeElement;
  const focusedAction = focused?.dataset?.action;
  const focusedOwner = focused?.dataset?.owner;
  const rows = snapshot.rows.map((row) => {
    const item = node("div", "item");
    item.dataset.window = row.owner + ":" + row.appName + ":" + row.windowTitle;
    const shot = node("div", "shot" + (unknown ? " stale" : ""));
    if (
      row.preview &&
      /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(row.preview) &&
      row.preview.length <= 98304
    ) {
      item.dataset.preview = "true";
      const img = node("img", "mini");
      img.src = row.preview;
      img.alt = row.appName + " — " + row.windowTitle;
      const time = node("time", "when tnum");
      time.dateTime = row.capturedAt;
      time.title = new Date(row.capturedAt).toLocaleString();
      time.append(
        icon("camera"),
        document.createTextNode(
          new Date(row.capturedAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          }),
        ),
      );
      shot.append(img, time);
    } else {
      item.dataset.preview = "false";
      shot.title = labels.noScreenshot;
      shot.setAttribute("aria-label", labels.noScreenshot);
      shot.append(icon("panel"));
    }
    const body = node("div", "body");
    const windowName = node("div", "wname");
    windowName.append(
      node("span", "t", row.windowTitle ? row.appName + " — " + row.windowTitle : row.chat),
    );
    windowName.title = row.windowTitle ? row.appName + " — " + row.windowTitle : row.chat;
    body.append(windowName);
    const chatline = node("div", "chatline", row.windowTitle ? row.chat : labels.ready);
    chatline.title = row.provider;
    const state = node(
      "span",
      "state",
      unknown
        ? labels.unavailable
        : stopping || row.state === "stopping"
          ? labels.stopping
          : row.state === "capturing"
            ? labels.capturing
            : row.state === "reading"
              ? labels.reading
              : row.state === "acting"
                ? labels.acting
                : row.preview
                  ? labels.ready
                  : labels.unused,
    );
    state.dataset.s = unknown
      ? "unknown"
      : stopping
        ? "stopping"
        : row.state === "reading"
          ? "text"
          : row.state;
    state.hidden = !unknown && !stopping && row.state === "ready";
    if (row.state === "capturing") state.prepend(node("span", "pd pulse"));
    if (row.state === "reading") state.prepend(icon("scantext"));
    body.append(chatline, state);
    const actions = node("div", "acts");
    for (const [action, symbol, label] of [
      ["open-chat", "external", labels.open],
      ["stop-chat", "square", labels.stopChat],
    ]) {
      const button = node("button", "iconbtn" + (action === "stop-chat" ? " danger" : ""));
      button.type = "button";
      button.title = label;
      button.setAttribute("aria-label", label + " · " + row.chat);
      button.dataset.action = action;
      button.dataset.owner = row.owner;
      button.disabled = stopping || row.state === "stopping";
      button.append(icon(symbol));
      button.addEventListener("click", () => {
        button.disabled = true;
        send(action, row.owner);
      });
      actions.append(button);
    }
    item.append(shot, body, actions);
    return item;
  });
  const scroll = roster.scrollTop;
  roster.replaceChildren(...rows);
  roster.scrollTop = scroll;
  if (focusedAction && focusedOwner) {
    [...roster.querySelectorAll("button")]
      .find(
        (button) =>
          button.dataset.action === focusedAction && button.dataset.owner === focusedOwner,
      )
      ?.focus({ preventScroll: true });
  }
  const stop = byId("stop-all");
  stop.disabled = off || stopping;
  stop.classList.toggle("quiet", off);
  stop.querySelector(".sq").hidden = off || stopping;
  byId("stop-all-label").textContent = off
    ? labels.stopped
    : stopping
      ? labels.stopping
      : labels.stop;
  return Math.ceil(byId("cu").getBoundingClientRect().height);
};
byId("stop-all").addEventListener("click", () => {
  if (pending) return;
  pending = true;
  byId("stop-all").disabled = true;
  byId("stop-all-label").textContent =
    latest.state === "unavailable" ? labels.waiting : labels.stopping;
  send("stop-all");
});
byId("about").addEventListener("click", () => {
  byId("tip").hidden = !byId("tip").hidden;
});
byId("settings-button").addEventListener("click", () => send("settings"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") send("close");
});
window.webkit.messageHandlers.cafe.postMessage({ action: "ready" });
