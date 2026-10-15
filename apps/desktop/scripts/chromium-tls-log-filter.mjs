import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_LINE_BYTES = 4096;
// Chromium reports authority rejection before Electron's certificate-error
// callback can apply Cafe's exact-origin pin. This line contains no destination
// and cannot distinguish an approved self-signed peer from an unapproved one.
// Cafe reports the latter separately; never broaden trust to quiet this output.
const AUTHORITY_HANDSHAKE =
  /^\[\d+(?::\d+)?:\d+\/\d+(?:\.\d+)?:ERROR:(?:net[\\/]socket[\\/])?ssl_client_socket_impl\.cc(?::\d+|\(\d+\))\] handshake failed; returned -1, SSL error code 1, net_error -202\r?\n?$/;

export function createChromiumTlsLogFilter() {
  let parts = [];
  let length = 0;
  let passingLongLine = false;
  const emit = (stream) => {
    const line = Buffer.concat(parts, length);
    if (!AUTHORITY_HANDSHAKE.test(line.toString("utf8"))) stream.push(line);
    parts = [];
    length = 0;
  };
  return new Transform({
    transform(chunk, encoding, done) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const end = newline === -1 ? bytes.length : newline + 1;
        const part = bytes.subarray(start, end);
        if (passingLongLine) {
          this.push(part);
        } else if (length + part.length > MAX_LINE_BYTES) {
          // Arbitrary provider/app output must not accumulate an unbounded line
          // or lose bytes. Oversized lines pass through without classification.
          if (length) this.push(Buffer.concat(parts, length));
          this.push(part);
          parts = [];
          length = 0;
          passingLongLine = true;
        } else {
          parts.push(part);
          length += part.length;
          if (newline !== -1) emit(this);
        }
        if (newline !== -1) passingLongLine = false;
        start = end;
      }
      done();
    },
    flush(done) {
      if (length) emit(this);
      done();
    },
  });
}

export function forwardChromiumStderr(source, destination) {
  // The destination belongs to the launching terminal, not to this child.
  return pipeline(source, createChromiumTlsLogFilter(), destination, { end: false }).then(
    () => true,
    () => false,
  );
}
