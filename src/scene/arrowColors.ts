/**
 * Arrow colors that follow the program (Style → Arrows), for the memory
 * view. Each mode says, for each arrow, which color it takes, and makes the
 * legend that says what the colors mean:
 *
 *   variable  every variable gets a color of its own, kept for the whole
 *             run, and its arrow and every arrow of what it reaches take it
 *             (the first variable to reach an object, in color order, owns
 *             it), so a variable's whole chain of objects reads as one
 *   change    arrows that changed this step bright, the rest faded
 *   distance  by how far from the variables an arrow starts: 0 from a
 *             variable, 1 from an object a variable points to...
 *   alias     an object two or more variables point to: their arrows (and
 *             any others to it) in a color of its own, kept for the run;
 *             everything else faded
 *
 * Colors are numbers into the palette (or distance steps), never colors:
 * styles.css and the Style panel say what they look like. "kind" and "one"
 * are the plain modes (scene/arrowKinds.ts), with no legend.
 */
import { liveFrames, type Step, type Trace, type Value } from "../trace/types";
import type { LinkKind } from "./arrowKinds";
import { valuesOf } from "./nesting";

export type ArrowColorMode = "kind" | "one" | "variable" | "change" | "distance" | "alias";

/** How many palette colors there are (styles.css, .group-0 to .group-7). */
export const PALETTE_SIZE = 8;
/** Distance steps (styles.css, .dist-0 to .dist-5); the last means "this far or more". */
export const DISTANCE_STEPS = 6;

/** Where an arrow starts, and what it is. */
export interface ArrowStart {
  /** A variable's own arrow: its function and name. */
  variable: { func: string; name: string } | null;
  /** The object whose cell it starts in (null: a variable). */
  owner: string | null;
  /** How far from the variables its box is: 0 a frame, 1 an object a variable points to... */
  depth: number;
  target: string;
  changed: boolean;
  kind: LinkKind;
}

/** How an arrow is drawn: a palette color, a distance step, or its kind's color; faded, bright or gray. */
export interface ArrowPaint {
  group?: number;
  dist?: number;
  faded?: boolean;
  bright?: boolean;
  /** Not in any group: gray. */
  plain?: boolean;
}

export interface LegendEntry {
  label: string;
  swatch: ArrowPaint & { kind?: LinkKind };
}

export interface ArrowColoring {
  mode: ArrowColorMode;
  /** The legend's title. */
  title: string;
  paint(arrow: ArrowStart): ArrowPaint;
  /** What the colors of the arrows painted so far mean, in order. */
  legend(): LegendEntry[];
}

const varKey = (func: string, name: string) => `${func}\u0001${name}`;

/** Every variable that ever holds a reference, numbered in the order they first do: their colors for the run. */
const variableOrders = new WeakMap<Trace, Map<string, number>>();
function variableOrder(trace: Trace): Map<string, number> {
  let order = variableOrders.get(trace);
  if (order) return order;
  order = new Map();
  for (const step of trace.steps)
    for (const frame of liveFrames(step))
      for (const [name, value] of frame.locals) {
        const key = varKey(frame.func, name);
        if (value.kind === "ref" && !order.has(key)) order.set(key, order.size);
      }
  variableOrders.set(trace, order);
  return order;
}

/** The objects two or more variables point to at a step, each with the variables' names. */
function aliasedAt(step: Step): Map<string, string[]> {
  const holders = new Map<string, string[]>();
  for (const frame of liveFrames(step))
    for (const [name, value] of frame.locals) {
      if (value.kind !== "ref") continue;
      const list = holders.get(value.id) ?? [];
      if (!list.includes(name)) list.push(name);
      holders.set(value.id, list);
    }
  return new Map([...holders].filter(([, names]) => names.length > 1));
}

/** Every object that's ever aliased, numbered in the order it first is: its color for the run. */
const aliasOrders = new WeakMap<Trace, Map<string, number>>();
function aliasOrder(trace: Trace): Map<string, number> {
  let order = aliasOrders.get(trace);
  if (order) return order;
  order = new Map();
  for (const step of trace.steps)
    for (const id of aliasedAt(step).keys()) if (!order.has(id)) order.set(id, order.size);
  aliasOrders.set(trace, order);
  return order;
}

const DISTANCE_LABELS = [
  "from a variable",
  "1 step from a variable",
  "2 steps away",
  "3 steps away",
  "4 steps away",
  "5 or more steps away",
];

/** The coloring for one step of a trace, in a mode. */
export function arrowColoring(trace: Trace, stepIndex: number, mode: ArrowColorMode): ArrowColoring {
  const step = trace.steps[stepIndex];
  const used = new Map<string, { order: number; entry: LegendEntry }>();
  const use = (key: string, order: number, entry: LegendEntry) => {
    if (!used.has(key)) used.set(key, { order, entry });
  };
  const legend = () => [...used.values()].sort((a, b) => a.order - b.order).map((u) => u.entry);

  if (mode === "variable") {
    const order = variableOrder(trace);
    // Each object belongs to the first variable (in color order) that reaches it.
    const vars: { key: string; name: string; func: string; index: number; value: Value }[] = [];
    for (const frame of liveFrames(step))
      for (const [name, value] of frame.locals) {
        const index = order.get(varKey(frame.func, name));
        if (value.kind === "ref" && index !== undefined)
          vars.push({ key: varKey(frame.func, name), name, func: frame.func, index, value });
      }
    vars.sort((a, b) => a.index - b.index);
    const owner = new Map<string, number>();
    for (const v of vars) {
      const queue = v.value.kind === "ref" ? [v.value.id] : [];
      while (queue.length) {
        const id = queue.shift()!;
        if (owner.has(id) || !step.heap[id]) continue;
        owner.set(id, v.index);
        for (const child of valuesOf(step.heap[id])) if (child.kind === "ref") queue.push(child.id);
      }
    }
    // The same name in two functions: say which.
    const names = new Map<string, Set<string>>();
    for (const v of vars) names.set(v.name, (names.get(v.name) ?? new Set()).add(v.func));
    const byIndex = new Map(vars.map((v) => [v.index, v]));
    const labelOf = (index: number) => {
      const v = byIndex.get(index);
      if (!v) return "";
      return (names.get(v.name)?.size ?? 0) > 1
        ? `${v.func === "Global" ? "global" : `${v.func}()`} ${v.name}`
        : v.name;
    };
    return {
      mode,
      title: "Arrows by variable",
      paint(arrow) {
        const index = arrow.variable
          ? order.get(varKey(arrow.variable.func, arrow.variable.name))
          : arrow.owner
            ? owner.get(arrow.owner)
            : undefined;
        if (index === undefined || !byIndex.has(index)) return { plain: true };
        const group = index % PALETTE_SIZE;
        use(`v${index}`, index, { label: labelOf(index), swatch: { group } });
        return { group };
      },
      legend,
    };
  }

  if (mode === "change") {
    return {
      mode,
      title: "What changed",
      paint(arrow) {
        if (arrow.changed) {
          use("changed", 0, { label: "changed this step", swatch: { bright: true, kind: "ref" } });
          return { bright: true };
        }
        use("same", 1, { label: "the same as before", swatch: { faded: true, kind: "ref" } });
        return { faded: true };
      },
      legend,
    };
  }

  if (mode === "distance") {
    return {
      mode,
      title: "Distance from the variables",
      paint(arrow) {
        const dist = Math.min(DISTANCE_STEPS - 1, Math.max(0, arrow.depth));
        use(`d${dist}`, dist, { label: DISTANCE_LABELS[dist], swatch: { dist } });
        return { dist };
      },
      legend,
    };
  }

  if (mode === "alias") {
    const order = aliasOrder(trace);
    const aliased = step ? aliasedAt(step) : new Map<string, string[]>();
    const typeOf = (id: string) => step.heap[id]?.typeName ?? "object";
    return {
      mode,
      title: "Variables pointing at the same object",
      paint(arrow) {
        const names = aliased.get(arrow.target);
        const index = order.get(arrow.target);
        if (!names || index === undefined) {
          use("rest", Number.MAX_SAFE_INTEGER, { label: "the rest", swatch: { faded: true, plain: true } });
          return { faded: true, plain: true };
        }
        const group = index % PALETTE_SIZE;
        use(`a${index}`, index, { label: `${names.join(", ")} → one ${typeOf(arrow.target)}`, swatch: { group } });
        return { group, bright: true };
      },
      legend: () => {
        const entries = legend();
        // Nothing shared right now: say so, rather than only "the rest".
        if (entries.length === 1 && entries[0].label === "the rest")
          return [{ label: "no two variables point at one object now", swatch: entries[0].swatch }];
        return entries;
      },
    };
  }

  return { mode, title: "", paint: () => ({}), legend: () => [] };
}
