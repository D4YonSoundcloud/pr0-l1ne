/**
 * Everything that differs between languages, in one place: which worker runs
 * the code, which Monaco mode highlights it, and the starter examples.
 * Everything downstream of the worker only sees the trace format.
 */
import { JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES, TYPESCRIPT_EXAMPLES, type Example } from "./examples";

export type LanguageId = "python" | "javascript" | "typescript";

export interface Language {
  id: LanguageId;
  label: string;
  /** Monaco language id. */
  monacoId: string;
  examples: Example[];
  /** Vite needs `new URL(..., import.meta.url)` written out literally to bundle a worker. */
  createWorker(): Worker;
}

export const LANGUAGES: Record<LanguageId, Language> = {
  python: {
    id: "python",
    label: "Python",
    monacoId: "python",
    examples: PYTHON_EXAMPLES,
    createWorker: () => new Worker(new URL("./worker/pyodide.worker.ts", import.meta.url), { type: "module" }),
  },
  javascript: {
    id: "javascript",
    label: "JavaScript",
    monacoId: "javascript",
    examples: JAVASCRIPT_EXAMPLES,
    createWorker: () => new Worker(new URL("./js/javascript.worker.ts", import.meta.url), { type: "module" }),
  },
  typescript: {
    id: "typescript",
    label: "TypeScript",
    monacoId: "typescript",
    examples: TYPESCRIPT_EXAMPLES,
    createWorker: () => new Worker(new URL("./js/typescript.worker.ts", import.meta.url), { type: "module" }),
  },
};

export const isLanguageId = (value: unknown): value is LanguageId =>
  typeof value === "string" && value in LANGUAGES;
