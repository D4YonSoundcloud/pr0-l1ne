/**
 * Helpers for the controllers' tests (not used by the app).
 */
import { traceJavaScript } from "../js/trace";
import { ProgramStore } from "../programs";
import { createSettings, type KeyValueStorage } from "../settings";
import { applyHints } from "../trace/hints";
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

/** Settings and app state over a fresh storage. */
export function makeApp(storage = memoryStorage()) {
  const settings = createSettings(storage);
  const app = new AppStore(settings, new ProgramStore(settings.programStorage()));
  return { settings, app, storage };
}

/** Trace some JavaScript and show it, at `step` (default: the last step). */
export async function showJavaScript(app: AppStore, code: string, step?: number): Promise<void> {
  const trace = applyHints(await traceJavaScript(code));
  app.showTrace(trace, code, step ?? trace.steps.length - 1);
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
