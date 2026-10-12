import "../index.css";

import {
  UI_DIRECTION,
  UI_LOCALE,
  UI_LOCALES,
  createUiTranslator,
  getUiLocale,
  setUiLocale,
  uiText,
} from "@cafecode/shared/i18n";
import { Children, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { initializeUiLocale, UiMessage, useUiPresentation } from "../i18n";
import { applyInterfaceScalePercent } from "../interfaceScale";
import { Button } from "./ui/button";
import { ActivityHeatmap } from "./stats/ActivityHeatmap";
import { ComposerDictationButton } from "./chat/ComposerDictationButton";
import { CLAUDE_PERMISSION_MODE_OPTIONS } from "./chat/claudePermissionMode";
import { ThreadStatusLabel } from "./ThreadStatusLabel";
import { getThreadStatusPill } from "./Sidebar.logic";

const originalLocale = getUiLocale();
const originalLang = document.documentElement.lang;
const originalDirection = document.documentElement.dir;
const workingStatus = getThreadStatusPill("Working");
const permissionPresentation = { options: CLAUDE_PERMISSION_MODE_OPTIONS };

// The parent props remain identical while the locale changes. Exercise actual
// memoized controls, the source-owned lazy table and the existing status helper
// rather than remounting synthetic translations on each change.
const MemoizedLanguageSurface = memo(function MemoizedLanguageSurface({
  onAction,
  onMount,
  onUnmount,
}: {
  onAction: () => void;
  onMount: () => void;
  onUnmount: () => void;
}) {
  const presentation = useUiPresentation(permissionPresentation);
  const options = useMemo(() => presentation.options, [presentation]);
  const [draft, setDraft] = useState("/opaque/{name} draft 日本語 한국어");
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return (
    <section data-testid="memoized-language-surface" data-owner-id="exact-synthetic-owner">
      <textarea
        aria-label="Synthetic editable draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <ComposerDictationButton
        phase="recording"
        statusMessage="Opaque provider status"
        onToggle={onAction}
      />
      <ThreadStatusLabel status={workingStatus} />
      <select aria-label="Synthetic permission options" defaultValue="plan">
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <p data-testid="released-rich-copy">
        <UiMessage
          message="<slot1></slot1>Retrying…"
          slots={{
            slot1: (
              <Button data-action-id="exact-captured-action" onClick={onAction}>
                Opaque action
              </Button>
            ),
          }}
        />
      </p>
    </section>
  );
});

// Exercise the real shared formatter and rich React boundary, without a
// provider, browser-side translation observer, external catalog or native app.
// The isolated Arabic/pseudo catalogs below never register a released locale.
function RenderParts({ parts }: { parts: readonly (string | ReactNode)[] }) {
  return <>{Children.toArray(parts)}</>;
}

beforeEach(async () => {
  setUiLocale("en");
  initializeUiLocale(document);
  await page.viewport(1000, 800);
});

afterEach(async () => {
  applyInterfaceScalePercent(100);
  document.documentElement.classList.remove("dark");
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
  setUiLocale(originalLocale);
  document.documentElement.lang = originalLang;
  document.documentElement.dir = originalDirection;
});

describe("bundled interface formatting", () => {
  it("initializes isolated documents to each finite released language and direction", () => {
    const isolated = document.implementation.createHTMLDocument("Synthetic document");
    isolated.documentElement.lang = "ar";
    isolated.documentElement.dir = "rtl";
    for (const locale of ["en", "ja", "ko"] as const) {
      setUiLocale(locale);
      initializeUiLocale(isolated);
      expect(isolated.documentElement.lang).toBe(locale);
      expect(isolated.documentElement.dir).toBe(UI_DIRECTION);
    }
    expect(UI_LOCALE).toBe("en");
    expect(UI_LOCALES).toEqual([
      { locale: "en", direction: "ltr", name: "English" },
      { locale: "ja", direction: "ltr", name: "日本語" },
      { locale: "ko", direction: "ltr", name: "한국어" },
    ]);
    setUiLocale("en");
  });

  it("preserves complete English copy, apostrophes, plural counts and captured controls", async () => {
    const clicked = vi.fn();
    const screen = await render(
      <p data-testid="english-message">
        <UiMessage
          message="Don''t replay {count, plural, one {# action} other {# actions}}. <retry></retry>"
          values={{ count: 2 }}
          slots={{ retry: <Button onClick={clicked}>Retry now</Button> }}
        />
      </p>,
    );
    try {
      await expect
        .element(screen.getByTestId("english-message"))
        .toHaveTextContent("Don't replay 2 actions. Retry now");
      await screen.getByRole("button", { name: "Retry now", exact: true }).click();
      expect(clicked).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll("[data-testid=english-message] button")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps hostile received strings inert instead of reparsing ICU, markup or attributes", async () => {
    const hostile = '<img src=x onerror="window.__i18nInjected=true"> {count, plural, other {bad}}';
    const screen = await render(
      <p data-testid="inert-value">
        <UiMessage message="Received: {name}" values={{ name: hostile }} />
      </p>,
    );
    try {
      await expect
        .element(screen.getByTestId("inert-value"))
        .toHaveTextContent(`Received: ${hostile}`);
      const element = screen.getByTestId("inert-value").element();
      expect(element.querySelector("img,script,iframe,a")).toBeNull();
      expect(element.children).toHaveLength(0);
      expect(Object.hasOwn(window, "__i18nInjected")).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("does not execute inherited values or accessors in the React adapter", async () => {
    const getter = vi.fn(() => "must not be read");
    const inheritedAction = vi.fn(() => <Button>Inherited action</Button>);
    const values = Object.create({ name: "Inherited name" }) as Record<string, string>;
    Object.defineProperty(values, "name", { get: getter, enumerable: true });
    const slots = Object.create({ action: inheritedAction }) as Record<string, ReactNode>;
    Object.defineProperty(slots, "action", { get: getter, enumerable: true });
    const screen = await render(
      <p data-testid="own-properties">
        <UiMessage message="Hello {name}. <action></action>" values={values} slots={slots} />
      </p>,
    );
    try {
      await expect
        .element(screen.getByTestId("own-properties"))
        .toHaveTextContent("Hello {name}. <action></action>");
      expect(getter).not.toHaveBeenCalled();
      expect(inheritedAction).not.toHaveBeenCalled();
      expect(screen.getByTestId("own-properties").element().querySelector("button")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("preserves exact caller-owned action identity through a reordered isolated rich message", async () => {
    const action = vi.fn();
    const translator = createUiTranslator({
      locale: "ar",
      direction: "rtl",
      catalog: {
        "Continue with <action></action> for <name></name>.":
          "لأجل <name></name>، استخدم <action></action>.",
      },
    });
    const screen = await render(
      <p data-testid="arabic-rich" lang={translator.locale} dir={translator.direction}>
        <RenderParts
          parts={translator.parts<ReactNode>("Continue with <action></action> for <name></name>.", {
            action: () => (
              <Button data-action-id="exact-synthetic-action" onClick={() => action("exact-owner")}>
                Continue
              </Button>
            ),
            name: () => <bdi data-testid="isolated-name">{"/synthetic/{name}/file.ts"}</bdi>,
          })}
        />
      </p>,
    );
    try {
      await expect
        .element(screen.getByTestId("arabic-rich"))
        .toHaveTextContent("لأجل /synthetic/{name}/file.ts، استخدم Continue.");
      const element = screen.getByTestId("arabic-rich").element();
      expect(getComputedStyle(element).direction).toBe("rtl");
      expect(element.querySelector("bdi")?.textContent).toBe("/synthetic/{name}/file.ts");
      const button = screen.getByRole("button", { name: "Continue", exact: true });
      expect(button.element().getAttribute("data-action-id")).toBe("exact-synthetic-action");
      await button.click();
      expect(action).toHaveBeenCalledExactlyOnceWith("exact-owner");
      expect(UI_LOCALES).toHaveLength(3);
      expect(uiText("Continue")).toBe("Continue");
      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("uses all Arabic plural branches in isolation without changing English fallback grammar", async () => {
    const source = "{count, plural, one {# agent} other {# agents}}";
    const translator = createUiTranslator({
      locale: "ar",
      direction: "rtl",
      catalog: {
        [source]:
          "{count, plural, zero {لا وكلاء} one {وكيل واحد} two {وكيلان} few {# وكلاء} many {# وكيلًا} other {# وكيل}}",
      },
    });
    const screen = await render(
      <div lang="ar" dir="rtl">
        {[0, 1, 2, 3, 11, 100].map((count) => (
          <p key={count} data-testid={`plural-${count}`}>
            {translator.text(source, { count })}
          </p>
        ))}
      </div>,
    );
    try {
      for (const [count, expected] of [
        [0, "لا وكلاء"],
        [1, "وكيل واحد"],
        [2, "وكيلان"],
        [3, `${new Intl.NumberFormat("ar").format(3)} وكلاء`],
        [11, `${new Intl.NumberFormat("ar").format(11)} وكيلًا`],
        [100, `${new Intl.NumberFormat("ar").format(100)} وكيل`],
      ] as const) {
        await expect.element(screen.getByTestId(`plural-${count}`)).toHaveTextContent(expected);
      }
      expect(createUiTranslator({ locale: "ar" }).text(source, { count: 2 })).toBe("2 agents");
      expect(uiText(source, { count: 2 })).toBe("2 agents");
    } finally {
      await screen.unmount();
    }
  });

  it("rejects catalog tag attributes rather than granting markup or action authority", async () => {
    const slot = vi.fn(() => <Button>Allowed action</Button>);
    const translator = createUiTranslator({
      locale: "ar",
      catalog: {
        "Safe <action></action>": '<action href="javascript:alert(1)">Bad</action>',
      },
    });
    const screen = await render(
      <p data-testid="invalid-catalog">
        <RenderParts
          parts={translator.parts<ReactNode>("Safe <action></action>", { action: slot })}
        />
      </p>,
    );
    try {
      await expect
        .element(screen.getByTestId("invalid-catalog"))
        .toHaveTextContent("Safe Allowed action");
      expect(slot).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("invalid-catalog").element().querySelector("a,[href]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { milliseconds: 0, expected: "No generating time" },
    { milliseconds: 1, expected: "0s generating" },
    { milliseconds: 60_000, expected: "1m generating" },
    { milliseconds: 65_000, expected: "1m 5s generating" },
    { milliseconds: 3_600_000, expected: "1h generating" },
    { milliseconds: 3_665_000, expected: "1h 1m generating" },
  ])(
    "preserves the heatmap English duration baseline for $milliseconds ms",
    async ({ milliseconds, expected }) => {
      const day = "2026-10-11";
      const screen = await render(
        <ActivityHeatmap
          bounds={{ startDay: day, endDay: day }}
          days={[
            {
              day,
              generatingMs: milliseconds,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              userMessages: 0,
            },
          ]}
        />,
      );
      try {
        const cell = document.querySelector<HTMLElement>(`[data-activity-day="${day}"]`);
        expect(cell).not.toBeNull();
        await page.elementLocator(cell!).hover();
        const date = new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${day}T00:00:00Z`));
        await expect.element(page.getByRole("tooltip")).toHaveTextContent(`${expected} · ${date}`);
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each([
    { theme: "light", scale: 80, reducedMotion: false, direction: "ltr" },
    { theme: "dark", scale: 130, reducedMotion: true, direction: "rtl" },
  ] as const)(
    "keeps expanded isolated copy and controls usable in $theme/$direction at $scale percent",
    async ({ theme, scale, reducedMotion, direction }) => {
      await page.viewport(320, 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      applyInterfaceScalePercent(scale);
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
        ],
      });
      const clicked = vi.fn();
      const source = "The provider is reconnecting. <stop></stop>";
      const translator = createUiTranslator({
        locale: "en",
        direction,
        catalog: {
          [source]:
            "[Ţĥē ƥřøṽīḓēř īş řēçøņņēçţīņɠ — expanded synthetic interface copy stays readable.] <stop></stop>",
        },
      });
      const screen = await render(
        <section
          data-testid="narrow-copy"
          dir={translator.direction}
          className="mx-auto flex w-full min-w-0 max-w-sm flex-col gap-3 rounded-lg border border-border bg-background p-3 text-foreground"
        >
          <h2 className="text-sm font-medium">{uiText("Connection status")}</h2>
          <p className="text-sm wrap-break-word">
            <RenderParts
              parts={translator.parts<ReactNode>(source, {
                stop: () => <Button onClick={clicked}>{uiText("Stop recovery")}</Button>,
              })}
            />
          </p>
        </section>,
      );
      try {
        const button = screen.getByRole("button", { name: "Stop recovery", exact: true });
        await expect.element(button).toBeVisible();
        expect(getComputedStyle(screen.getByTestId("narrow-copy").element()).direction).toBe(
          direction,
        );
        const bounds = button.element().getBoundingClientRect();
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(reducedMotion);
        await button.click();
        expect(clicked).toHaveBeenCalledTimes(1);
        expect(UI_LOCALES).toHaveLength(3);
      } finally {
        await screen.unmount();
      }
    },
  );

  it("updates memoized direct, helper, table and rich copy without resetting draft or authority", async () => {
    const onAction = vi.fn();
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const screen = await render(
      <MemoizedLanguageSurface onAction={onAction} onMount={onMount} onUnmount={onUnmount} />,
    );
    try {
      const textarea = screen.getByRole("textbox", {
        name: "Synthetic editable draft",
        exact: true,
      });
      await textarea.fill("untouched command /plan --exact-owner 日本語 한국어");
      const originalTextarea = textarea.element();
      const control = document.querySelector('[data-composer-dictation="true"]');
      const status = document.querySelector('[data-status="Working"]');
      const option = screen.getByRole("option", { name: "Plan", exact: true }).element();
      const richAction = screen
        .getByRole("button", { name: "Opaque action", exact: true })
        .element();
      const originalIds = CLAUDE_PERMISSION_MODE_OPTIONS.map(({ id }) => id);
      for (const [locale, directLabel, helperLabel, optionLabel, richLabel] of [
        ["ja", "音声入力を停止", "作業中", "計画", "再試行中…"],
        ["ko", "받아쓰기 중지", "작업 중", "계획", "재시도 중…"],
        ["en", "Stop dictation", "Working", "Plan", "Retrying…"],
      ] as const) {
        setUiLocale(locale);
        await expect
          .element(screen.getByRole("button", { name: directLabel, exact: true }))
          .toBeVisible();
        await expect.element(page.elementLocator(status!)).toHaveAttribute("title", helperLabel);
        await expect
          .element(screen.getByRole("option", { name: optionLabel, exact: true }))
          .toHaveAttribute("value", "plan");
        await expect
          .element(screen.getByTestId("released-rich-copy"))
          .toHaveTextContent(`Opaque action${richLabel}`);
        expect(textarea.element()).toBe(originalTextarea);
        expect(document.querySelector('[data-composer-dictation="true"]')).toBe(control);
        expect(document.querySelector('[data-status="Working"]')).toBe(status);
        expect(screen.getByRole("option", { name: optionLabel, exact: true }).element()).toBe(
          option,
        );
        expect(screen.getByRole("button", { name: "Opaque action", exact: true }).element()).toBe(
          richAction,
        );
        await expect
          .element(textarea)
          .toHaveValue("untouched command /plan --exact-owner 日本語 한국어");
        expect(CLAUDE_PERMISSION_MODE_OPTIONS.map(({ id }) => id)).toEqual(originalIds);
        expect(control?.getAttribute("data-composer-dictation-phase")).toBe("recording");
        expect(control?.getAttribute("aria-pressed")).toBe("true");
        expect(onMount).toHaveBeenCalledTimes(1);
        expect(onUnmount).not.toHaveBeenCalled();
        expect(onAction).not.toHaveBeenCalled();
      }
      await screen.getByRole("button", { name: "Stop dictation", exact: true }).click();
      await screen.getByRole("button", { name: "Opaque action", exact: true }).click();
      expect(onAction).toHaveBeenCalledTimes(2);
      expect(richAction.getAttribute("data-action-id")).toBe("exact-captured-action");
    } finally {
      await screen.unmount();
    }
    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it("refreshes mounted heatmap month, weekday and hovered duration caches on locale changes", async () => {
    const day = "2026-10-11";
    const screen = await render(
      <ActivityHeatmap
        bounds={{ startDay: "2026-10-01", endDay: day }}
        days={[
          {
            day,
            generatingMs: 60_000,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            userMessages: 0,
          },
        ]}
      />,
    );
    try {
      const cell = document.querySelector<HTMLElement>(`[data-activity-day="${day}"]`);
      expect(cell).not.toBeNull();
      await page.elementLocator(cell!).hover();
      // Presentation language does not replace the viewer-native calendar or
      // timezone policy. Assert the complete existing tooltip, not a partial
      // duration that would miss accidental date loss during a locale switch.
      const date = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${day}T00:00:00Z`));
      for (const [locale, month, weekday, duration] of [
        ["ja", "10月", "月", "生成時間 1分"],
        ["ko", "10월", "월", "1분 동안 생성"],
        ["en", "Oct", "Mon", "1m generating"],
      ] as const) {
        setUiLocale(locale);
        await expect.element(screen.getByText(month, { exact: true })).toBeInTheDocument();
        await expect.element(screen.getByText(weekday, { exact: true })).toBeInTheDocument();
        await expect.element(page.getByRole("tooltip")).toHaveTextContent(`${duration} · ${date}`);
        expect(document.querySelector(`[data-activity-day="${day}"]`)).toBe(cell);
        expect(cell?.getAttribute("data-activity-in-range")).toBe("true");
      }
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { locale: "ja", theme: "light", scale: 80, reducedMotion: false, label: "音声入力を停止" },
    { locale: "ko", theme: "dark", scale: 130, reducedMotion: true, label: "받아쓰기 중지" },
  ] as const)(
    "keeps released $locale controls usable in narrow $theme at $scale percent",
    async ({ locale, theme, scale, reducedMotion, label }) => {
      await page.viewport(320, 760);
      document.documentElement.classList.toggle("dark", theme === "dark");
      applyInterfaceScalePercent(scale);
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
        ],
      });
      setUiLocale(locale);
      initializeUiLocale(document);
      const onAction = vi.fn();
      const screen = await render(
        <section className="min-w-0 max-w-full p-3">
          <ComposerDictationButton
            phase="recording"
            statusMessage="Opaque status /provider/{count}"
            onToggle={onAction}
          />
          <p className="wrap-break-word">
            {uiText("Dictation unavailable while the composer is busy")}
          </p>
        </section>,
      );
      try {
        const button = screen.getByRole("button", { name: label, exact: true });
        await expect.element(button).toBeVisible();
        const bounds = button.element().getBoundingClientRect();
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.left).toBeGreaterThanOrEqual(-1);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(document.documentElement.lang).toBe(locale);
        expect(document.documentElement.dir).toBe("ltr");
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(reducedMotion);
        await button.click();
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(
          document
            .querySelector('[data-composer-dictation="true"]')
            ?.getAttribute("data-composer-dictation-phase"),
        ).toBe("recording");
      } finally {
        await screen.unmount();
      }
    },
  );
});
