/**
 * What's done to a trace once it has arrived, before its first step is
 * drawn: the work over the whole run. Its hints are applied (hidden
 * variables taken out, heatmaps' ranges found, values turned into what
 * they're drawn as), then its graphs are found over every step (so a
 * graph's layout and legend are the same from first step to last).
 *
 * As work (trace/work.ts), so the page does it a slice at a time with the
 * progress showing, rather than freezing until it's done.
 */
import { graphUnionsWork } from "./graph";
import { applyHintsWork } from "./hints";
import type { Trace } from "./types";
import { type Work, within } from "./work";

/** The trace, hints applied, ready to draw (graphs found, kept for it). */
export function* prepareTrace(trace: Trace): Work<Trace> {
  // Without hints there's next to nothing to apply: finding graphs is all of it.
  const hintShare = trace.hints?.length ? 0.5 : 0;
  const hinted = yield* within(applyHintsWork(trace), 0, hintShare);
  // SQL's database is drawn as tables, never as graphs.
  if (!hinted.sql) yield* within(graphUnionsWork(hinted), hintShare, 1);
  return hinted;
}
