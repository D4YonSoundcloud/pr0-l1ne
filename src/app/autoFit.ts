import type { AutoFit } from "../scene/renderer";
import type { Setting } from "../settings";

/** A window's auto-fit (see Viewport), as remembered; off if nothing valid was saved. */
export function storedAutoFit(saved: Setting<string | null>): AutoFit {
  try {
    const raw = JSON.parse(saved.get() ?? "null") as Partial<AutoFit> | null;
    return { on: raw?.on === true, mode: raw?.mode === "both" ? "both" : "out" };
  } catch {
    return { on: false, mode: "out" };
  }
}
