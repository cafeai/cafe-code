import { EnvironmentId, ThreadId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  uploadFileAttachment,
  getFileAttachmentPreview,
  downloadFileAttachment,
} from "./fileAttachments";

const mocks = vi.hoisted(() => ({ bearer: vi.fn(), primary: vi.fn() }));
vi.mock("../environments/primary", () => ({
  getPrimaryKnownEnvironment: () => ({ environmentId: "primary" }),
}));
vi.mock("../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (path: string) => `http://127.0.0.1:3773${path}`,
}));
vi.mock("../environments/runtime/catalog", () => ({
  readSavedEnvironmentBearerToken: mocks.bearer,
  resolveEnvironmentHttpUrl: ({
    pathname,
    searchParams,
  }: {
    pathname: string;
    searchParams?: Record<string, string>;
  }) =>
    `https://remote.example${pathname}${searchParams ? `?${new URLSearchParams(searchParams)}` : ""}`,
}));

const file = {
  type: "file" as const,
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "source.tex",
  mimeType: "text/plain",
  sizeBytes: 5,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("environment-scoped file attachment transport", () => {
  it("uploads real bytes with target thread binding and cookies only to the primary backend", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(file), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const selected = new File(["hello"], "source.tex", { type: "text/plain" });
    expect(
      await uploadFileAttachment({
        environmentId: EnvironmentId.make("primary"),
        targetThreadId: ThreadId.make("thread"),
        file: selected,
      }),
    ).toEqual(file);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3773/api/attachments");
    expect(request.body).toBe(selected);
    expect(request.credentials).toBe("include");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("x-cafe-thread-id")).toBe("thread");
    expect(request.headers.get("authorization")).toBeNull();
    expect(mocks.bearer).not.toHaveBeenCalled();
  });

  it("routes remote attachments with exact-environment bearer and never forwards cookies", async () => {
    mocks.bearer.mockResolvedValue("private-test-bearer");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(file), { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    await uploadFileAttachment({
      environmentId: EnvironmentId.make("remote"),
      targetThreadId: ThreadId.make("thread"),
      file: new File(["hello"], "source.tex"),
    });
    expect(mocks.bearer).toHaveBeenCalledWith("remote");
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://remote.example/api/attachments");
    expect(request.credentials).toBe("omit");
    expect(request.headers.get("authorization")).toBe("Bearer private-test-bearer");
  });

  it("rejects oversized input locally and strips remote error bodies from UI errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("secret upstream path /private/credentials", { status: 500 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const input = {
      environmentId: EnvironmentId.make("primary"),
      targetThreadId: ThreadId.make("thread"),
      file: new File(["hello"], "source.tex"),
    };
    await expect(uploadFileAttachment(input)).rejects.toThrow(
      "The attachment could not be transferred. Please retry.",
    );
    await expect(
      uploadFileAttachment({
        ...input,
        file: new File([new Uint8Array(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1)], "large"),
      }),
    ).rejects.toThrow("25 MiB");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns inert preview text and refuses malformed or oversized responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "<script>inert</script>", truncated: false })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "x".repeat(65537), truncated: false })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(null)));
    vi.stubGlobal("fetch", fetcher);
    const input = { environmentId: EnvironmentId.make("primary"), attachment: file };
    expect(await getFileAttachmentPreview(input)).toEqual({
      text: "<script>inert</script>",
      truncated: false,
    });
    await expect(getFileAttachmentPreview(input)).rejects.toThrow("could not be previewed");
    expect(await getFileAttachmentPreview(input)).toBeNull();
  });

  it("downloads exact bytes as an inert local blob and refuses truncated downloads", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("hello", { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response("bad"));
    vi.stubGlobal("fetch", fetcher);
    const link = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:inert-file");
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { append: vi.fn() } });
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    try {
      const input = { environmentId: EnvironmentId.make("primary"), attachment: file };
      await downloadFileAttachment(input);
      expect(createObjectURL.mock.calls[0]![0]).toBeInstanceOf(Blob);
      expect((createObjectURL.mock.calls[0]![0] as Blob).type).toBe("application/octet-stream");
      expect(link.href).toBe("blob:inert-file");
      expect(link.download).toBe("source.tex");
      expect(link.click).toHaveBeenCalledTimes(1);
      expect(link.remove).toHaveBeenCalledTimes(1);
      await expect(downloadFileAttachment(input)).rejects.toThrow("incomplete");
      expect(createObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      createObjectURL.mockRestore();
    }
  });
});
