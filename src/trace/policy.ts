/**
 * The tracing policy: how much a trace may record, and how long loops are
 * sampled. Defined here once, for both tracers. The app sends `sampling` and
 * the budget with each run (worker/protocol.ts), so tracer.py and the
 * JavaScript runtime keep no copies of their own.
 *
 * `npm run schema` also writes it to fixtures/policy.json, for running the
 * Python tracer outside the app (its CLI and its own tests); policy.test.ts
 * fails if that file is out of date.
 *
 * The rules themselves are explained in docs/how-it-works.md, "Sampling,
 * strips and shared steps".
 */

export interface SamplingPolicy {
  /** Passes always recorded at the start of a long loop. */
  first: number;
  /** Passes always recorded at its end. */
  last: number;
  /** The smallest round-numbered pass: from here, a leading digit and zeros (10, 20 … 100, 200 …) are kept. */
  roundFrom: number;
  /** A loop of known length is sampled when its passes would take more than this share of the room left. */
  sampleShare: number;
  /** A loop of unknown length is watched, and sampled once it has taken this share. */
  watchShare: number;
  /** Round-numbered passes are kept while the loop's steps, plus room for its last passes, fit in this share. */
  roundShare: number;
  /** One pass of a buffered loop keeps at most this share of the whole budget. */
  passShare: number;
  /**
   * The most heap entries a run may keep: each step whose heap changed (a
   * new object, a changed one, one gone) keeps a record of every object
   * (trace/delta.ts HeapExpander, on the page), so a run's memory grows
   * with its objects times those steps, about 60 bytes an entry. Past
   * this, the run stops as it does when its steps run out
   * (`stoppedBy: "memory"`). Sent with every run with the sampling rules,
   * as both tracers count it.
   */
  maxHeapEntries?: number;
}

export interface Policy {
  /** Steps recorded at most per trace. */
  maxSteps: number;
  /** How long tracing may take while typing (Live), so the page keeps up. */
  liveSeconds: number;
  /** How long tracing may take for Run. Long loops are sampled, so a big input runs until this, not the step budget. */
  runSeconds: number;
  /** Measure's time limit unless the settings say otherwise. */
  measureMs: number;
  sampling: SamplingPolicy;
}

export const POLICY: Policy = {
  maxSteps: 100_000,
  liveSeconds: 3,
  runSeconds: 30,
  measureMs: 20_000,
  sampling: {
    first: 5,
    last: 5,
    roundFrom: 10,
    sampleShare: 0.5,
    watchShare: 0.25,
    roundShare: 0.6,
    passShare: 0.25,
    maxHeapEntries: 12_000_000,
  },
};

/** The policy as fixtures/policy.json holds it. */
export const policyText = (policy: Policy = POLICY): string => `${JSON.stringify(policy, null, 2)}\n`;
