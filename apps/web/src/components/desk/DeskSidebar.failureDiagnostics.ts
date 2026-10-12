/**
 * Test-only diagnostics for the isolated synthetic Desk fixture. This module is
 * deliberately not imported by production: no titles, DOM serialization, CSS
 * text, URLs, storage, errors or application state enter the failure record.
 */
const MAX_CSS_RULES = 4_096;
const MAX_CSS_DEPTH = 8;
const MAX_STYLESHEETS = 16;
export const MAX_DESK_FAILURE_DIAGNOSTIC_LENGTH = 8_192;
const IDENTITY_TAGS = new Set([
  "button",
  "div",
  "span",
  "svg",
  "path",
  "input",
  "li",
  "body",
  "html",
  "iframe",
]);

const STYLE_TOKENS = {
  rowHover: "group-hover\\/desk-row",
  groupHover: "group-hover\\/desk-group",
  rowFocus: "group-has-focus-visible\\/desk-row",
  groupFocus: "group-has-focus-visible\\/desk-group",
} as const;

interface DiagnosticCssRule {
  readonly type: number;
  readonly selectorText?: string;
  readonly cssRules?: ArrayLike<DiagnosticCssRule>;
}

/** Only fixed rule-family counts escape the bounded walk, never rule contents. */
export function countDeskDiagnosticCssRules(sheets: ArrayLike<ArrayLike<DiagnosticCssRule>>) {
  const counts = { rowHover: 0, groupHover: 0, rowFocus: 0, groupFocus: 0 };
  let visited = 0;
  let truncated = sheets.length > MAX_STYLESHEETS;
  const walk = (rules: ArrayLike<DiagnosticCssRule>, depth: number) => {
    for (let index = 0; index < rules.length; index++) {
      if (visited === MAX_CSS_RULES) {
        truncated = true;
        return;
      }
      visited++;
      const rule = rules[index];
      if (!rule) continue;
      if (typeof rule.selectorText === "string") {
        // The stylesheet is compiler-owned, but still bound examined text so a
        // malformed synthetic fixture cannot expand diagnostic work/output.
        const selector = rule.selectorText.slice(0, 2_048);
        for (const key of Object.keys(STYLE_TOKENS) as Array<keyof typeof STYLE_TOKENS>) {
          if (selector.indexOf(STYLE_TOKENS[key]) !== -1) counts[key]++;
        }
      }
      if (rule.cssRules?.length) {
        if (depth === MAX_CSS_DEPTH) truncated = true;
        else walk(rule.cssRules, depth + 1);
      }
    }
  };
  for (let index = 0; index < Math.min(sheets.length, MAX_STYLESHEETS); index++) {
    const rules = sheets[index];
    if (rules) walk(rules, 0);
  }
  return { visited, truncated, ...counts };
}

function boundedNumber(value: number): number | null {
  return Number.isFinite(value)
    ? Math.round(Math.max(-1_000_000, Math.min(1_000_000, value)) * 1_000) / 1_000
    : null;
}

function rectangle(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    x: boundedNumber(rect.x),
    y: boundedNumber(rect.y),
    width: boundedNumber(rect.width),
    height: boundedNumber(rect.height),
  };
}

/** Passive observation only: never focus, move input, prevent or replay events. */
export function trackDeskDiagnosticPointer(document: Document) {
  let count = 0;
  let last: { x: number | null; y: number | null; trusted: boolean } | null = null;
  const observe = (event: PointerEvent) => {
    count = Math.min(count + 1, 1_000_000);
    last = {
      x: boundedNumber(event.clientX),
      y: boundedNumber(event.clientY),
      trusted: event.isTrusted,
    };
  };
  document.addEventListener("pointermove", observe, { capture: true, passive: true });
  return {
    read: () => ({ count, last }),
    stop: () => document.removeEventListener("pointermove", observe, true),
  };
}

type PointerObservation = ReturnType<ReturnType<typeof trackDeskDiagnosticPointer>["read"]>;

export function collectDeskSidebarFailureDiagnostics(
  document: Document,
  pointer: PointerObservation,
) {
  const view = document.defaultView;
  if (!view) return { version: 1, available: false } as const;
  const group = document.querySelector("[data-desk-group-heading]");
  const row = document.querySelector("[data-desk-chat-row]");
  const targets = {
    group,
    heading: group?.querySelector("button[aria-pressed]") ?? null,
    pencil: group?.querySelector("button[data-base-ui-tooltip-trigger]") ?? null,
    count: group?.querySelector("[data-desk-group-count]") ?? null,
    row,
    title: row?.querySelector("[data-sidebar=menu-sub-button]") ?? null,
    actions: row?.querySelector("[data-desk-row-actions]") ?? null,
    meta: row?.querySelector("[data-desk-row-meta]") ?? null,
  };
  const identity = (element: Element | null) => {
    if (!element) return "absent";
    for (const [name, target] of Object.entries(targets)) {
      if (target === element) return name;
    }
    // Fixed tag categories describe hit targets without copying any arbitrary
    // label, class, identifier, text or attribute from the document.
    const tag = element.tagName.toLowerCase();
    return IDENTITY_TAGS.has(tag) ? tag : "other";
  };
  const state = Object.fromEntries(
    Object.entries(targets).map(([name, element]) => {
      if (!element) return [name, null];
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return [
        name,
        {
          bounds: rectangle(element),
          opacity: boundedNumber(Number.parseFloat(style.opacity)),
          pointerEvents:
            style.pointerEvents === "none" || style.pointerEvents === "auto"
              ? style.pointerEvents
              : "other",
          // Pseudo-state queries are supplemental: native Chromium probes have
          // reported false here while computed hover styles were applied.
          hovered: element.matches(":hover"),
          focusVisible: element.matches(":focus-visible"),
          centerHit: identity(
            document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
          ),
        },
      ];
    }),
  );
  const sheets: Array<CSSRuleList> = [];
  let inaccessibleSheets = 0;
  for (let index = 0; index < Math.min(document.styleSheets.length, MAX_STYLESHEETS); index++) {
    try {
      const sheet = document.styleSheets[index];
      if (sheet) sheets.push(sheet.cssRules);
    } catch {
      inaccessibleSheets++;
    }
  }
  let outer: {
    focused: boolean;
    visible: boolean;
    frameBounds: ReturnType<typeof rectangle>;
    frameScaleX: number | null;
    frameScaleY: number | null;
    centerHit: string;
    pointerHit: string;
  } | null = null;
  try {
    const frame = view.frameElement;
    if (frame && view.parent !== view) {
      const parent = frame.ownerDocument;
      const rect = frame.getBoundingClientRect();
      const transform = new view.DOMMatrixReadOnly(view.parent.getComputedStyle(frame).transform);
      outer = {
        focused: parent.hasFocus(),
        visible: parent.visibilityState === "visible",
        frameBounds: rectangle(frame),
        frameScaleX: boundedNumber(transform.a),
        frameScaleY: boundedNumber(transform.d),
        centerHit:
          parent.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === frame
            ? "fixture-iframe"
            : "other",
        pointerHit:
          pointer.last && pointer.last.x !== null && pointer.last.y !== null
            ? parent.elementFromPoint(
                rect.x + pointer.last.x * transform.a,
                rect.y + pointer.last.y * transform.d,
              ) === frame
              ? "fixture-iframe"
              : "other"
            : "absent",
      };
    }
  } catch {
    // Cross-origin/removed iframe observation is unavailable, not a raw error.
  }
  return {
    version: 1,
    available: true,
    media: {
      hover: view.matchMedia("(hover: hover)").matches,
      fine: view.matchMedia("(pointer: fine)").matches,
      coarse: view.matchMedia("(pointer: coarse)").matches,
      anyHover: view.matchMedia("(any-hover: hover)").matches,
    },
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
    active: identity(document.activeElement),
    viewport: { width: boundedNumber(view.innerWidth), height: boundedNumber(view.innerHeight) },
    pointer: {
      ...pointer,
      lastHit:
        pointer.last && pointer.last.x !== null && pointer.last.y !== null
          ? identity(document.elementFromPoint(pointer.last.x, pointer.last.y))
          : "absent",
    },
    targets: state,
    css: {
      ...countDeskDiagnosticCssRules(sheets),
      inaccessibleSheets,
      truncatedSheets: document.styleSheets.length > MAX_STYLESHEETS,
    },
    outer,
  };
}

/** Failure observation must never mask or replace the original assertion. */
export function rethrowWithDeskSidebarFailureDiagnostics(
  error: unknown,
  collect: () => ReturnType<typeof collectDeskSidebarFailureDiagnostics>,
  emit: (record: string) => void,
): never {
  try {
    const record = JSON.stringify(collect());
    emit(
      record.length <= MAX_DESK_FAILURE_DIAGNOSTIC_LENGTH
        ? record
        : '{"version":1,"available":false,"truncated":true}',
    );
  } catch {
    // Observation/logging failure leaves the exact original failure intact.
  }
  throw error;
}
