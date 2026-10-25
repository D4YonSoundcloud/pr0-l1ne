/**
 * The Layout panel (spacingPanel.ts) and the spacing it edits
 * (render/spacing.ts): applied the moment it changes, the step redrawn to
 * show it, and remembered in this browser. Also the layouts the person has
 * saved by name, to switch between.
 */
import {
  changedFromDefault,
  defaultSpacing,
  parseSpacing,
  type Spacing,
  sameSpacing,
  setSpacing,
} from "../render/spacing";
import type { Settings } from "../settings";
import { MAX_NAME, SpacingPanel } from "../spacingPanel";

export interface SavedLayout {
  name: string;
  values: Spacing;
}

/** How many layouts can be saved. */
export const MAX_LAYOUTS = 50;

/** Which layout the spacing on screen is: the default, a saved one (by name), or neither. */
export type LayoutChoice = { kind: "default" } | { kind: "saved"; name: string } | { kind: "custom" };

export interface SpacingOptions {
  settings: Pick<Settings, "spacing" | "savedLayouts">;
  /** The panel goes in the editor pane, like the Style panel. */
  els: { editorPane: HTMLElement; layoutSettings: HTMLButtonElement };
  /** Draw the step on screen again, with the new spacing (no animation). */
  redraw(): void;
  /** The panel opened: close the other panels. */
  onOpen(): void;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
  /** Runs `callback` before the next paint (requestAnimationFrame; replaceable in tests). */
  requestFrame?(callback: () => void): void;
}

/** Saved layouts from settings: anything malformed is skipped. */
export function parseSavedLayouts(json: string | null): SavedLayout[] {
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : [];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SavedLayout[] = [];
  for (const item of raw) {
    const name = typeof item?.name === "string" ? cleanName(item.name) : "";
    if (!name || out.some((l) => l.name === name)) continue;
    out.push({ name, values: parseSpacing(item.values) });
    if (out.length >= MAX_LAYOUTS) break;
  }
  return out;
}

/** A name as it's saved: trimmed, spaces collapsed, at most MAX_NAME characters. */
export const cleanName = (name: string): string => name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

export class SpacingController {
  readonly panel: SpacingPanel;
  private values: Spacing;
  private saved: SavedLayout[];
  /** The saved layout last picked or saved, so it stays selected while the spacing still matches it. */
  private chosen: string | null = null;
  private saveTimer = 0;
  private framePending = false;
  private readonly setTimer: (callback: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  private readonly frame: (callback: () => void) => void;

  constructor(private readonly options: SpacingOptions) {
    this.setTimer = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((id) => window.clearTimeout(id));
    this.frame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(() => callback()));
    this.values = parseSpacing(options.settings.spacing.get());
    this.saved = parseSavedLayouts(options.settings.savedLayouts.get());
    // Before anything is drawn, so the first step already has this spacing.
    setSpacing(this.values);
    this.panel = new SpacingPanel({
      host: options.els.editorPane,
      button: options.els.layoutSettings,
      controller: this,
      onOpen: () => options.onOpen(),
    });
  }

  get(): Spacing {
    return this.values;
  }

  /** Use this spacing now: the step is redrawn before the next paint, and it's saved once changes pause. */
  set(next: Spacing): void {
    this.values = parseSpacing(next);
    setSpacing(this.values);
    this.scheduleRedraw();
    this.clearTimer(this.saveTimer);
    const values = this.values;
    this.saveTimer = this.setTimer(
      () => this.options.settings.spacing.set(JSON.stringify(changedFromDefault(values))),
      250,
    );
  }

  /** The saved layouts, in the order they were first saved. */
  layouts(): readonly SavedLayout[] {
    return this.saved;
  }

  /** Which layout is on screen (for the panel's menu). */
  choice(): LayoutChoice {
    const matches = this.saved.filter((l) => sameSpacing(l.values, this.values));
    const named =
      matches.find((l) => l.name === this.chosen) ?? (sameSpacing(this.values, defaultSpacing()) ? null : matches[0]);
    if (named) return { kind: "saved", name: named.name };
    if (sameSpacing(this.values, defaultSpacing())) return { kind: "default" };
    return { kind: "custom" };
  }

  /** Switch to a saved layout (or the default, for null). */
  load(name: string | null): void {
    const layout = name === null ? null : this.saved.find((l) => l.name === name);
    if (name !== null && !layout) return;
    this.chosen = layout?.name ?? null;
    this.set(layout ? { ...layout.values } : defaultSpacing());
  }

  /**
   * Save the spacing on screen under a name, replacing a saved layout of
   * the same name. Returns what happened, for the panel to say.
   */
  save(rawName: string): { ok: true; name: string; replaced: boolean } | { ok: false; reason: string } {
    const name = cleanName(rawName);
    if (!name) return { ok: false, reason: "Give the layout a name first." };
    const at = this.saved.findIndex((l) => l.name === name);
    if (at < 0 && this.saved.length >= MAX_LAYOUTS)
      return { ok: false, reason: `There are already ${MAX_LAYOUTS} saved layouts: delete one first.` };
    const layout = { name, values: { ...this.values } };
    if (at >= 0) this.saved[at] = layout;
    else this.saved.push(layout);
    this.chosen = name;
    this.persistLayouts();
    return { ok: true, name, replaced: at >= 0 };
  }

  /** Delete a saved layout. The spacing on screen stays as it is. */
  remove(name: string): void {
    const before = this.saved.length;
    this.saved = this.saved.filter((l) => l.name !== name);
    if (this.saved.length === before) return;
    if (this.chosen === name) this.chosen = null;
    this.persistLayouts();
  }

  close(): void {
    this.panel.toggle(false);
  }

  private persistLayouts(): void {
    this.options.settings.savedLayouts.set(
      JSON.stringify(this.saved.map((l) => ({ name: l.name, values: changedFromDefault(l.values) }))),
    );
  }

  /** Dragging a slider sends many changes a frame: draw once per frame. */
  private scheduleRedraw(): void {
    if (this.framePending) return;
    this.framePending = true;
    this.frame(() => {
      this.framePending = false;
      this.options.redraw();
    });
  }
}
