/**
 * Everything the app remembers between visits, in one place.
 *
 * Every saved setting is defined here, with its key, its type and its
 * default. The rest of the app reads and writes settings only through this
 * module (`settings.speed.get()`, `settings.code("python").set(...)`), never
 * localStorage directly.
 *
 * Keys are "pr0l1ne:<name>". Before version 1 they were "algoviz:<name>";
 * the first visit after the change copies them over (see migrate), so nobody
 * loses saved programs or preferences. The old keys are left in place, so
 * going back to an older build still finds them.
 *
 * If storage is unavailable (some privacy modes, sandboxed frames), settings
 * last for the visit only.
 */
import { isLanguageId, type LanguageId } from "./languages";

export const PREFIX = "pr0l1ne:";
const OLD_PREFIX = "algoviz:";
const VERSION_KEY = `${PREFIX}settings-version`;
/** The current layout of saved settings. Bump it and add a migration when keys or formats change. */
export const SETTINGS_VERSION = 1;

/** Saved programs (see programs.ts, which reads and writes this key itself). */
export const PROGRAMS_KEY = `${PREFIX}programs`;

/** The part of the Storage API used here, so tests can pass a fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** One saved value. */
export interface Setting<T> {
  get(): T;
  set(value: T): void;
}

/** Storage that never throws: falls back to memory when the real one fails. */
class SafeStorage {
  private readonly memory = new Map<string, string>();

  constructor(readonly real: KeyValueStorage | null) {}

  read(key: string): string | null {
    try {
      if (this.real) return this.real.getItem(key);
    } catch {
      // unavailable: fall through to memory
    }
    return this.memory.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.memory.set(key, value);
    try {
      this.real?.setItem(key, value);
    } catch {
      // full or unavailable: kept in memory for this visit
    }
  }

  keys(): string[] {
    const out = new Set(this.memory.keys());
    try {
      for (let i = 0; this.real && i < this.real.length; i++) {
        const key = this.real.key(i);
        if (key !== null) out.add(key);
      }
    } catch {
      // unavailable
    }
    return [...out];
  }
}

/**
 * Bring saved settings up to the current version. Each step runs once, in
 * order, on the first visit after an update.
 */
const MIGRATIONS: ((store: SafeStorage) => void)[] = [
  // 0 -> 1: "algoviz:*" keys become "pr0l1ne:*".
  (store) => {
    // Code saved before JavaScript support existed was always Python.
    const legacyCode = store.read(`${OLD_PREFIX}code`);
    if (legacyCode !== null && store.read(`${OLD_PREFIX}code:python`) === null) {
      store.write(`${PREFIX}code:python`, legacyCode);
    }
    for (const key of store.keys()) {
      if (!key.startsWith(OLD_PREFIX) || key === `${OLD_PREFIX}code`) continue;
      const renamed = PREFIX + key.slice(OLD_PREFIX.length);
      const value = store.read(key);
      if (value !== null && store.read(renamed) === null) store.write(renamed, value);
    }
  },
];

function migrate(store: SafeStorage): void {
  const from = Number(store.read(VERSION_KEY)) || 0;
  for (let version = from; version < MIGRATIONS.length; version++) MIGRATIONS[version](store);
  if (from !== SETTINGS_VERSION) store.write(VERSION_KEY, String(SETTINGS_VERSION));
}

function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // reading localStorage itself can throw when it's blocked
  }
}

export type SizeFamily = "python" | "javascript";

/** The renderers the person can pick: SVG (the default) or Canvas 2D (PixiJS). */
export const RENDERER_KINDS = ["svg", "canvas"] as const;
export type RendererKind = (typeof RENDERER_KINDS)[number];
export type Pane = "memory" | "loop";

export function createSettings(storage: KeyValueStorage | null = browserStorage()) {
  const store = new SafeStorage(storage);
  migrate(store);

  const setting = <T>(name: string, parse: (raw: string | null) => T, format: (value: T) => string): Setting<T> => ({
    get: () => parse(store.read(PREFIX + name)),
    set: (value) => store.write(PREFIX + name, format(value)),
  });
  /** Stored as "on" / "off"; anything else counts as the default. */
  const flag = (name: string, fallback: boolean) =>
    setting(
      name,
      (raw) => (fallback ? raw !== "off" : raw === "on"),
      (on) => (on ? "on" : "off"),
    );
  const choice = <T extends string>(name: string, options: readonly T[], fallback: T) =>
    setting(
      name,
      (raw) => (options.includes(raw as T) ? (raw as T) : fallback),
      (value) => value,
    );
  /** A number, or null when nothing (or nothing numeric) is saved. */
  const number = (name: string) =>
    setting<number | null>(
      name,
      (raw) => (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null),
      (value) => String(value ?? ""),
    );
  /** Raw text, or null when nothing is saved. Callers parse it (JSON, ids...). */
  const text = (name: string) =>
    setting<string | null>(
      name,
      (raw) => raw,
      (value) => value ?? "",
    );

  return {
    /** The language last used; null on a first visit. */
    language: setting<LanguageId | null>(
      "language",
      (raw) => (isLanguageId(raw) ? raw : null),
      (id) => id ?? "",
    ),
    /** The code in the editor, per language; null until the person types. */
    code: (language: LanguageId) => text(`code:${language}`),
    /** The saved program open in each language, by id; "" or null when none. */
    openProgram: (language: LanguageId) => text(`open:${language}`),

    /** Nested by default: objects only one thing refers to are drawn inside it (see scene/nesting.ts). */
    memoryMode: choice("memory-mode", ["arrows", "nested"] as const, "nested"),
    showOutput: flag("show-output", true),
    dimOutput: flag("dim-output", false),
    sizes: flag("sizes", false),
    /** Which memory-size model, per language family; null for the first choice. */
    sizeModel: (family: SizeFamily) => text(`size-model:${family}`),
    /** Each window's floating zoom controls folded away to one button (see render/viewport.ts). */
    controlsCollapsed: (pane: Pane) => flag(`controls-collapsed:${pane}`, false),
    /** Auto-fit state per window, as JSON (see render/viewport.ts). */
    autoFit: (pane: Pane) => text(`auto-fit:${pane}`),
    /** The Style panel's settings, as JSON (see appearance.ts). */
    appearance: text("appearance"),
    /** The Layout panel's spacing, as JSON: only what differs from the defaults (see render/spacing.ts). */
    spacing: text("spacing"),
    /** The Layout panel's saved layouts, as JSON (see app/spacingController.ts). */
    savedLayouts: text("saved-layouts"),
    /** What draws the memory and loop windows (see app/rendererSwitch.ts). */
    renderer: choice("renderer", RENDERER_KINDS, "svg"),

    complexityLabels: flag("complexity-labels", true),
    /** Measure's time limit in milliseconds; null for the default. */
    measureLimit: number("measure-limit"),
    measureLabels: flag("measure-labels", true),
    /** Growth runs kept for comparison, per language, as JSON (see growthView.ts). */
    growthKept: (language: LanguageId) => text(`growth-kept:${language}`),

    /** Animated by default: the running pass, changing in place as you step. */
    loopMode: choice("loop-mode", ["stacked", "animated"] as const, "animated"),
    loopVertical: flag("loop-vertical", false),
    /** Playback speed in steps per second; null for the default. */
    speed: number("speed"),

    /** Editor and canvas swapped (canvas on the left). */
    swapped: setting(
      "layout",
      (raw) => raw === "swapped",
      (on) => (on ? "swapped" : "normal"),
    ),
    /** The editor's share of the width, in percent; null for the default. */
    split: number("split"),
    /** The memory window's share of the canvas height, in percent; null for the default. */
    canvasSplit: number("canvas-split"),
    /** Side by side: the memory window's share of the canvas width, in percent; null for the default. */
    columnSplit: number("column-split"),
    /** On a wide screen: memory over loop history beside the code, or all three side by side (see app/layout.ts). */
    layoutMode: choice("layout-mode", ["stacked", "columns"] as const, "stacked"),
    /** The windows folded to bars, as "memory,loop" (see app/layout.ts); null or "" for none. */
    collapsed: text("collapsed"),
    /** On a phone, the one or two windows shown, as "editor,memory" (see app/mobileViews.ts); null for the default. */
    mobileViews: text("mobile-views"),

    /**
     * The storage saved programs live in (programs.ts), or null when it's
     * unavailable. Programs need the real storage so a full one can be
     * reported instead of silently dropping a save.
     */
    programStorage: (): KeyValueStorage | null => store.real,
  };
}

export type Settings = ReturnType<typeof createSettings>;
