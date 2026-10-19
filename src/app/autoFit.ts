import type { AutoFit } from "../scene/renderer";
import type { Setting } from "../settings";
import { isPhoneWidth } from "./mobileViews";

/**
 * A window's auto-fit (see Viewport), as remembered. With nothing saved it's
 * off; `onForPhones` starts it on on a phone-width screen, where a memory
 * diagram at 100% rarely fits. (Not the loop history: fitting all its rows
 * into a phone makes them too small to read, and it keeps the running row in
 * view by itself.)
 */
export function storedAutoFit(saved: Setting<string | null>, onForPhones = false, phone = isPhoneWidth()): AutoFit {
  const fallback: AutoFit = { on: onForPhones && phone, mode: "out" };
  try {
    const raw = JSON.parse(saved.get() ?? "null") as Partial<AutoFit> | null;
    if (!raw) return fallback;
    return { on: raw.on === true, mode: raw.mode === "both" ? "both" : "out" };
  } catch {
    return fallback;
  }
}
