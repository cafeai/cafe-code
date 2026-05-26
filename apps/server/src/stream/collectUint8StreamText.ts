import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { TextDecoder } from "node:util";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  chunks: Uint8Array[];
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface DecodeCollectedTextOptions {
  readonly platform?: NodeJS.Platform;
  readonly locale?: string;
}

function countReplacementCharacters(value: string): number {
  return [...value].filter((character) => character === "\uFFFD").length;
}

function decodeWithLabel(buffer: Buffer, label: string): string | undefined {
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return undefined;
  }
}

export function decodeCollectedText(
  buffer: Buffer,
  options: DecodeCollectedTextOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const utf8 = buffer.toString("utf8");
  if (platform !== "win32") {
    return utf8;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return utf8;
  } catch {
    // Windows shells can emit localized command errors in the active ANSI/OEM
    // code page even when the parent Electron process expects UTF-8.
  }

  const locale = options.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const preferredFallbacks = locale.toLowerCase().startsWith("ja")
    ? ["shift_jis", "windows-1252"]
    : ["windows-1252", "shift_jis"];
  const fallback = preferredFallbacks
    .map((label) => decodeWithLabel(buffer, label))
    .filter((value): value is string => value !== undefined)
    .toSorted(
      (left, right) => countReplacementCharacters(left) - countReplacementCharacters(right),
    )[0];

  return fallback ?? utf8;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        chunks: [],
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        /*
         * keep draining after truncation so the child process can exit normally.
         * its a known issue that on windows killing after the output cap can force an expensive taskkill operation and hurt performance
         */
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          return {
            ...state,
            truncated: true,
          };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        state.chunks.push(nextChunk);
        const bytes = state.bytes + nextChunk.byteLength;
        const truncated = chunk.byteLength > remainingBytes;

        return {
          chunks: state.chunks,
          bytes,
          truncated,
        };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => {
      const text = decodeCollectedText(Buffer.concat(state.chunks, state.bytes));
      return {
        text: state.truncated && truncatedMarker.length > 0 ? `${text}${truncatedMarker}` : text,
        bytes: state.bytes,
        truncated: state.truncated,
      };
    }),
  );
};
