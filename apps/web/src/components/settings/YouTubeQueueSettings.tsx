import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import { LibraryIcon, UploadIcon } from "lucide-react";

import {
  BUNDLED_YOUTUBE_QUEUE_CATALOG,
  DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID,
  loadBundledYouTubeQueue,
  type BundledYouTubeQueueId,
} from "../../bundledYouTubeQueueCatalog";
import {
  YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY,
  YouTubeQueueLibraryError,
  createYouTubeQueueLibraryStore,
  youtubeQueueLibraryStore,
} from "../../youtubeQueueLibrary";
import { YOUTUBE_QUEUE_PARSE_POLICY } from "../../youtubeQueueParser";
import {
  isYouTubeQueueTextFileName,
  previewYouTubeQueueImport,
  suggestedYouTubeQueueName,
  type YouTubeQueueImportPreview,
} from "../../youtubeQueueSettingsModel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type QueueLibraryStore = ReturnType<typeof createYouTubeQueueLibraryStore>;

interface QueueOperationStatus {
  readonly tone: "success" | "error";
  readonly message: string;
}

function operationError(error: unknown): QueueOperationStatus {
  return {
    tone: "error",
    message:
      error instanceof YouTubeQueueLibraryError
        ? error.message
        : "The queue could not be saved. Try again.",
  };
}

function issueLabel(issue: YouTubeQueueImportPreview["visibleIssues"][number]): string {
  return issue.reason === "line-too-long"
    ? `Line ${issue.line} is too long.`
    : `Line ${issue.line} is not a supported YouTube URL.`;
}

function savedStatus(
  disposition: "added" | "replaced",
  name: string,
  itemCount: number,
): QueueOperationStatus {
  return {
    tone: "success",
    message: `${disposition === "added" ? "Added" : "Replaced"} ${name} with ${itemCount} ${itemCount === 1 ? "video" : "videos"}.`,
  };
}

export function YouTubeQueueSettingsSection({
  store = youtubeQueueLibraryStore,
}: {
  store?: QueueLibraryStore;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [bundledQueueId, setBundledQueueId] = useState<BundledYouTubeQueueId>(
    DEFAULT_BUNDLED_YOUTUBE_QUEUE_ID,
  );
  const [queueName, setQueueName] = useState("");
  const [queueText, setQueueText] = useState("");
  const [preview, setPreview] = useState<YouTubeQueueImportPreview | null>(null);
  const [status, setStatus] = useState<QueueOperationStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [fileReading, setFileReading] = useState(false);
  const fileReadRevisionRef = useRef(0);
  const pendingRef = useRef(false);

  const cancelFileRead = useCallback(() => {
    fileReadRevisionRef.current += 1;
    setFileReading(false);
  }, []);

  useEffect(() => {
    store.refresh();
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === YOUTUBE_QUEUE_LIBRARY_STORAGE_KEY) {
        store.refresh();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      fileReadRevisionRef.current += 1;
      window.removeEventListener("storage", handleStorage);
    };
  }, [store]);

  const saveBundledQueue = useCallback(async () => {
    if (pendingRef.current) return;
    const loaded = loadBundledYouTubeQueue(bundledQueueId);
    if (!loaded.ok) {
      setStatus({ tone: "error", message: "The bundled queue could not be loaded." });
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setStatus(null);
    try {
      const result = await store.importQueue(loaded.entry.label, loaded.entry.queue.videoIds);
      setStatus(savedStatus(result.disposition, result.queue.name, result.queue.videoIds.length));
    } catch (error) {
      setStatus(operationError(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [bundledQueueId, store]);

  const importTextQueue = useCallback(async () => {
    if (pendingRef.current) return;
    const nextPreview = previewYouTubeQueueImport(queueText);
    if (!nextPreview.ok) {
      setPreview(null);
      setStatus({ tone: "error", message: nextPreview.message });
      return;
    }

    setPreview(nextPreview);
    if (nextPreview.videoIds.length === 0) {
      setStatus({
        tone: "error",
        message: "The queue does not contain a supported YouTube URL.",
      });
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setStatus(null);
    try {
      const result = await store.importQueue(queueName, nextPreview.videoIds);
      setStatus(savedStatus(result.disposition, result.queue.name, result.queue.videoIds.length));
    } catch (error) {
      setStatus(operationError(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [queueName, queueText, store]);

  const loadTextFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Clear the native selection so choosing the same path again emits a
    // change event after the file is updated on disk.
    event.currentTarget.value = "";
    const revision = fileReadRevisionRef.current + 1;
    fileReadRevisionRef.current = revision;
    if (!file) {
      setFileReading(false);
      return;
    }
    setFileReading(true);
    setPreview(null);
    setStatus(null);
    if (!isYouTubeQueueTextFileName(file.name)) {
      setFileReading(false);
      setStatus({ tone: "error", message: "Choose a .txt file." });
      return;
    }
    if (file.size > YOUTUBE_QUEUE_PARSE_POLICY.maxInputBytes) {
      setFileReading(false);
      setStatus({
        tone: "error",
        message: "The queue file is too large. Choose a .txt file that is 256 KB or smaller.",
      });
      return;
    }

    try {
      const text = await file.text();
      if (fileReadRevisionRef.current !== revision) return;
      setFileReading(false);
      setQueueText(text);
      setQueueName(suggestedYouTubeQueueName(file.name));
    } catch {
      if (fileReadRevisionRef.current !== revision) return;
      setFileReading(false);
      setStatus({ tone: "error", message: "The queue file could not be read." });
    }
  }, []);

  return (
    <SettingsSection
      title="YouTube queues"
      icon={<LibraryIcon className="size-3.5" />}
      aria-busy={pending || fileReading}
    >
      <SettingsRow
        title="Bundled queue"
        description="Save a reviewed queue. Saving the same name replaces its previous videos."
      >
        <div className="grid gap-3 pt-3 pb-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label
            className="grid gap-1.5 text-xs text-muted-foreground"
            htmlFor="bundled-youtube-queue"
          >
            Queue
            <select
              id="bundled-youtube-queue"
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/24 sm:h-8"
              value={bundledQueueId}
              disabled={pending}
              onChange={(event) => {
                setBundledQueueId(event.currentTarget.value as BundledYouTubeQueueId);
                setStatus(null);
              }}
            >
              {BUNDLED_YOUTUBE_QUEUE_CATALOG.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} ({entry.itemCount})
                </option>
              ))}
            </select>
          </label>
          <Button disabled={pending} onClick={() => void saveBundledQueue()}>
            Save bundled queue
          </Button>
        </div>
      </SettingsRow>

      <SettingsRow
        title="Import text queue"
        description="Choose a .txt file or paste one supported YouTube URL on each line. Cafe Code saves only video IDs."
      >
        <div className="grid gap-3 pt-3 pb-3.5">
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            Text file
            <Input
              nativeInput
              type="file"
              accept=".txt,text/plain"
              aria-label="YouTube queue text file"
              disabled={pending}
              onChange={(event) => void loadTextFile(event)}
            />
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            Queue name
            <Input
              nativeInput
              value={queueName}
              aria-label="Imported YouTube queue name"
              maxLength={256}
              disabled={pending}
              onChange={(event) => {
                cancelFileRead();
                setQueueName(event.currentTarget.value);
                setStatus(null);
              }}
            />
          </label>
          <label className="grid gap-1.5 text-xs text-muted-foreground">
            Queue text
            <Textarea
              value={queueText}
              aria-label="YouTube queue text"
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={pending}
              onChange={(event) => {
                cancelFileRead();
                setQueueText(event.currentTarget.value);
                setPreview(null);
                setStatus(null);
              }}
            />
          </label>
          <div>
            <Button disabled={pending || fileReading} onClick={() => void importTextQueue()}>
              {fileReading ? null : <UploadIcon />}
              {fileReading ? "Reading file…" : "Import queue"}
            </Button>
          </div>
        </div>
      </SettingsRow>

      {preview ? (
        <SettingsRow
          title="Import results"
          description="Review the bounded parser results for the most recent import."
        >
          <div className="grid gap-2 pt-3 pb-3.5 text-xs text-muted-foreground">
            <p>
              Accepted {preview.counts.accepted}; duplicates {preview.counts.duplicate}; malformed{" "}
              {preview.counts.malformed}; over limit {preview.counts.overflow}.
            </p>
            {preview.visibleIssues.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5" aria-label="YouTube queue import issues">
                {preview.visibleIssues.map((issue) => (
                  <li key={`${issue.line}:${issue.reason}`}>{issueLabel(issue)}</li>
                ))}
              </ul>
            ) : null}
            {preview.hiddenIssueCount > 0 ? (
              <p>{preview.hiddenIssueCount} more malformed lines are not shown.</p>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}

      <SettingsRow
        title="Saved queues"
        description="Queues stay on this device. This settings page does not start playback."
        status={
          status ? (
            <p role={status.tone === "error" ? "alert" : "status"} data-tone={status.tone}>
              {status.message}
            </p>
          ) : null
        }
      >
        <div className="pt-3 pb-3.5">
          {snapshot.queues.length === 0 ? (
            <p className="text-xs text-muted-foreground">No queues are saved.</p>
          ) : (
            <ul className="grid gap-2" aria-label="Saved YouTube queues">
              {snapshot.queues.map((queue) => (
                <li
                  key={queue.name}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-xs"
                >
                  <span className="truncate font-medium text-foreground">{queue.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {queue.videoIds.length} videos
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        title="Playback availability"
        description="This import does not check video availability or embedding support. A player must skip unsupported videos."
      />
    </SettingsSection>
  );
}
