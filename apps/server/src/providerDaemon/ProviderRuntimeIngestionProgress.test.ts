import { beforeEach, describe, expect, it } from "vitest";

import {
  readProviderRuntimeIngestionCursor,
  recordProviderRuntimeIngestionCursor,
  resetProviderRuntimeIngestionCursorForTest,
} from "./ProviderRuntimeIngestionProgress.ts";

describe("ProviderRuntimeIngestionProgress", () => {
  beforeEach(() => resetProviderRuntimeIngestionCursorForTest());

  it("keeps a finite non-negative monotonic processed cursor", () => {
    recordProviderRuntimeIngestionCursor(42.9);
    recordProviderRuntimeIngestionCursor(12);
    recordProviderRuntimeIngestionCursor(-1);
    recordProviderRuntimeIngestionCursor(Number.NaN);
    recordProviderRuntimeIngestionCursor(Number.POSITIVE_INFINITY);

    expect(readProviderRuntimeIngestionCursor()).toBe(42);
  });
});
