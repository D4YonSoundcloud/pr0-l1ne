/**
 * How the memory view colors its arrows, and what else it draws with them
 * (Style → Arrows): the mode (scene/arrowColors.ts), the legend, and field
 * names on arrows. Like spacing.ts, the layout reads the current values
 * here; the Style panel changes them and the app redraws the step.
 */
import type { ArrowColorMode } from "../scene/arrowColors";

export interface ArrowStyle {
  mode: ArrowColorMode;
  legend: boolean;
  labels: boolean;
}

export const arrowStyle: ArrowStyle = { mode: "kind", legend: true, labels: false };

/** Set how arrows are drawn. True if that changes the drawing (so the step should be redrawn). */
export function setArrowStyle(next: ArrowStyle): boolean {
  const changed =
    next.mode !== arrowStyle.mode || next.legend !== arrowStyle.legend || next.labels !== arrowStyle.labels;
  Object.assign(arrowStyle, next);
  return changed;
}
