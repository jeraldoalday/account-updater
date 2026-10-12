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

  it("does not split a surrogate-pair character in half", () => {
    // An emoji (and other characters outside the Basic Multilingual Plane)
    // is stored as a surrogate pair - two UTF-16 code units. Cutting by
    // `.length`/`.slice` counts those as two characters, so a pair sitting
    // right at the cutoff used to get split, leaving a lone unpaired
    // surrogate - not valid text on its own - in the truncated value.
    expect(truncate("abcd😀extra text past the cutoff", 5)).toBe("abcd😀...");
  });

  it("caps request paths at a length that still identifies the route", () => {
    expect(MAX_ECHOED_PATH_LENGTH).toBeGreaterThan(50);
  });
});
