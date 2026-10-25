/**
 * Hover focus: a box's arrows and the boxes at their other ends stand out,
 * everything else steps back (styles.css, "Focus"). Works on the SVG on
 * screen and on a drawing alike.
 */

/** A drawing focus can be shown on: the SVG on screen, or a drawing (a Mark). */
export interface Focusable {
  readonly classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): boolean;
  };
  getAttribute(name: string): string | null;
  querySelector(selector: string): Focusable | null;
  querySelectorAll(selector: string): Iterable<Focusable>;
}

/**
 * Highlight one box's connections: its arrows (in and out) and the boxes at
 * their other ends. Everything else dims. Pass null to clear.
 */
export function applyFocus(svg: Focusable | null, key: string | null): void {
  if (!svg) return;
  for (const el of svg.querySelectorAll(".is-focus, .is-related")) el.classList.remove("is-focus", "is-related");
  const node = key ? svg.querySelector(`.node[data-node-key="${CSS.escape(key)}"]`) : null;
  svg.classList.toggle("has-focus", !!node);
  if (!node || !key) return;
  node.classList.add("is-focus");
  // Each arrow's parts: behind the boxes, and over them (memoryView/layout.ts).
  for (const arrow of svg.querySelectorAll(".ref-arrow, .ref-arrow-part")) {
    const from = arrow.getAttribute("data-from");
    const to = arrow.getAttribute("data-to");
    if (from !== key && to !== key) continue;
    arrow.classList.add("is-focus");
    const other = from === key ? to : from;
    svg.querySelector(`.node[data-node-key="${CSS.escape(other ?? "")}"]`)?.classList.add("is-related");
  }
}
