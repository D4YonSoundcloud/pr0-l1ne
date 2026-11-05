/**
 * What the page knows of a trace: everything it shows apart from the two
 * windows' drawings, which the layout worker makes (src/layout/). The
 * worker holds the trace itself; once it's prepared, it sends this.
 *
 * Per step (as columns, so a long run is a few arrays rather than thousands
 * of objects): the line, the event, the step label's words, how much had
 * been printed, and the steps skipped before it. And for the run: what it
 * printed, its error, why it stopped early, its hints' warnings, what the
 * hint assistant offers in the editor, the complexity estimate from the
 * run alone, and its size in numbers for the benchmarks.
 */
import { emptyContext, type HintContext, hintContext } from "../hintAssist";
import type { TraceStats } from "../perf";
import { type Estimate, estimateComplexity } from "./complexity";
import { describe } from "./describe";
import type { Step, Trace } from "./types";

export interface TraceInfo {
  language: Trace["language"];
  /** A SQL trace (its stages: `stages`). */
  sql: boolean;
  /** How many steps. */
  steps: number;
  /** Each step's line (0 or less: none), and what happened (Step.event). */
  lines: number[];
  events: Step["event"][];
  /** Each step in words, for the step label (trace/describe.ts). */
  labels: string[];
  /** How much of `stdout` had been printed by each step. */
  stdoutLengths: number[];
  /** Steps that ran just before each, unrecorded (the middle of a sampled loop). */
  skipped: number[];
  /** Steps that ran after the last one, unrecorded. */
  skippedAfter: number;
  /** A SQL trace's stages, a step each: the clause it shows, and its line. */
  stages: { clause: string; line: number }[] | null;
  stdout: string;
  error: Trace["error"];
  truncated: boolean;
  stoppedBy?: Trace["stoppedBy"];
  counts?: Trace["counts"];
  /** The hints' warnings, underlined in the editor. */
  warnings: { line: number; message: string }[];
  /** What the hint assistant offers (the run's variables and classes), from the trace before its hints. */
  hintContext: HintContext;
  /** The complexity estimate from the code and this run alone (none if it couldn't be made). */
  estimate: Estimate | null;
  /** Its size in numbers (perf.ts), for the benchmarks. */
  stats: TraceStats;
}

/** The trace's summary, from the trace as it came (`raw`, for the hint assistant) and prepared (hints applied). */
export function summarize(raw: Trace, prepared: Trace): TraceInfo {
  const steps = prepared.steps;
  const lines: number[] = [];
  const events: Step["event"][] = [];
  const labels: string[] = [];
  const stdoutLengths: number[] = [];
  const skipped: number[] = [];
  let maxHeap = 0;
  let heapSum = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    lines.push(step.line);
    events.push(step.event);
    labels.push(describe(step, steps[i - 1]));
    stdoutLengths.push(step.stdoutLength);
    skipped.push(step.skipped ?? 0);
    const size = Object.keys(step.heap).length;
    maxHeap = Math.max(maxHeap, size);
    heapSum += size;
  }
  let estimate: Estimate | null = null;
  if (!prepared.sql)
    try {
      estimate = estimateComplexity(prepared);
    } catch {
      estimate = null;
    }
  let context = emptyContext();
  if (!raw.sql)
    try {
      context = hintContext(raw);
    } catch {
      context = emptyContext();
    }
  return {
    language: prepared.language,
    sql: !!prepared.sql,
    steps: steps.length,
    lines,
    events,
    labels,
    stdoutLengths,
    skipped,
    skippedAfter: steps.at(-1)?.skippedAfter ?? 0,
    stages: prepared.sql ? prepared.sql.stages.map((s) => ({ clause: s.clause, line: s.line })) : null,
    stdout: prepared.stdout,
    error: prepared.error,
    truncated: prepared.truncated,
    ...(prepared.stoppedBy ? { stoppedBy: prepared.stoppedBy } : {}),
    ...(prepared.counts ? { counts: prepared.counts } : {}),
    warnings: prepared.viz?.warnings ?? [],
    hintContext: context,
    estimate,
    stats: {
      steps: steps.length,
      truncated: prepared.truncated,
      stoppedBy: prepared.stoppedBy ?? null,
      maxHeap,
      meanHeap: steps.length ? Math.round(heapSum / steps.length) : 0,
      ran: prepared.counts?.steps ?? steps.length,
    },
  };
}
