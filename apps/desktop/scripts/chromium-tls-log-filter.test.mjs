import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, it } from "vitest";
import { createChromiumTlsLogFilter, forwardChromiumStderr } from "./chromium-tls-log-filter.mjs";

const authority =
  "[25432:1013/114638.255745:ERROR:net/socket/ssl_client_socket_impl.cc:924] handshake failed; returned -1, SSL error code 1, net_error -202";
const gpu =
  "[25431:1013/111935.364316:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:253] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.";

async function filtered(chunks) {
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(createChromiumTlsLogFilter()))
    output.push(chunk);
  return Buffer.concat(output);
}

describe("source Electron TLS diagnostic output", () => {
  it.each([
    authority + "\n",
    authority + "\r\n",
    authority,
    authority.replace("net/socket/", "net\\socket\\") + "\n",
    authority.replace(
      "net/socket/ssl_client_socket_impl.cc:924",
      "ssl_client_socket_impl.cc(924)",
    ) + "\n",
    authority.replace("[25432:", "[25432:1234:") + "\n",
  ])("quiets only the native authority-handshake line (%s)", async (line) => {
    assert.equal((await filtered([Buffer.from(line)])).length, 0);
  });

  it("handles every byte boundary while preserving GPU, rejection and Unicode output exactly", async () => {
    const retained = `${gpu}\r\nTLS certificate rejected\n  reason: unapproved-authority\n日本語 · 한국어\n`;
    const bytes = Buffer.from(authority + "\r\n" + retained + authority);
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
    assert.deepEqual(await filtered(chunks), Buffer.from(retained));
  });

  it.each([
    authority.replace("-202", "-201"),
    authority.replace("-202", "-206"),
    authority.replace("-202", "-2020"),
    authority.replace("SSL error code 1", "SSL error code 2"),
    authority.replace("returned -1", "returned 0"),
    authority.replace("ssl_client_socket_impl.cc", "another_socket.cc"),
    "application output: " + authority,
    authority + " additional diagnostic",
    gpu,
  ])("preserves other diagnostics and ambiguous messages (%s)", async (line) => {
    const bytes = Buffer.from(line + "\n");
    assert.deepEqual(await filtered([bytes]), bytes);
  });

  it("passes long unterminated and invalid UTF-8 output without unbounded buffering or byte loss", async () => {
    const filter = createChromiumTlsLogFilter();
    const output = [];
    filter.on("data", (bytes) => output.push(bytes));
    const long = Buffer.alloc(128 * 1024, 0x61);
    filter.write(long);
    assert.deepEqual(Buffer.concat(output), long);
    const completion = once(filter, "end");
    const trailer = Buffer.concat([
      Buffer.from(authority + "\n"),
      Buffer.from([0xff, 0xfe, 0x0a]),
      Buffer.from(authority + "\n"),
      Buffer.from("final partial output"),
    ]);
    filter.end(trailer);
    await completion;
    assert.deepEqual(
      Buffer.concat(output),
      Buffer.concat([
        long,
        Buffer.from(authority + "\n"),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from("final partial output"),
      ]),
    );
  });

  it("drains a real isolated Node child's final stderr through a slow sink without ending the terminal", async () => {
    const payload = Buffer.from(authority + "\n" + gpu + "\nfinal partial output");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.stderr.write(Buffer.from('${payload.toString("base64")}', 'base64'));`,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    const closed = once(child, "close");
    const output = [];
    const terminal = new Writable({
      highWaterMark: 1,
      write(bytes, _encoding, done) {
        output.push(Buffer.from(bytes));
        setTimeout(done, 5);
      },
    });
    try {
      assert.equal(await forwardChromiumStderr(child.stderr, terminal), true);
      assert.deepEqual(await closed, [0, null]);
      assert.deepEqual(Buffer.concat(output), Buffer.from(gpu + "\nfinal partial output"));
      assert.equal(terminal.writableEnded, false);
      assert.equal(terminal.destroyed, false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      terminal.destroy();
    }
  });

  it("reports a failed destination instead of claiming diagnostic delivery", async () => {
    const terminal = new Writable({
      write(_bytes, _encoding, done) {
        done(new Error("fixture sink closed"));
      },
    });
    assert.equal(
      await forwardChromiumStderr(Readable.from([Buffer.from(gpu + "\n")]), terminal),
      false,
    );
  });
});
