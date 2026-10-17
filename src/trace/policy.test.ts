import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY, policyText } from "./policy";

describe("the tracing policy", () => {
  it("is written to fixtures/policy.json for the Python tracer (run `npm run schema` if not)", () => {
    expect(readFileSync(new URL("../../fixtures/policy.json", import.meta.url), "utf8")).toBe(policyText());
  });

  it("keeps whole passes and shares of the budget", () => {
    const s = POLICY.sampling;
    for (const n of [s.first, s.last, s.roundFrom]) expect(Number.isInteger(n) && n > 0).toBe(true);
    for (const share of [s.sampleShare, s.watchShare, s.roundShare, s.passShare])
      expect(share > 0 && share <= 1).toBe(true);
    expect(POLICY.liveSeconds).toBeLessThanOrEqual(POLICY.runSeconds);
  });
});
