import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY,
  createYouTubeQueueLibraryStore,
  type YouTubeQueueLibraryExclusiveLock,
  type YouTubeQueueLibraryStorage,
} from "../../youtubeQueueLibrary";
import { YouTubeQueueSettingsSection } from "./YouTubeQueueSettings";

function createMemoryStorage() {
  let value: string | null = null;
  const storage: YouTubeQueueLibraryStorage = {
    getItem: (key) => (key === YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY ? value : null),
    setItem: (key, next) => {
      expect(key).toBe(YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY);
      value = next;
    },
  };
  return {
    storage,
    read: () => value,
    write: (next: string | null) => {
      value = next;
    },
  };
}

const lock: YouTubeQueueLibraryExclusiveLock = {
  run: async function run<Value>(operation: () => Value): Promise<Value> {
    return operation();
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YouTubeQueueSettingsSection", () => {
  it("adds and replaces a selected bundled queue without activating media", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    render(<YouTubeQueueSettingsSection store={store} />);

    await expect.element(page.getByRole("heading", { name: "YouTube queues" })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "This import does not check video availability or embedding support. A player must skip unsupported videos.",
          { exact: true },
        ),
      )
      .toBeInTheDocument();

    const queueSelect = document.querySelector("#bundled-youtube-queue") as HTMLSelectElement;
    queueSelect.value = "edm";
    queueSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await page.getByRole("button", { name: "Save bundled queue" }).click();

    await expect.element(page.getByRole("status")).toHaveTextContent("Added EDM with 30 videos.");
    await expect.element(page.getByText("EDM", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("30 videos", { exact: true })).toBeInTheDocument();

    await page.getByRole("button", { name: "Save bundled queue" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Replaced EDM with 30 videos.");

    const raw = backing.read();
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({
      version: 1,
      queues: [{ name: "EDM", videoIds: expect.any(Array) }],
    });
    expect(raw).not.toContain("youtube.com");
    expect(raw).not.toContain("youtu.be");
    expect(document.querySelectorAll("iframe, video, audio, img")).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("imports parsed text, reports bounded diagnostics, and replaces the same name", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    render(<YouTubeQueueSettingsSection store={store} />);

    await page.getByLabelText("Imported YouTube queue name").fill("Night mix");
    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill(
        [
          "https://www.youtube.com/watch?v=AAAAAAAAAAA",
          "https://www.youtube.com/watch?v=AAAAAAAAAAA",
          "not-a-video",
        ].join("\n"),
      );
    await page.getByRole("button", { name: "Import queue" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Added Night mix with 1 video.");
    await expect
      .element(
        page.getByText("Accepted 1; duplicates 1; malformed 1; over limit 0.", { exact: true }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Line 3 is not a supported YouTube URL."))
      .toBeInTheDocument();

    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill("https://youtu.be/BBBBBBBBBBB");
    await page.getByRole("button", { name: "Import queue" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Replaced Night mix with 1 video.");

    const raw = backing.read();
    expect(raw).toContain("BBBBBBBBBBB");
    expect(raw).not.toContain("AAAAAAAAAAA");
    expect(raw).not.toContain("youtube.com");
    expect(raw).not.toContain("youtu.be");
  });

  it("loads a text file and suggests a stable replacement name", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    render(<YouTubeQueueSettingsSection store={store} />);

    await expect
      .element(page.getByLabelText("YouTube queue text file", { exact: true }))
      .toBeInTheDocument();

    const fileInput = document.querySelector(
      'input[aria-label="YouTube queue text file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new File(["https://youtu.be/CCCCCCCCCCC\n"], "MyTravelQueue.txt", {
          type: "text/plain",
        }),
      ],
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await expect
      .element(page.getByLabelText("Imported YouTube queue name"))
      .toHaveValue("MyTravelQueue");
    await expect
      .element(page.getByRole("textbox", { name: "YouTube queue text", exact: true }))
      .toHaveValue("https://youtu.be/CCCCCCCCCCC\n");

    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        new File(["https://youtu.be/DDDDDDDDDDD\n"], "MyTravelQueue.txt", {
          type: "text/plain",
        }),
      ],
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await expect
      .element(page.getByRole("textbox", { name: "YouTube queue text", exact: true }))
      .toHaveValue("https://youtu.be/DDDDDDDDDDD\n");

    await page.getByRole("button", { name: "Import queue" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Added MyTravelQueue with 1 video.");
    expect(backing.read()).toContain("DDDDDDDDDDD");
    expect(backing.read()).not.toContain("CCCCCCCCCCC");
    expect(backing.read()).not.toContain("youtu.be");
  });

  it("does not let a stale file read overwrite newer manual input", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    render(<YouTubeQueueSettingsSection store={store} />);

    let resolveText: ((value: string) => void) | undefined;
    const fileText = new Promise<string>((resolve) => {
      resolveText = resolve;
    });
    const file = new File(["placeholder"], "SlowQueue.txt", { type: "text/plain" });
    Object.defineProperty(file, "text", { value: () => fileText });
    await expect
      .element(page.getByLabelText("YouTube queue text file", { exact: true }))
      .toBeInTheDocument();
    const fileInput = document.querySelector(
      'input[aria-label="YouTube queue text file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByRole("button", { name: "Reading file…" })).toBeDisabled();
    await page.getByLabelText("Imported YouTube queue name").fill("Manual queue");
    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill("https://youtu.be/EEEEEEEEEEE");
    resolveText?.("https://youtu.be/FFFFFFFFFFF");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    await expect
      .element(page.getByLabelText("Imported YouTube queue name"))
      .toHaveValue("Manual queue");
    await expect
      .element(page.getByRole("textbox", { name: "YouTube queue text", exact: true }))
      .toHaveValue("https://youtu.be/EEEEEEEEEEE");
    await expect.element(page.getByRole("button", { name: "Import queue" })).toBeEnabled();
  });

  it("preserves manual input when a selected file is not a text file", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    render(<YouTubeQueueSettingsSection store={store} />);

    await page.getByLabelText("Imported YouTube queue name").fill("Keep this name");
    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill("https://youtu.be/GGGGGGGGGGG");
    await expect
      .element(page.getByLabelText("YouTube queue text file", { exact: true }))
      .toBeInTheDocument();
    const fileInput = document.querySelector(
      'input[aria-label="YouTube queue text file"]',
    ) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["ignored"], "Queue.csv", { type: "text/csv" })],
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByRole("alert")).toHaveTextContent("Choose a .txt file.");
    await expect
      .element(page.getByLabelText("Imported YouTube queue name"))
      .toHaveValue("Keep this name");
    await expect
      .element(page.getByRole("textbox", { name: "YouTube queue text", exact: true }))
      .toHaveValue("https://youtu.be/GGGGGGGGGGG");
  });

  it("serializes rapid import clicks and refreshes after another window writes", async () => {
    const backing = createMemoryStorage();
    let releaseLock: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockCalls = 0;
    const delayedLock: YouTubeQueueLibraryExclusiveLock = {
      run: async function run<Value>(operation: () => Value): Promise<Value> {
        lockCalls += 1;
        await lockGate;
        return operation();
      },
    };
    const store = createYouTubeQueueLibraryStore(backing.storage, delayedLock);
    render(<YouTubeQueueSettingsSection store={store} />);

    await page.getByLabelText("Imported YouTube queue name").fill("One click");
    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill("https://youtu.be/HHHHHHHHHHH");
    const importButton = page
      .getByRole("button", { name: "Import queue" })
      .element() as HTMLButtonElement;
    importButton.click();
    importButton.click();
    expect(lockCalls).toBe(1);
    releaseLock?.();
    await expect.element(page.getByRole("status")).toHaveTextContent("Added One click");

    backing.write(
      JSON.stringify({
        version: 1,
        queues: [
          { name: "One click", videoIds: ["HHHHHHHHHHH"] },
          { name: "Other window", videoIds: ["IIIIIIIIIII"] },
        ],
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY }));
    await expect.element(page.getByText("Other window", { exact: true })).toBeInTheDocument();
  });

  it("shows diagnostics and does not save when no supported URL is accepted", async () => {
    const backing = createMemoryStorage();
    const store = createYouTubeQueueLibraryStore(backing.storage, lock);
    render(<YouTubeQueueSettingsSection store={store} />);

    await page.getByLabelText("Imported YouTube queue name").fill("Broken queue");
    await page
      .getByRole("textbox", { name: "YouTube queue text", exact: true })
      .fill("https://example.com/private-value");
    await page.getByRole("button", { name: "Import queue" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The queue does not contain a supported YouTube URL.");
    await expect
      .element(
        page.getByText("Accepted 0; duplicates 0; malformed 1; over limit 0.", { exact: true }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Line 1 is not a supported YouTube URL."))
      .toBeInTheDocument();
    expect(backing.read()).toBeNull();
  });
});
