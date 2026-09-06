import { EnvironmentId, ThreadId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  uploadFileAttachment,
  getFileAttachmentPreview,
  downloadFileAttachment,
} from "./fileAttachments";
import { FileAttachmentRequestError, getFileAttachmentErrorMessage } from "./fileAttachmentErrors";

const mocks = vi.hoisted(() => ({ bearer: vi.fn() }));
vi.mock("../environments/primary", () => ({
  getPrimaryKnownEnvironment: () => ({ environmentId: "primary" }),
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
beforeEach(() => {
  // Exercise the actual primary URL builder: concatenating strings in a mock
  // hid the regression where the preview query became part of the pathname.
  vi.stubGlobal("window", {
    location: { origin: "http://127.0.0.1:3773", href: "http://127.0.0.1:3773/" },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("environment-scoped file attachment transport", () => {
  it.each(["primary", "remote"])(
    "keeps the preview query separate from the attachment ID on %s",
    async (environment) => {
      mocks.bearer.mockResolvedValue("private-test-bearer");
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ text: "hello", truncated: false })));
      vi.stubGlobal("fetch", fetcher);
      await expect(
        getFileAttachmentPreview({
          environmentId: EnvironmentId.make(environment),
          attachment: file,
        }),
      ).resolves.toEqual({ text: "hello", truncated: false });
      const [requestedUrl, request] = fetcher.mock.calls[0]!;
      const url = new URL(requestedUrl);
      expect(url.origin).toBe(
        environment === "primary" ? "http://127.0.0.1:3773" : "https://remote.example",
      );
      expect(url.pathname).toBe(`/api/attachments/${file.id}`);
      expect(url.search).toBe("?preview=text");
      expect(request.credentials).toBe(environment === "primary" ? "include" : "omit");
      expect(request.headers.get("authorization")).toBe(
        environment === "primary" ? null : "Bearer private-test-bearer",
      );
    },
  );

  it("waits for durable retain acknowledgement before returning a ready upload", async () => {
    let acknowledge!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(file), {
          status: 201,
          headers: { "x-cafe-attachment-lifecycle": "provisional-v1" },
        }),
      )
      .mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetcher);
    let ready = false;
    const uploading = uploadFileAttachment({
      environmentId: EnvironmentId.make("primary"),
      targetThreadId: ThreadId.make("thread"),
      file: new File(["hello"], "source.tex"),
    }).then((value) => {
      ready = true;
      return value;
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(ready).toBe(false);
    expect(fetcher.mock.calls[1]![0]).toBe(
      `http://127.0.0.1:3773/api/attachments/${file.id}/retain`,
    );
    expect(fetcher.mock.calls[1]![1].headers.get("x-cafe-thread-id")).toBe("thread");
    acknowledge(new Response(null, { status: 204 }));
    expect(await uploading).toEqual(file);
  });

  it("discards uploads removed in flight instead of retaining or resurrecting them", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(file), {
          status: 201,
          headers: { "x-cafe-attachment-lifecycle": "provisional-v1" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      uploadFileAttachment({
        environmentId: EnvironmentId.make("primary"),
        targetThreadId: ThreadId.make("thread"),
        file: new File(["hello"], "source.tex"),
        shouldRetain: () => false,
      }),
    ).rejects.toThrow("removed");
    expect(fetcher.mock.calls[1]![0]).toBe(
      `http://127.0.0.1:3773/api/attachments/${file.id}/discard`,
    );
  });

  it("does not expose a ready handle when retention is unavailable", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(file), {
          status: 201,
          headers: { "x-cafe-attachment-lifecycle": "provisional-v1" },
        }),
      )
      .mockResolvedValueOnce(new Response("private error", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      uploadFileAttachment({
        environmentId: EnvironmentId.make("primary"),
        targetThreadId: ThreadId.make("thread"),
        file: new File(["hello"], "source.tex"),
      }),
    ).rejects.toThrow("could not be transferred");
  });
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

  it.each([
    [401, "owner-access"],
    [403, "owner-access"],
    [404, "unavailable"],
    [413, "too-large"],
    [429, "busy"],
    [500, "transfer-failed"],
  ] as const)(
    "classifies preview HTTP %i without exposing the response body",
    async (status, code) => {
      const response = new Response("private remote body /private/credentials", { status });
      // An already locked/failed response body must not hide the HTTP failure.
      vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("private cleanup failure"));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        getFileAttachmentPreview({
          environmentId: EnvironmentId.make("primary"),
          attachment: file,
        }),
      ).rejects.toEqual(new FileAttachmentRequestError(code));
    },
  );

  it("does not expose arbitrary exceptions or an overwritten classified error message", () => {
    expect(getFileAttachmentErrorMessage(new Error("private browser failure"))).toBeNull();
    expect(getFileAttachmentErrorMessage({ code: "owner-access", message: "private" })).toBeNull();
    const error = new FileAttachmentRequestError("busy");
    error.message = "private wrapper detail";
    expect(getFileAttachmentErrorMessage(error)).toBe(
      "Several files are being processed. Please try again shortly.",
    );
  });

  it("distinguishes network failure from missing saved-environment authentication", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private network details"));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      getFileAttachmentPreview({ environmentId: EnvironmentId.make("primary"), attachment: file }),
    ).rejects.toEqual(new FileAttachmentRequestError("transfer-failed"));
    mocks.bearer.mockResolvedValue(null);
    await expect(
      getFileAttachmentPreview({ environmentId: EnvironmentId.make("remote"), attachment: file }),
    ).rejects.toEqual(new FileAttachmentRequestError("environment-unavailable"));
    expect(fetcher).toHaveBeenCalledTimes(1);
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
    vi.stubGlobal("window", { ...window, setTimeout: vi.fn() });
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
