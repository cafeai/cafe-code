import { describe, expect, it } from "vitest";
import { GlideCatalogueCapacityError, makeGlideCatalogueBudget } from "./catalogueBudget.ts";

describe("Glide retained catalogue budget", () => {
  it("independently bounds catalogue owners and bytes, and retires only each exact charge", () => {
    const budget = makeGlideCatalogueBudget();
    // These independent policy values protect the admitted owner/file budgets,
    // rather than computing an expected limit from the implementation itself.
    const byteLimit = 128 * 1024 * 1024;
    const owners = Array.from({ length: 128 }, () => budget.reserve(1));
    expect(() => budget.reserve(1)).toThrow(GlideCatalogueCapacityError);
    owners[0]!();
    owners[0]!();
    const replacement = budget.reserve(1);
    expect(() => budget.reserve(1)).toThrow(GlideCatalogueCapacityError);
    replacement();
    for (const release of owners) release();

    const fullExtent = budget.reserve(byteLimit);
    expect(() => budget.reserve(1)).toThrow(GlideCatalogueCapacityError);
    fullExtent();
    fullExtent();
    const most = budget.reserve(byteLimit - 1);
    const lastByte = budget.reserve(1);
    expect(() => budget.reserve(1)).toThrow(GlideCatalogueCapacityError);
    lastByte();
    expect(() => budget.reserve(2)).toThrow(GlideCatalogueCapacityError);
    const exactReplacement = budget.reserve(1);
    exactReplacement();
    most();
    const fullyReclaimed = budget.reserve(byteLimit);
    fullyReclaimed();
  });

  it("refuses invalid extents without consuming capacity", () => {
    const budget = makeGlideCatalogueBudget();
    const byteLimit = 128 * 1024 * 1024;
    for (const bytes of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      byteLimit + 1,
    ]) {
      expect(() => budget.reserve(bytes)).toThrow(GlideCatalogueCapacityError);
    }
    const release = budget.reserve(byteLimit);
    release();
    const reclaimed = budget.reserve(byteLimit);
    reclaimed();
  });
});
