/**
 * Levels of detail: how much of a drawing is drawn at a zoom. Zoomed out,
 * most of a drawing is too small to read (13 px text at 25% is 3 px tall)
 * but costs as much to draw as ever, so each level leaves out what's become
 * too small, and draws what's left more simply:
 *
 *   0 full      everything
 *   1 reduced   no small text: index numbers, sizes, labels, pointer names
 *               (a SQL stage's notes stay: they say what the stage did)
 *   2 blocks    no text at all: cells are blocks colored by their value's
 *               type (or a heatmap's colors), without borders
 *   3 outline   blocks still (a grid or heatmap keeps its picture); arrows
 *               thin lines without heads; landmarks (the call stack and the
 *               biggest structures' names) stay readable over the drawing
 *   4 overview  each box one rectangle in its kind's color, arrows faint
 *
 * The level is a class (lod-0 to lod-4) on what holds the drawing: the SVG
 * renderer's layer, or the canvas renderer's style probe, so the same CSS
 * (styles.css, "Levels of detail") decides what each level shows in both.
 * It's a property of the view, never of the drawing: changing it redraws
 * nothing in SVG, and in canvas only paints again.
 */

import { Mark } from "./drawing";

export type Lod = 0 | 1 | 2 | 3 | 4;

export const LOD_NAMES = ["full", "reduced", "blocks", "outline", "overview"] as const;

/** The zoom each level starts below: under 60% is reduced, under 35% blocks... */
export const LOD_BELOW = [0.6, 0.35, 0.12, 0.03] as const;

/** How far past a threshold the zoom must go to change level, either way, so zooming slowly across one doesn't flicker. */
const MARGIN = 0.1;

/** The level for a zoom, without hysteresis. */
export function lodAt(zoom: number): Lod {
  let level = 0;
  while (level < LOD_BELOW.length && zoom < LOD_BELOW[level]) level++;
  return level as Lod;
}

/**
 * The level for a zoom, given the level it's at now: it changes only when
 * the zoom is past the threshold by MARGIN (10%) of it.
 */
export function lodFor(zoom: number, current: Lod | null = null): Lod {
  const plain = lodAt(zoom);
  if (current === null || plain === current) return plain;
  const below: readonly number[] = LOD_BELOW;
  if (plain > current) {
    // Zooming out: past the threshold below the current level by the margin.
    return zoom < below[current] * (1 - MARGIN) ? lodAt(zoom / (1 - MARGIN)) : current;
  }
  // Zooming in: above the threshold the current level started at by the margin.
  return zoom >= below[current - 1] * (1 + MARGIN) ? lodAt(zoom / (1 + MARGIN)) : current;
}

export const lodClass = (lod: Lod) => `lod-${lod}`;

/** Put an element at a level: the lod-N class, and no other. */
export function setLodClass(el: Element, lod: Lod): void {
  for (let n = 0; n < 5; n++) el.classList.toggle(`lod-${n}`, n === lod);
}

/** A landmark: a name kept readable when the drawing is too small to read (overview). */
export interface Landmark {
  /** Where it's pinned, in diagram units: a box's top-left corner. */
  x: number;
  y: number;
  text: string;
  /** "frame" (the call stack) or "object" (a big structure). */
  kind: string;
}

/** The landmarks a drawing carries (memoryView/layout.ts puts them in data-landmarks on its root); none if it has none. */
export function landmarksIn(drawing: { getAttribute(name: string): string | null }): Landmark[] {
  const json = drawing.getAttribute("data-landmarks");
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Small text, left out from reduced on (styles.css hides the same at each level). */
const SMALL_TEXT = new Set([
  "index",
  "seq-label",
  "mem-size",
  "cell-size",
  "box-size",
  "arrow-label",
  "interval-text",
  "region-label",
  "box-empty",
  "arrow-legend",
]);

const classesOf = (m: Mark) => (m.getAttribute("class") ?? "").split(" ");

/** Is this mark left out at this level? The same as styles.css's display: none for it. */
function leftOut(m: Mark, lod: Lod, inNode: boolean, parent: Mark): boolean {
  if (lod >= 2 && m.localName === "text") return true;
  const classes = classesOf(m);
  if (lod >= 1 && classes.some((c) => SMALL_TEXT.has(c))) return true;
  if (lod >= 1 && m.localName === "text" && classesOf(parent).includes("pointer")) return true;
  if (lod >= 3 && classes.includes("arrow-tops")) return true;
  if (lod >= 4 && inNode && !classes.includes("node-outline") && !classes.includes("node-hit")) return true;
  return false;
}

/**
 * The drawing as it's drawn at a level: what the level hides (styles.css)
 * left out of it, so it's never put in the page or painted at all. The CSS
 * would hide it anyway; leaving it out saves making it. A new drawing:
 * the one given is untouched, so the renderer can draw it at another level
 * later without laying it out again.
 */
export function atLevel(drawing: Mark, lod: Lod): Mark {
  if (lod === 0) return drawing;
  const copy = (m: Mark): Mark => {
    const out = new Mark(m.localName);
    for (const [name, value] of m.attributeEntries()) if (name !== "style") out.setAttribute(name, value);
    for (const [name, value] of m.styleProperties) out.style.setProperty(name, value);
    const node = m.localName === "g" && classesOf(m).includes("node");
    for (const child of m.childNodes) {
      if (child instanceof Mark) {
        if (!leftOut(child, lod, node, m)) out.append(copy(child));
      } else out.append(child.textContent);
    }
    return out;
  };
  return copy(drawing);
}
