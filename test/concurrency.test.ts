import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/utils/concurrency";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  it("preserves input order even when items finish out of order", async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 3, async (ms) => {
      await delay(ms);
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than `concurrency` calls at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("handles an empty list", async () => {
    const results = await mapWithConcurrency([], 3, async (x) => x);
    expect(results).toEqual([]);
  });

  it("handles concurrency greater than the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (x) => x * 10);
    expect(results).toEqual([10, 20]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      })
    ).rejects.toThrow("boom");
  });
});
