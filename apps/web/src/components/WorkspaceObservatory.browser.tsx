import "../index.css";

import type {
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  WorkspaceObservatoryFileInput,
  WorkspaceObservatoryFileResult,
  WorkspaceObservatoryTreeResult,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  WorkspaceObservatory,
  WORKSPACE_OBSERVATORY_MAX_PANES,
  WORKSPACE_OBSERVATORY_VISIBLE_DIFF_LINES,
} from "./WorkspaceObservatory";

const ENVIRONMENT_ID = "environment-observatory" as EnvironmentId;
const PROJECT_ID = "project-observatory" as ProjectId;
const OTHER_PROJECT_ID = "project-other" as ProjectId;

/** Every fixture below is synthetic; no real filesystem is touched. */
interface ObservatoryStub {
  readonly tree: ReturnType<typeof vi.fn>;
  readonly readFile: ReturnType<typeof vi.fn>;
}

function makeTreeResult(
  entries: WorkspaceObservatoryTreeResult["entries"],
  overrides: Partial<WorkspaceObservatoryTreeResult> = {},
): WorkspaceObservatoryTreeResult {
  return { relativePath: "", entries, truncated: false, redacted: false, ...overrides };
}

function makeFileResult(
  relativePath: string,
  content: string,
  overrides: Partial<WorkspaceObservatoryFileResult> = {},
): WorkspaceObservatoryFileResult {
  return { relativePath, content, truncated: false, redacted: false, ...overrides };
}

function installObservatory(stub: ObservatoryStub): void {
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    workspaceObservatory: { tree: stub.tree, readFile: stub.readFile },
  } as unknown as EnvironmentApi);
}

function node(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function requireNode(testId: string): HTMLElement {
  const found = node(testId);
  if (!found) throw new Error(`missing [data-testid="${testId}"]`);
  return found;
}

async function waitForNode(testId: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(node(testId)).not.toBe(null), { timeout: 8_000, interval: 16 });
  return requireNode(testId);
}

async function clickNode(testId: string): Promise<void> {
  (await waitForNode(testId)).click();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const FILE_ENTRIES = Array.from({ length: WORKSPACE_OBSERVATORY_MAX_PANES + 2 }, (_u, index) => ({
  name: `file-${index}.txt`,
  relativePath: `file-${index}.txt`,
  kind: "file" as const,
}));

let host: HTMLDivElement | null = null;

beforeEach(() => {
  __resetEnvironmentApiOverridesForTests();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  host?.remove();
  host = null;
});

function renderObservatory(projectId: ProjectId | null, open = true) {
  return render(
    <WorkspaceObservatory
      open={open}
      environmentId={ENVIRONMENT_ID}
      projectId={projectId}
      onOpenChange={() => undefined}
    />,
    { container: host! },
  );
}

describe("WorkspaceObservatory", () => {
  it("lists the selected project root and opens a file pane on demand", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([
          { name: "src", relativePath: "src", kind: "directory" },
          { name: "README.md", relativePath: "README.md", kind: "file" },
        ]),
      ),
      readFile: vi.fn(async () => makeFileResult("README.md", "# Fixture")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await waitForNode("observatory-entry-README.md");
      // The renderer never sends a filesystem root; only the project identity.
      expect(stub.tree.mock.calls[0]?.[0]).toEqual({ projectId: PROJECT_ID });

      await clickNode("observatory-entry-README.md");
      const pane = await waitForNode("observatory-pane-README.md");
      expect(pane.textContent).toContain("# Fixture");
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `1/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("caps open panes and explains the refusal", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () => makeTreeResult(FILE_ENTRIES)),
      readFile: vi.fn(async (input: WorkspaceObservatoryFileInput) =>
        makeFileResult(input.relativePath, `contents of ${input.relativePath}`),
      ),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await waitForNode("observatory-entry-file-0.txt");
      for (let index = 0; index < WORKSPACE_OBSERVATORY_MAX_PANES; index += 1) {
        await clickNode(`observatory-entry-file-${index}.txt`);
        await waitForNode(`observatory-pane-file-${index}.txt`);
      }
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `${WORKSPACE_OBSERVATORY_MAX_PANES}/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );

      await clickNode(`observatory-entry-file-${WORKSPACE_OBSERVATORY_MAX_PANES}.txt`);
      const error = await waitForNode("observatory-pane-error");
      expect(error.textContent).toContain(
        `At most ${WORKSPACE_OBSERVATORY_MAX_PANES} panes can be open.`,
      );
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `${WORKSPACE_OBSERVATORY_MAX_PANES}/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );
      expect(node(`observatory-pane-file-${WORKSPACE_OBSERVATORY_MAX_PANES}.txt`)).toBe(null);
    } finally {
      await screen.unmount();
    }
  });

  it("closes a pane explicitly", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("a.txt", "one")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-a.txt");
      await waitForNode("observatory-pane-a.txt");
      await clickNode("observatory-close-a.txt");
      await vi.waitFor(() => expect(node("observatory-pane-a.txt")).toBe(null));
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `0/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("drops a tree response that resolves after the dialog closed", async () => {
    // A holder keeps the assignment out of TypeScript's control-flow narrowing,
    // which otherwise types the callback as `never` at the call site.
    const releaseTree: { fn: (() => void) | null } = { fn: null };
    const stub: ObservatoryStub = {
      tree: vi.fn(
        async () =>
          await new Promise<WorkspaceObservatoryTreeResult>((resolve) => {
            releaseTree.fn = () =>
              resolve(
                makeTreeResult([{ name: "late.txt", relativePath: "late.txt", kind: "file" }]),
              );
          }),
      ),
      readFile: vi.fn(async () => makeFileResult("late.txt", "late")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await vi.waitFor(() => expect(stub.tree).toHaveBeenCalledTimes(1));

      screen.rerender(
        <WorkspaceObservatory
          open={false}
          environmentId={ENVIRONMENT_ID}
          projectId={PROJECT_ID}
          onOpenChange={() => undefined}
        />,
      );
      releaseTree.fn?.();
      await delay(80);

      screen.rerender(
        <WorkspaceObservatory
          open
          environmentId={ENVIRONMENT_ID}
          projectId={OTHER_PROJECT_ID}
          onOpenChange={() => undefined}
        />,
      );
      await waitForNode("observatory-entries");
      await delay(80);
      // The stale listing never lands in the reopened, different-project session.
      expect(requireNode("observatory-entries").textContent).not.toContain("late.txt");
    } finally {
      await screen.unmount();
    }
  });

  it("drops an in-flight file read when the project switches", async () => {
    const releaseFile: { fn: (() => void) | null } = { fn: null };
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "slow.txt", relativePath: "slow.txt", kind: "file" }]),
      ),
      readFile: vi.fn(
        async () =>
          await new Promise<WorkspaceObservatoryFileResult>((resolve) => {
            releaseFile.fn = () => resolve(makeFileResult("slow.txt", "stale contents"));
          }),
      ),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-slow.txt");
      await vi.waitFor(() => expect(stub.readFile).toHaveBeenCalledTimes(1));

      screen.rerender(
        <WorkspaceObservatory
          open
          environmentId={ENVIRONMENT_ID}
          projectId={OTHER_PROJECT_ID}
          onOpenChange={() => undefined}
        />,
      );
      releaseFile.fn?.();
      await delay(120);

      expect(node("observatory-pane-slow.txt")).toBe(null);
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `0/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("starts paused, refreshes on demand, and reports an unattributed diff", async () => {
    let contents = "alpha\nbeta\n";
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "watched.txt", relativePath: "watched.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("watched.txt", contents)),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-watched.txt");
      await waitForNode("observatory-pane-watched.txt");

      const readsWhileOpen = stub.readFile.mock.calls.length;
      await delay(400);
      // Refresh is opt-in: nothing polls until the user starts it.
      expect(stub.readFile.mock.calls.length).toBe(readsWhileOpen);

      contents = "alpha\nBETA\n";
      await clickNode("observatory-toggle-refresh");

      const diff = await waitForNode("observatory-diff-watched.txt");
      expect(diff.textContent).toContain("1 line changed since the previous snapshot");
      expect(diff.textContent).toContain("Cause is not attributed.");

      await clickNode("observatory-toggle-refresh");
      const readsAfterPause = stub.readFile.mock.calls.length;
      await delay(3_000);
      // Pausing tears the timer down; no further request round is issued.
      expect(stub.readFile.mock.calls.length).toBe(readsAfterPause);
    } finally {
      await screen.unmount();
    }
  });

  it("stops polling once the dialog is closed", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "watched.txt", relativePath: "watched.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("watched.txt", "same\n")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-watched.txt");
      await waitForNode("observatory-pane-watched.txt");
      await clickNode("observatory-toggle-refresh");
      await vi.waitFor(() => expect(stub.readFile.mock.calls.length).toBeGreaterThan(1), {
        timeout: 8_000,
        interval: 50,
      });

      screen.rerender(
        <WorkspaceObservatory
          open={false}
          environmentId={ENVIRONMENT_ID}
          projectId={PROJECT_ID}
          onOpenChange={() => undefined}
        />,
      );
      const readsAtClose = stub.readFile.mock.calls.length;
      await delay(3_000);
      expect(stub.readFile.mock.calls.length).toBe(readsAtClose);
    } finally {
      await screen.unmount();
    }
  });

  it("surfaces a server denial without exposing a path", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () => {
        throw new Error("Workspace path must stay within the project root.");
      }),
      readFile: vi.fn(async () => makeFileResult("a.txt", "")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      const error = await waitForNode("observatory-tree-error");
      expect(error.textContent).toContain("Workspace path must stay within the project root.");
      expect(node("observatory-entries")?.textContent ?? "").toBe("");
    } finally {
      await screen.unmount();
    }
  });

  it("starts a switched project with no content from the previous one", async () => {
    const stub: ObservatoryStub = {
      // The new project's listing never resolves, so anything on screen after
      // the switch can only have come from the previous project.
      tree: vi.fn(async (input: { projectId: ProjectId }) =>
        input.projectId === OTHER_PROJECT_ID
          ? await new Promise<WorkspaceObservatoryTreeResult>(() => {})
          : makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("a.txt", "first project contents")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-a.txt");
      const pane = await waitForNode("observatory-pane-a.txt");
      expect(pane.textContent).toContain("first project contents");

      await screen.rerender(
        <WorkspaceObservatory
          open
          environmentId={ENVIRONMENT_ID}
          projectId={OTHER_PROJECT_ID}
          onOpenChange={() => undefined}
        />,
      );

      // The keyed session body is replaced rather than cleared by an effect, so
      // the previous project's pane is already gone even though the new project
      // has produced nothing to replace it with.
      expect(document.body.textContent).not.toContain("first project contents");
      expect(node("observatory-pane-a.txt")).toBe(null);
      expect(requireNode("observatory-pane-count").textContent).toContain(
        `0/${WORKSPACE_OBSERVATORY_MAX_PANES} panes`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("isolates project sessions when identifiers contain the key delimiter", async () => {
    const firstEnvironment = "environment:remote" as EnvironmentId;
    const secondEnvironment = "environment" as EnvironmentId;
    __setEnvironmentApiOverrideForTests(firstEnvironment, {
      workspaceObservatory: {
        tree: vi.fn(async () =>
          makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
        ),
        readFile: vi.fn(async () => makeFileResult("a.txt", "previous environment contents")),
      },
    } as unknown as EnvironmentApi);
    __setEnvironmentApiOverrideForTests(secondEnvironment, {
      workspaceObservatory: {
        tree: vi.fn(() => new Promise<WorkspaceObservatoryTreeResult>(() => {})),
        readFile: vi.fn(),
      },
    } as unknown as EnvironmentApi);
    const screen = await render(
      <WorkspaceObservatory
        open
        environmentId={firstEnvironment}
        projectId={"project" as ProjectId}
        onOpenChange={() => undefined}
      />,
      { container: host! },
    );
    try {
      await clickNode("observatory-entry-a.txt");
      expect((await waitForNode("observatory-pane-a.txt")).textContent).toContain(
        "previous environment contents",
      );
      await screen.rerender(
        <WorkspaceObservatory
          open
          environmentId={secondEnvironment}
          projectId={"remote:project" as ProjectId}
          onOpenChange={() => undefined}
        />,
      );
      expect(document.body.textContent).not.toContain("previous environment contents");
      expect(node("observatory-pane-a.txt")).toBe(null);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the newest directory listing when an older one resolves later", async () => {
    const pendingSrc: { fn: (() => void) | null } = { fn: null };
    const stub: ObservatoryStub = {
      tree: vi.fn(async (input: { relativePath?: string }) => {
        if (input.relativePath === "src") {
          // Held open so the later navigation can overtake it.
          return await new Promise<WorkspaceObservatoryTreeResult>((resolve) => {
            pendingSrc.fn = () =>
              resolve(
                makeTreeResult([{ name: "slow.txt", relativePath: "src/slow.txt", kind: "file" }], {
                  relativePath: "src",
                }),
              );
          });
        }
        if (input.relativePath === "docs") {
          return makeTreeResult(
            [{ name: "fast.txt", relativePath: "docs/fast.txt", kind: "file" }],
            { relativePath: "docs" },
          );
        }
        return makeTreeResult([
          { name: "docs", relativePath: "docs", kind: "directory" },
          { name: "src", relativePath: "src", kind: "directory" },
        ]);
      }),
      readFile: vi.fn(async () => makeFileResult("docs/fast.txt", "")),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-src");
      await vi.waitFor(() => expect(stub.tree).toHaveBeenCalledTimes(2));

      // A newer navigation is issued and resolves while the older one is held.
      await clickNode("observatory-entry-docs");
      await waitForNode("observatory-entry-docs/fast.txt");

      pendingSrc.fn?.();
      await delay(150);

      // The superseded listing must not rewrite the newer one, and the
      // breadcrumb must keep agreeing with the entries on screen.
      expect(node("observatory-entry-src/slow.txt")).toBe(null);
      expect(node("observatory-entry-docs/fast.txt")).not.toBe(null);
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches one read per file no matter how fast the entry is clicked", async () => {
    const release: { fn: (() => void) | null } = { fn: null };
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
      ),
      readFile: vi.fn(
        async () =>
          await new Promise<WorkspaceObservatoryFileResult>((resolve) => {
            release.fn = () => resolve(makeFileResult("a.txt", "contents"));
          }),
      ),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      const entry = await waitForNode("observatory-entry-a.txt");
      for (let click = 0; click < 12; click += 1) entry.click();
      await delay(80);
      // The in-flight read is tracked by path, so repeated clicks before state
      // settles cannot multiply requests.
      expect(stub.readFile).toHaveBeenCalledTimes(1);

      release.fn?.();
      await waitForNode("observatory-pane-a.txt");
      entry.click();
      await delay(80);
      // Already open, so still no second read.
      expect(stub.readFile).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("bounds pending reads by the pane ceiling before any of them settle", async () => {
    const stub: ObservatoryStub = {
      tree: vi.fn(async () => makeTreeResult(FILE_ENTRIES)),
      readFile: vi.fn(async () => await new Promise<WorkspaceObservatoryFileResult>(() => {})),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await waitForNode("observatory-entry-file-0.txt");
      for (const entry of FILE_ENTRIES) {
        requireNode(`observatory-entry-${entry.relativePath}`).click();
      }
      await delay(120);
      // Pending reads count against the ceiling, so the burst cannot exceed it
      // even though no pane has rendered yet.
      expect(stub.readFile.mock.calls.length).toBe(WORKSPACE_OBSERVATORY_MAX_PANES);
      const error = await waitForNode("observatory-pane-error");
      expect(error.textContent).toContain(
        `At most ${WORKSPACE_OBSERVATORY_MAX_PANES} panes can be open.`,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("does not let a closed pane's late read update the reopened pane", async () => {
    const pending: { fn: ((value: WorkspaceObservatoryFileResult) => void) | null } = { fn: null };
    let readCount = 0;
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => {
        readCount += 1;
        if (readCount === 1) return makeFileResult("a.txt", "original contents");
        if (readCount === 2) {
          return await new Promise<WorkspaceObservatoryFileResult>((resolve) => {
            pending.fn = resolve;
          });
        }
        return makeFileResult("a.txt", "reopened contents");
      }),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-a.txt");
      await waitForNode("observatory-pane-a.txt");

      // Start a refresh read, then close the pane while that read is in flight.
      await clickNode("observatory-toggle-refresh");
      await vi.waitFor(() => expect(stub.readFile.mock.calls.length).toBeGreaterThan(1), {
        timeout: 8_000,
        interval: 25,
      });
      await clickNode("observatory-close-a.txt");
      await vi.waitFor(() => expect(node("observatory-pane-a.txt")).toBe(null));

      await clickNode("observatory-entry-a.txt");
      const reopened = await waitForNode("observatory-pane-a.txt");
      expect(reopened.textContent).toContain("reopened contents");

      pending.fn?.(makeFileResult("a.txt", "contents from the closed pane"));
      await delay(150);
      // Pane ids are unique per open, so the late response has no pane to match.
      expect(requireNode("observatory-pane-a.txt").textContent).not.toContain(
        "contents from the closed pane",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("marks a pane stale when its refresh fails instead of looking current", async () => {
    let failNextRead = false;
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "a.txt", relativePath: "a.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => {
        if (failNextRead) throw new Error("The workspace observatory is busy.");
        return makeFileResult("a.txt", "last good contents");
      }),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-a.txt");
      await waitForNode("observatory-pane-a.txt");
      failNextRead = true;
      await clickNode("observatory-toggle-refresh");

      const stale = await waitForNode("observatory-stale-a.txt");
      expect(stale.textContent).toContain("Refresh failed");
      expect(stale.textContent).toContain("The workspace observatory is busy.");
      // The previous values are still shown, but they are no longer presented as
      // current.
      expect(requireNode("observatory-pane-a.txt").textContent).toContain("last good contents");
    } finally {
      await screen.unmount();
    }
  });

  it("shows bounded before and after lines for a changed snapshot", async () => {
    let contents = "alpha\nbeta\ngamma\n";
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "watched.txt", relativePath: "watched.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("watched.txt", contents)),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-watched.txt");
      await waitForNode("observatory-pane-watched.txt");

      contents = "alpha\nBETA\ngamma\ndelta\n";
      await clickNode("observatory-toggle-refresh");

      const lines = await waitForNode("observatory-diff-lines-watched.txt");
      expect(lines.textContent).toContain("- 2: beta");
      expect(lines.textContent).toContain("+ 2: BETA");
      expect(lines.textContent).toContain("+ 4: delta");
      // The detail is a description of the file, not an attribution.
      expect(requireNode("observatory-diff-watched.txt").textContent).toContain(
        "Cause is not attributed.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("caps the rendered change list and says how many lines are hidden", async () => {
    const wide = WORKSPACE_OBSERVATORY_VISIBLE_DIFF_LINES + 5;
    let contents = Array.from({ length: wide }, (_u, index) => `line ${index}`).join("\n");
    const stub: ObservatoryStub = {
      tree: vi.fn(async () =>
        makeTreeResult([{ name: "watched.txt", relativePath: "watched.txt", kind: "file" }]),
      ),
      readFile: vi.fn(async () => makeFileResult("watched.txt", contents)),
    };
    installObservatory(stub);

    const screen = await renderObservatory(PROJECT_ID);
    try {
      await clickNode("observatory-entry-watched.txt");
      await waitForNode("observatory-pane-watched.txt");

      contents = Array.from({ length: wide }, (_u, index) => `LINE ${index}`).join("\n");
      await clickNode("observatory-toggle-refresh");

      const lines = await waitForNode("observatory-diff-lines-watched.txt");
      expect(lines.querySelectorAll("li").length).toBe(WORKSPACE_OBSERVATORY_VISIBLE_DIFF_LINES);
      const more = requireNode("observatory-diff-more-watched.txt");
      expect(more.textContent).toContain("5 more changed lines not shown.");
    } finally {
      await screen.unmount();
    }
  });
});
