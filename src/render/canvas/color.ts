/**
 * CSS colors, as the canvas renderer needs them: a 0xRRGGBB number and an
 * alpha. Computed styles give colors as rgb()/rgba() (or color(srgb ...)
 * for color-mix()); anything else is worked out by the browser itself.
 */

export interface Rgba {
  /** 0xRRGGBB */
  rgb: number;
  /** 0 to 1 */
  alpha: number;
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const pack = (r: number, g: number, b: number) => (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);

/** "50%" or "0.5" as 0 to 1. */
function alphaOf(text: string | undefined): number {
  if (text === undefined || text === "") return 1;
  const value = text.endsWith("%") ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

/** A channel of rgb(): "255" or "100%". */
const channel = (text: string) =>
  text.endsWith("%") ? (Number.parseFloat(text) * 255) / 100 : Number.parseFloat(text);

const cache = new Map<string, Rgba | null>();

/**
 * Parse a computed CSS color. null for "none", fully transparent colors,
 * and things that aren't colors (url(...) paints).
 */
export function parseColor(css: string, fallback: (css: string) => Rgba | null = browserColor): Rgba | null {
  const text = css.trim().toLowerCase();
  if (cache.has(text)) return cache.get(text)!;
  const parsed = parse(text, fallback);
  const result = parsed && parsed.alpha > 0 ? parsed : null;
  cache.set(text, result);
  return result;
}

function parse(text: string, fallback: (css: string) => Rgba | null): Rgba | null {
  if (!text || text === "none" || text === "transparent" || text.startsWith("url(")) return null;
  if (text.startsWith("#")) return hex(text.slice(1));
  let m = /^rgba?\(([^)]*)\)$/.exec(text);
  if (m) {
    // rgb(1, 2, 3), rgba(1, 2, 3, 0.5), rgb(1 2 3 / 50%)
    const [colors, slash] = m[1].split("/");
    const parts = colors
      .split(/[\s,]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = slash !== undefined ? alphaOf(slash.trim()) : alphaOf(parts[3]);
    return { rgb: pack(channel(parts[0]), channel(parts[1]), channel(parts[2])), alpha };
  }
  m = /^color\(srgb\s+([^)]*)\)$/.exec(text);
  if (m) {
    // color(srgb 0.1 0.2 0.3 / 0.5): what color-mix(in srgb, ...) computes to
    const [colors, slash] = m[1].split("/");
    const parts = colors.trim().split(/\s+/).map(Number.parseFloat);
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
    return { rgb: pack(parts[0] * 255, parts[1] * 255, parts[2] * 255), alpha: alphaOf(slash?.trim()) };
  }
  return fallback(text);
}

function hex(digits: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  const full =
    digits.length === 3 || digits.length === 4
      ? [...digits].map((d) => d + d).join("")
      : digits.length === 6 || digits.length === 8
        ? digits
        : null;
  if (!full) return null;
  const n = Number.parseInt(full.slice(0, 6), 16);
  const alpha = full.length === 8 ? Number.parseInt(full.slice(6), 16) / 255 : 1;
  return { rgb: n, alpha };
}

let scratch: CanvasRenderingContext2D | null | undefined;

/** Any other color (named, oklch(), ...): let a 1×1 canvas say what it is. */
function browserColor(text: string): Rgba | null {
  if (scratch === undefined) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      scratch = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      scratch = null;
    }
  }
  if (!scratch) return null;
  scratch.clearRect(0, 0, 1, 1);
  scratch.fillStyle = "#000";
  scratch.fillStyle = text;
  scratch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data;
  if (a === 0) return null;
  // Pixels are stored premultiplied-ish: undo it for partly transparent colors.
  const k = 255 / a;
  return { rgb: pack(r * k, g * k, b * k), alpha: a / 255 };
}

/** Mix two colors in sRGB: `share` of `a`, the rest `b` (like color-mix()). */
export function mix(a: number, b: number, share: number): number {
  const ch = (c: number, shift: number) => (c >> shift) & 255;
  const m = (shift: number) => ch(a, shift) * share + ch(b, shift) * (1 - share);
  return pack(m(16), m(8), m(0));
}
