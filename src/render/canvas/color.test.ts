import { describe, expect, it } from "vitest";
import { mix, parseColor } from "./color";

const never = () => {
  throw new Error("should not need the browser");
};

describe("parseColor", () => {
  it("reads what computed styles give", () => {
    expect(parseColor("rgb(255, 0, 128)", never)).toEqual({ rgb: 0xff0080, alpha: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)", never)).toEqual({ rgb: 0, alpha: 0.5 });
    expect(parseColor("rgb(10 20 30 / 25%)", never)).toEqual({ rgb: 0x0a141e, alpha: 0.25 });
    expect(parseColor("rgb(100%, 0%, 50%)", never)).toEqual({ rgb: 0xff0080, alpha: 1 });
  });

  it("reads color-mix() results and hex", () => {
    expect(parseColor("color(srgb 1 0.5 0)", never)).toEqual({ rgb: 0xff8000, alpha: 1 });
    expect(parseColor("color(srgb 0 0 1 / 0.4)", never)).toEqual({ rgb: 0x0000ff, alpha: 0.4 });
    expect(parseColor("#abc", never)).toEqual({ rgb: 0xaabbcc, alpha: 1 });
    expect(parseColor("#11223380", never)).toEqual({ rgb: 0x112233, alpha: 128 / 255 });
  });

  it("has nothing to draw for none, transparent and url() paints", () => {
    for (const css of ["none", "transparent", "rgba(1, 2, 3, 0)", "url(#gradient)", "", "#zz", "#12345"]) {
      expect(parseColor(css, never), css).toBeNull();
    }
    expect(parseColor("rgb(1, 2)", never)).toBeNull();
    expect(parseColor("color(srgb a b c)", never)).toBeNull();
  });

  it("asks the browser about anything else, and remembers the answer", () => {
    let asked = 0;
    const browser = () => {
      asked++;
      return { rgb: 0x123456, alpha: 1 };
    };
    expect(parseColor("oklch(0.5 0.1 200)", browser)).toEqual({ rgb: 0x123456, alpha: 1 });
    expect(parseColor("OKLCH(0.5 0.1 200)", browser)).toEqual({ rgb: 0x123456, alpha: 1 });
    expect(asked).toBe(1);
  });

  it("without a canvas, an unknown color is no color (jsdom)", () => {
    expect(parseColor("rebeccapurple-ish")).toBeNull();
  });
});

describe("mix", () => {
  it("mixes like color-mix(in srgb)", () => {
    expect(mix(0xffffff, 0x000000, 0.5)).toBe(0x808080);
    expect(mix(0xff0000, 0x0000ff, 1)).toBe(0xff0000);
    expect(mix(0xff0000, 0x0000ff, 0)).toBe(0x0000ff);
  });
});
