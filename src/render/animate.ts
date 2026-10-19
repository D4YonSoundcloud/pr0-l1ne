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

interface Spot {
  x: number;
  y: number;
}

export interface Snapshot {
  flips: Map<string, Spot>;
  /** container -> slot -> { value, position } */
  cells: Map<string, Map<string, { value: string; spot: Spot }>>;
}

const num = (el: { getAttribute(name: string): string | null }, name: string) => Number(el.getAttribute(name) ?? 0);

/** Remember where everything is in a rendered diagram. */
/** What snapshot() reads: the SVG on screen, or a drawing (drawing.ts). */
interface Findable {
  querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null }>;
}

export function snapshot(root: Findable | null): Snapshot | null {
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
export const ENTER_SLIDE = 10;

/**
 * What a step's animation does: things that moved slide from where they
 * were, and new things arrive. Shared by both renderers: the SVG renderer
 * plays it with the Web Animations API (transition, below), the canvas
 * renderer with its own tweens (render/canvas/motion.ts).
 */
export type Move<E> = { el: E; kind: "slide"; dx: number; dy: number } | { el: E; kind: "arrive" };

/** Where an element of a drawing is, and what it is, for planning (see `domItem`). */
export interface Animatable<E> {
  el: E;
  flip?: { key: string; x: number; y: number; noFade: boolean };
  cell?: { key: string; value: string; cx: number; cy: number };
}

/** Plan the moves from `before` to the drawing's elements (in drawing order). */
export function plan<E>(before: Snapshot, items: Iterable<Animatable<E>>): Move<E>[] {
  const moves: Move<E>[] = [];
  const slide = (el: E, dx: number, dy: number) => {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    moves.push({ el, kind: "slide", dx, dy });
  };
  const cells: Animatable<E>[] = [];
  for (const item of items) {
    if (item.cell) cells.push(item);
    if (!item.flip) continue;
    const was = before.flips.get(item.flip.key);
    if (!was) {
      if (!item.flip.noFade) moves.push({ el: item.el, kind: "arrive" });
      continue;
    }
    slide(item.el, was.x - item.flip.x, was.y - item.flip.y);
  }

  // A value that left one slot of a container and arrived in another slid
  // there: animate it from its old slot.
  const used = new Set<string>();
  for (const item of cells) {
    const cell = item.cell!;
    const [container, slot] = splitCell(cell.key);
    const old = before.cells.get(container);
    if (!old || old.get(slot)?.value === cell.value) continue;
    let moved = false;
    for (const [oldSlot, was] of old) {
      const id = `${container}|${oldSlot}`;
      if (oldSlot === slot || used.has(id) || was.value !== cell.value) continue;
      used.add(id);
      slide(item.el, was.spot.x - cell.cx, was.spot.y - cell.cy);
      moved = true;
      break;
    }
    // A slot the list didn't have a step ago (it grew): arrive like a new box.
    if (!moved && !old.has(slot)) moves.push({ el: item.el, kind: "arrive" });
  }
  return moves;
}

/** The animatable elements of an SVG drawing, in document order. */
function* domItems(root: ParentNode): Generator<Animatable<Element>> {
  for (const el of root.querySelectorAll("[data-flip], [data-cell]")) {
    const item: Animatable<Element> = { el };
    const flip = el.getAttribute("data-flip");
    if (flip !== null)
      item.flip = { key: flip, x: num(el, "data-x"), y: num(el, "data-y"), noFade: el.hasAttribute("data-no-fade") };
    const cell = el.getAttribute("data-cell");
    if (cell !== null)
      item.cell = {
        key: cell,
        value: el.getAttribute("data-value") ?? "",
        cx: num(el, "data-cx"),
        cy: num(el, "data-cy"),
      };
    yield item;
  }
}

export function transition(
  before: Snapshot | null,
  root: ParentNode | null,
  duration: number,
  easing = DEFAULT_EASING,
  enter: Enter = { fade: true, slide: false },
): void {
  if (!before || !root || duration <= 0) return;
  for (const move of plan(before, domItems(root))) {
    const el = move.el;
    if (move.kind === "slide") {
      el.animate([{ transform: `translate(${move.dx}px, ${move.dy}px)` }, { transform: "translate(0px, 0px)" }], {
        duration,
        easing,
      });
      continue;
    }
    if (enter.fade)
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing: "ease-out", fill: "backwards" });
    if (enter.slide) {
      el.animate([{ transform: `translate(${-ENTER_SLIDE}px, 0px)` }, { transform: "translate(0px, 0px)" }], {
        duration,
        easing,
        fill: "backwards",
      });
    }
  }
}
