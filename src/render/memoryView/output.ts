/**
 * Printed output in the memory view: on the step after a print, a console
 * card under the call stack, with arrows to the objects it printed.
 */
import type { Printed } from "../../trace/output";
import { FONT, HEADER_H, s } from "../draw";
import type { Shape } from "./shapes";

const OUTPUT_LINE_H = 18;
const OUTPUT_MAX_LINES = 12;

const OUTPUT_MAX_W = 360;

/** How wide the output card needs to be for the run's longest printed line (0 if it prints nothing, or output is off). */
export function outputWidth(longest: number | null): number {
  return longest === null ? 0 : Math.min(OUTPUT_MAX_W, Math.max(160, Math.ceil(longest * FONT * 0.6) + 24));
}

/**
 * The printed-output node: a console card titled with the line that printed.
 * It's as wide as the call stack's column, so it never reaches into the gap
 * where arrows run; long lines wrap.
 */
export function outputShape(printed: Printed, targets: string[], width: number): Shape {
  const title = `Printed on line ${printed.line}`;
  const charW = FONT * 0.6;
  const maxChars = Math.max(8, Math.floor((width - 24) / charW));
  // Wrap long lines (after a space or comma when there is one); show at
  // most a dozen, then say how many more.
  const lines: string[] = [];
  for (const raw of printed.text.split("\n")) {
    let rest = raw;
    while (rest.length > maxChars) {
      const cut = Math.max(rest.lastIndexOf(" ", maxChars), rest.lastIndexOf(",", maxChars - 1) + 1);
      const at = cut > maxChars / 3 ? cut : maxChars;
      lines.push(rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
    }
    lines.push(rest);
  }
  const shown =
    lines.length > OUTPUT_MAX_LINES
      ? [...lines.slice(0, OUTPUT_MAX_LINES - 1), `… ${lines.length - OUTPUT_MAX_LINES + 1} more lines`]
      : lines;
  const w = width;
  const h = HEADER_H + 8 + shown.length * OUTPUT_LINE_H + 6;
  return {
    w,
    h,
    inY: HEADER_H / 2,
    draw(x, y, layer, refs) {
      const g = s("g", { class: "box output-box" });
      g.append(
        s("rect", { class: "output-body", x, y, width: w, height: h, rx: 6 }),
        s("text", { class: "output-title", x: x + 10, y: y + HEADER_H / 2 + 1, "dominant-baseline": "central" }, title),
        s("line", { class: "output-rule", x1: x + 8, x2: x + w - 8, y1: y + HEADER_H, y2: y + HEADER_H }),
      );
      shown.forEach((line, i) => {
        const more = i === OUTPUT_MAX_LINES - 1 && lines.length > OUTPUT_MAX_LINES;
        g.append(
          s(
            "text",
            {
              class: more ? "output-text is-more" : "output-text",
              x: x + 12,
              y: y + HEADER_H + 8 + i * OUTPUT_LINE_H + OUTPUT_LINE_H / 2,
              "dominant-baseline": "central",
            },
            line,
          ),
        );
      });
      layer.append(g);
      // An arrow to each printed object, leaving from the right edge.
      targets.forEach((target, i) => {
        refs.push({
          from: { x: x + w, y: y + HEADER_H / 2 + Math.min(i, 3) * 6 },
          target,
          changed: false,
          printed: true,
        });
      });
    },
  };
}
