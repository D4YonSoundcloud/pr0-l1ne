import type { AutoFit } from "../scene/renderer";
import type { Setting } from "../settings";

/**
 * A window's auto-fit (see Viewport), as remembered. With nothing saved
 * (a first visit), it's on, zooming in and out: both windows start fitted
 * snugly to what they draw. Turning it off or changing its mode is remembered.
 */
export function storedAutoFit(saved: Setting<string | null>): AutoFit {
  const fallback: AutoFit = { on: true, mode: "both" };
  try {
    const raw = JSON.parse(saved.get() ?? "null") as Partial<AutoFit> | null;
    if (!raw) return fallback;
    return { on: raw.on === true, mode: raw.mode === "out" ? "out" : "both" };
  } catch {
    return fallback;
  }
}
