/**
 * Helpers for the controllers' tests (not used by the app).
 */
import { traceJavaScript } from "../js/trace";
import { LocalLayout } from "../layout/service";
import { ProgramStore } from "../programs";
import { createSettings, type KeyValueStorage } from "../settings";
import type { TraceInfo } from "../trace/summary";
import type { Trace } from "../trace/types";
import { AppStore } from "./state";

/** A localStorage stand-in. */
export function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** Each app's layout (on the page, as when the worker can't start), which holds its trace. */
const layouts = new WeakMap<AppStore, LocalLayout>();

/** The layout that holds `app`'s trace (made with the app, by makeApp). */
export function layoutOf(app: AppStore): LocalLayout {
  let layout = layouts.get(app);
  if (!layout) {
    layout = new LocalLayout();
    layouts.set(app, layout);
  }
  return layout;
}

/** Settings, app state over a fresh storage, and the layout that holds the trace. */
export function makeApp(storage = memoryStorage()) {
  const settings = createSettings(storage);
  const app = new AppStore(settings, new ProgramStore(settings.programStorage()));
  return { settings, app, storage, layout: layoutOf(app) };
}

/** Give the layout a trace (as a run does), and what the page knows of it. */
export async function loadTrace(layout: LocalLayout, raw: Trace): Promise<TraceInfo> {
  const loaded = await layout.load("whole", raw, () => {});
  if (loaded.kind !== "ready") throw new Error(`the trace wasn't loaded (${loaded.kind})`);
  return loaded.info;
}

/** Trace some JavaScript and show it, at `step` (default: the last step). */
export async function showJavaScript(app: AppStore, code: string, step?: number): Promise<TraceInfo> {
  const info = await loadTrace(layoutOf(app), await traceJavaScript(code));
  app.showTrace(info, code, step ?? info.steps - 1);
  return info;
}

/** Timers run by hand. */
export function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout: (callback: () => void) => {
      pending.set(next, callback);
      return next++;
    },
    clearTimeout: (id: number) => void pending.delete(id),
    /** Run every pending timer. */
    run() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
    get size() {
      return pending.size;
    },
  };
}
