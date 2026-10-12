import { describe, expect, it } from "vitest";
import ts from "typescript";
import { collectCopySites, escapeUiLiteral, jsxText, migrateUiCopy } from "./ui-copy-ast.ts";

describe("source localization migration", () => {
  it("does not classify standalone Unicode punctuation as authored words", () => {
    const file = ts.createSourceFile(
      "view.tsx",
      "<span>⋅</span>",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(collectCopySites(file)).toHaveLength(0);
  });
  it("retains canonical fields inside label maps and catches verbs in whitespace templates", () => {
    const result = migrateUiCopy(
      'const LABELS = [{id: "turn/start", value: "running", side: "left", className: "text-sm", command: "echo Save", type: "button", action: "turn/stop", path: "/Save", route: "settings", label: "Ready"}]; const View = () => <button aria-label={`${hidden ? "Show" : "Hide"} ${model.name}`}/>;',
      "view.tsx",
    );
    for (const canonical of [
      'id: "turn/start"',
      'value: "running"',
      'side: "left"',
      'className: "text-sm"',
      'command: "echo Save"',
      'type: "button"',
      'action: "turn/stop"',
      'path: "/Save"',
      'route: "settings"',
    ])
      expect(result.code).toContain(canonical);
    expect(result.code).toContain('label: uiText("Ready")');
    expect(result.code).toContain('hidden ? uiText("Show") : uiText("Hide")');
    expect(result.code).toContain("${model.name}");
  });
  it("retains JSX whitespace/entities and literal ICU syntax", () => {
    expect(jsxText("\n  Your &lt;file&gt;\n  is ready\n")).toBe("Your <file> is ready");
    expect(escapeUiLiteral("can't {x} <b>")).toBe("can''t '{'x'}' '<'b'>'");
  });
  it("localizes only authored display sinks, never protocol/commands/user content", () => {
    const code = `const value = "running"; const command = "echo Danger"; const title = user.title;
      const View = () => <button role="button" className="text-sm" aria-label="Stop task" onClick={()=>send("turn/stop")}>{user.message}Stop</button>;`;
    const result = migrateUiCopy(code, "view.tsx");
    expect(result.code).toContain('aria-label={uiText("Stop task")}');
    expect(result.code).toContain('{uiText("Stop")}');
    expect(result.code).toContain('send("turn/stop")');
    expect(result.code).toContain("{user.message}");
    expect(result.code).toContain('const command = "echo Danger"');
    expect(
      collectCopySites(
        ts.createSourceFile(
          "view.tsx",
          result.code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        ),
      ),
    ).toHaveLength(0);
  });
  it("makes complete rich sentences reorderable with trusted JSX slots", () => {
    const result = migrateUiCopy(
      "<p>Open <a href={target}>settings</a> for {user.name}.</p>",
      "view.tsx",
    );
    expect(result.code).toContain('message={"Open <slot1></slot1> for <slot3></slot3>."}');
    expect(result.code).toContain("href={target}");
    expect(result.code).toContain('uiText("settings")');
    expect(result.code).toContain("slot3: (user.name)");
  });
  it("preserves directives and template parameter expressions exactly", () => {
    const result = migrateUiCopy(
      '"use client"; const View = () => <button title={`Close ${name}`}>Close</button>',
      "view.tsx",
    );
    expect(result.code).toMatch(/^"use client";\s*import/);
    expect(result.code).toContain('uiText("Close {value0}", { value0: name })');
  });
});
