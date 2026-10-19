import { describe, expect, it } from "vitest";
import { createSettings } from "../settings";
import { storedAutoFit } from "./autoFit";

describe("storedAutoFit", () => {
  const saved = (value: string | null) => {
    const s = createSettings(null).autoFit("memory");
    if (value !== null) s.set(value);
    return s;
  };

  it("is what was saved", () => {
    expect(storedAutoFit(saved('{"on":true,"mode":"both"}'), true, false)).toEqual({ on: true, mode: "both" });
    expect(storedAutoFit(saved('{"on":false}'), true, true)).toEqual({ on: false, mode: "out" });
  });

  it("with nothing saved, is off, except on a phone-width screen when asked", () => {
    expect(storedAutoFit(saved(null), true, false)).toEqual({ on: false, mode: "out" });
    expect(storedAutoFit(saved(null), true, true)).toEqual({ on: true, mode: "out" });
    expect(storedAutoFit(saved("not json"), true, true)).toEqual({ on: true, mode: "out" });
    expect(storedAutoFit(saved("null"), true, false)).toEqual({ on: false, mode: "out" });
    expect(storedAutoFit(saved(null), false, true)).toEqual({ on: false, mode: "out" }); // the loop history
  });

  it("asks the screen when not told (no matchMedia in Node: not a phone)", () => {
    expect(storedAutoFit(saved(null), true)).toEqual({ on: false, mode: "out" });
  });
});
