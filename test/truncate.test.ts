import { describe, expect, it } from "vitest";
import { MAX_ECHOED_PATH_LENGTH, truncate } from "../src/utils/truncate";

describe("truncate", () => {
  it("leaves a value shorter than the cap alone", () => {
    expect(truncate("/eligibility/check", 200)).toBe("/eligibility/check");
  });

  it("leaves a value exactly at the cap alone", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("cuts a longer value and marks that it was cut", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde...");
  });

  it("caps request paths at a length that still identifies the route", () => {
    expect(MAX_ECHOED_PATH_LENGTH).toBeGreaterThan(50);
  });
});
