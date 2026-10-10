/**
 * Tweening between two renders of a diagram (the FLIP technique).
 *
 * Every step draws a fresh SVG. To animate, we remember where things were
 * in the old drawing, then animate each element in the new drawing from
 * there to where it is now. Positions are read from data attributes the
 * renderers write (diagram units), never measured from the page, so a step
 * never forces a layout. Only `transform` and `opacity` are animated, which
 * browsers can do without repainting the rest of the diagram.
 *
 * What moves:
 *   [data-flip="key"] with data-x / data-y     boxes, pointer markers,
 *                                              linked nodes: slide by key
 *   [data-cell="container:slot"] with          values: when a value moved
 *     data-value, data-cx / data-cy            between slots of the same
 *                                              container (a swap), it slides
 *                                              from its old slot
 * New elements, and new slots in a list that grew, arrive as the window's
 * settings say: fading in, sliding in from the left, both, or neither.
 * Arrows are left alone: they're drawn where they end up, with no fade,
 * because fading every arrow on every step is more distracting than helpful.
 */

interface Spot { x: number; y: number }

export interface Snapshot {
  flips: Map<string, Spot>;
  /** container -> slot -> { value, position } */
  cells: Map<string, Map<string, { value: string; spot: Spot }>>;
}

const num = (el: Element, name: string) => Number(el.getAttribute(name) ?? 0);

/** Remember where everything is in a rendered diagram. */
export function snapshot(root: ParentNode | null): Snapshot | null {
  if (!root) return null;
  const flips = new Map<string, Spot>();
  for (const el of root.querySelectorAll("[data-flip]")) {
    flips.set(el.getAttribute("data-flip")!, { x: num(el, "data-x"), y: num(el, "data-y") });
  }
  const cells = new Map<string, Map<string, { value: string; spot: Spot }>>();
  for (const el of root.querySelectorAll("[data-cell]")) {
    const [container, slot] = splitCell(el.getAttribute("data-cell")!);
    if (!cells.has(container)) cells.set(container, new Map());
    cells.get(container)!.set(slot, {
      value: el.getAttribute("data-value") ?? "",
      spot: { x: num(el, "data-cx"), y: num(el, "data-cy") },
    });
  }
  return { flips, cells };
}

function splitCell(key: string): [string, string] {
  const at = key.lastIndexOf("|");
  return [key.slice(0, at), key.slice(at + 1)];
}

export const DEFAULT_EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

/** Animate `root`'s elements from their places in `before` to where they are now. */
/** How things that weren't in the previous drawing arrive. */
export interface Enter {
  fade: boolean;
  slide: boolean;
}

/** How far new things slide in from, in pixels. */
const ENTER_SLIDE = 10;

export function transition(before: Snapshot | null, root: ParentNode | null, duration: number, easing = DEFAULT_EASING, enter: Enter = { fade: true, slide: false }): void {
  if (!before || !root || duration <= 0) return;
  const slide = (el: Element, dx: number, dy: number) => {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
      { duration, easing },
    );
  };
  const arrive = (el: Element) => {
    if (enter.fade) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing: "ease-out", fill: "backwards" });
    if (enter.slide) {
      el.animate([{ transform: `translate(${-ENTER_SLIDE}px, 0px)` }, { transform: "translate(0px, 0px)" }], { duration, easing, fill: "backwards" });
    }
  };

  for (const el of root.querySelectorAll("[data-flip]")) {
    const was = before.flips.get(el.getAttribute("data-flip")!);
    if (!was) {
      if (!el.hasAttribute("data-no-fade")) arrive(el);
      continue;
    }
    slide(el, was.x - num(el, "data-x"), was.y - num(el, "data-y"));
  }

  // A value that left one slot of a container and arrived in another slid
  // there: animate it from its old slot.
  const used = new Set<string>();
  for (const el of root.querySelectorAll("[data-cell]")) {
    const [container, slot] = splitCell(el.getAttribute("data-cell")!);
    const value = el.getAttribute("data-value") ?? "";
    const old = before.cells.get(container);
    if (!old || old.get(slot)?.value === value) continue;
    let moved = false;
    for (const [oldSlot, cell] of old) {
      const id = `${container}|${oldSlot}`;
      if (oldSlot === slot || used.has(id) || cell.value !== value) continue;
      used.add(id);
      slide(el, cell.spot.x - num(el, "data-cx"), cell.spot.y - num(el, "data-cy"));
      moved = true;
      break;
    }
    // A slot the list didn't have a step ago (it grew): arrive like a new box.
    if (!moved && !old.has(slot)) arrive(el);
  }

}

/** True when the person has asked for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
