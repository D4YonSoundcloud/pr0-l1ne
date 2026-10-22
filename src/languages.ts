/**
 * Everything that differs between languages, in one place: which worker runs
 * the code, which Monaco mode highlights it, and the starter examples.
 * Everything downstream of the worker only sees the trace format.
 *
 * The workers themselves run on the runner's site, not here (see
 * sandbox/origins.ts): runner/runner.ts has one for each of these ids.
 */
import { type Example, JAVASCRIPT_EXAMPLES, PYTHON_EXAMPLES, TYPESCRIPT_EXAMPLES } from "./examples/index";
import { SandboxWorker, type WorkerLike } from "./sandbox/sandboxWorker";

export type LanguageId = "python" | "javascript" | "typescript";

export interface Language {
  id: LanguageId;
  label: string;
  /** Monaco language id. */
  monacoId: string;
  examples: Example[];
  /** A worker for this language, in the runner. */
  createWorker(): WorkerLike;
}

export const LANGUAGES: Record<LanguageId, Language> = {
  python: {
    id: "python",
    label: "Python",
    monacoId: "python",
    examples: PYTHON_EXAMPLES,
    createWorker: () => new SandboxWorker("python"),
  },
  javascript: {
    id: "javascript",
    label: "JavaScript",
    monacoId: "javascript",
    examples: JAVASCRIPT_EXAMPLES,
    createWorker: () => new SandboxWorker("javascript"),
  },
  typescript: {
    id: "typescript",
    label: "TypeScript",
    monacoId: "typescript",
    examples: TYPESCRIPT_EXAMPLES,
    createWorker: () => new SandboxWorker("typescript"),
  },
};

export const isLanguageId = (value: unknown): value is LanguageId => typeof value === "string" && value in LANGUAGES;
