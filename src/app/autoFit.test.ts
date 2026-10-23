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
    expect(storedAutoFit(saved('{"on":true,"mode":"both"}'))).toEqual({ on: true, mode: "both" });
    expect(storedAutoFit(saved('{"on":false}'))).toEqual({ on: false, mode: "out" });
  });

  it("with nothing saved (or nothing readable), is on, zooming out only", () => {
    expect(storedAutoFit(saved(null))).toEqual({ on: true, mode: "out" });
    expect(storedAutoFit(saved("null"))).toEqual({ on: true, mode: "out" });
    expect(storedAutoFit(saved("not json"))).toEqual({ on: true, mode: "out" });
  });
});
