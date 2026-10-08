/**
 * `# viz:` / `// viz:` hints: comments that tell the canvas how to draw a
 * program when the automatic choices aren't what you want.
 *
 * The tracers only collect hint comments (with their line numbers). This
 * module parses them, the same way for every language, and applies them to
 * a trace before it's drawn. See the README's "Hints" section.
 *
 *   viz: hide temp, scratch          don't draw these variables
 *   viz: show total, seen            always include these in loop history
 *   viz: pointers nums: lo, hi       draw lo and hi as positions in nums
 *   viz: pointers grid[]: col        ...or as a column in a grid
 *   viz: tree Node(left, right)      draw Node objects as a binary tree
 *   viz: list Node(next)             draw Node objects as a linked list
 */
import type { LinkedHint, RawHint, Trace, VizHints } from "./types";

const NAME = /^[A-Za-z_$][\w$]*$/;
const CONTAINER = /^([A-Za-z_$][\w$]*)(\[\])?$/;
const CLASS_LINKS = /^([A-Za-z_$][\w$.]*)\s*\(([^)]*)\)$/;

const KEYWORDS = ["hide", "show", "pointers", "tree", "list"] as const;

function names(text: string): string[] {
  return text.split(",").map((n) => n.trim()).filter(Boolean);
}

export function emptyHints(): VizHints {
  return { hide: [], show: [], pointers: {}, linked: [], warnings: [] };
}

/** Parse hint comments. Anything that doesn't make sense becomes a warning. */
export function parseHints(raw: RawHint[]): VizHints {
  const hints = emptyHints();
  const warn = (line: number, message: string) => hints.warnings.push({ line, message });

  for (const { line, text } of raw) {
    const match = /^([a-z]+)\b\s*(.*)$/i.exec(text);
    const keyword = match?.[1].toLowerCase() ?? "";
    const rest = match?.[2].trim() ?? "";
    if (!(KEYWORDS as readonly string[]).includes(keyword)) {
      warn(line, `Unknown hint "${text || "(empty)"}". Hints are: ${KEYWORDS.join(", ")}.`);
      continue;
    }

    if (keyword === "hide" || keyword === "show") {
      const list = names(rest);
      const bad = list.filter((n) => !NAME.test(n));
      if (!list.length || bad.length) {
        warn(line, `"${keyword}" needs variable names, like: viz: ${keyword} total, seen`);
        continue;
      }
      hints[keyword].push(...list);
      continue;
    }

    if (keyword === "pointers") {
      const [target, list] = rest.split(":").map((part) => part?.trim());
      const container = CONTAINER.exec(target ?? "");
      const pointerNames = names(list ?? "");
      if (!container || !pointerNames.length || pointerNames.some((n) => !NAME.test(n))) {
        warn(line, `"pointers" looks like: viz: pointers nums: lo, hi  (or grid[]: col for grid columns)`);
        continue;
      }
      const key = container[1] + (container[2] ?? "");
      hints.pointers[key] = [...new Set([...(hints.pointers[key] ?? []), ...pointerNames])];
      continue;
    }

    // tree / list
    const shape = CLASS_LINKS.exec(rest);
    const links = shape ? names(shape[2]) : [];
    const want = keyword === "tree" ? 2 : 1;
    if (!shape || links.length !== want || links.some((n) => !NAME.test(n))) {
      warn(line, keyword === "tree"
        ? `"tree" looks like: viz: tree Node(left, right)  (a class and its two child fields)`
        : `"list" looks like: viz: list Node(next)  (a class and its link field)`);
      continue;
    }
    const linked: LinkedHint = { shape: keyword as "tree" | "list", typeName: shape[1], links, line };
    hints.linked = [...hints.linked.filter((h) => h.typeName !== linked.typeName), linked];
  }
  return hints;
}

/**
 * Apply a trace's hints: hidden variables are removed from every step,
 * pointer hints join the index analysis, and the rest is kept on
 * `trace.viz` for the renderers.
 */
export function applyHints(trace: Trace): Trace {
  const viz = parseHints(trace.hints ?? []);
  if (!trace.hints?.length) return { ...trace, viz };

  const hidden = new Set(viz.hide);
  const steps = hidden.size
    ? trace.steps.map((step) => ({
      ...step,
      stack: step.stack.map((frame) => ({ ...frame, locals: frame.locals.filter(([name]) => !hidden.has(name)) })),
      suspended: step.suspended?.map((frame) => ({ ...frame, locals: frame.locals.filter(([name]) => !hidden.has(name)) })),
    }))
    : trace.steps;

  const indexNames = { ...trace.indexNames };
  for (const [key, list] of Object.entries(viz.pointers)) {
    indexNames[key] = [...new Set([...(indexNames[key] ?? []), ...list])].sort();
  }
  return { ...trace, steps, indexNames, viz };
}
