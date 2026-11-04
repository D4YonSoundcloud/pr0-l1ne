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

import { buildingWithout, Mark, type OmitRule, type TextMark } from "./drawing";

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

/**
 * From this level (outline) on, arrows are laid out straight or with one
 * bend instead of routed through the gaps (route.ts simpleRoutes): the
 * memory window lays its step out again when the zoom crosses it.
 */
export const SIMPLE_ARROWS_FROM: Lod = 3;

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

/** Does a class attribute have this class? Without splitting it (atLevel asks for every mark). */
function hasClass(classes: string | null | undefined, name: string): boolean {
  if (!classes) return false;
  for (let at = classes.indexOf(name); at >= 0; at = classes.indexOf(name, at + 1)) {
    const end = at + name.length;
    if ((at === 0 || classes[at - 1] === " ") && (end === classes.length || classes[end] === " ")) return true;
  }
  return false;
}
const SMALL_TEXT_LIST = [...SMALL_TEXT];
/** Answers by class attribute: a drawing's cells share a few (render/draw.ts makes each kind once). */
const smallTextAnswers = new Map<string, boolean>();
const hasSmallText = (classes: string | null | undefined) => {
  if (!classes) return false;
  let answer = smallTextAnswers.get(classes);
  if (answer === undefined) {
    answer = SMALL_TEXT_LIST.some((name) => hasClass(classes, name));
    if (smallTextAnswers.size > 5000) smallTextAnswers.clear();
    smallTextAnswers.set(classes, answer);
  }
  return answer;
};

/** Is this mark left out at this level? The same as styles.css's display: none for it. */
export function leftOut(m: Mark, lod: Lod, inNode: boolean, parent: Mark): boolean {
  if (lod >= 2 && m.localName === "text") return true;
  if (lod === 0) return false;
  const classes = m.getAttribute("class");
  if (hasSmallText(classes)) return true;
  if (m.localName === "text" && hasClass(parent.getAttribute("class"), "pointer")) return true;
  if (lod >= 3 && hasClass(classes, "arrow-tops")) return true;
  if (lod >= 4 && inNode && !hasClass(classes, "node-outline") && !hasClass(classes, "node-hit")) return true;
  return false;
}

/**
 * The drawing as it's drawn at a level: what the level hides (styles.css)
 * left out of it, so it's never put in the page or painted at all. The CSS
 * would hide it anyway; leaving it out saves making it. The drawing given
 * is untouched, so the renderer can draw it at another level later without
 * laying it out again.
 *
 * Each mark's result is kept on it (Mark.levelCopy) until it or a mark in
 * it changes, so a box or row kept from the last step (boxCache.ts,
 * rowCache.ts) is the same marks at this level too, and the patcher and
 * the paint skip it at once as they do at full detail. A mark that loses
 * nothing at this level is its own result, not a copy: a big grid drawn
 * as blocks (built at the level, buildAt) isn't copied at all.
 */
export function atLevel(drawing: Mark, lod: Lod): Mark {
  if (lod === 0) return drawing;
  return levelOf(drawing, lod);
}

function levelOf(m: Mark, lod: Lod): Mark {
  const kept = m.levelCopy(lod);
  if (kept) {
    // In the drawing before at this level too: the SVG patcher keeps its element.
    kept.isShared = true;
    return kept;
  }
  const node = m.localName === "g" && hasClass(m.getAttribute("class"), "node");
  const list = m.childNodes;
  let out: Mark | null = null;
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    let next: Mark | TextMark | null = child;
    if (child instanceof Mark) {
      if (leftOut(child, lod, node, m)) {
        // Not in the copy, but the copy depends on it: if it changes (to be shown, say), the copy is made again.
        child.noteDependedOn();
        next = null;
      } else next = levelOf(child, lod);
    }
    if (!out && next === child) continue;
    if (!out) {
      // The first child that's left out or changed: from here on it's a copy, with the children before as they are.
      out = m.shallowCopy();
      for (let j = 0; j < i; j++) keepChild(out, list[j]);
    }
    if (next === child) keepChild(out, child);
    else if (next) out.appendKept(next, true);
  }
  const result = out ?? m;
  m.keepLevelCopy(lod, result);
  return result;
}

/** A child of the drawing given, unchanged, in a copy: a mark as it is (still the drawing's); text as new text. */
function keepChild(out: Mark, child: Mark | TextMark): void {
  if (child instanceof Mark) out.appendKept(child, false);
  else out.append(child.textContent);
}

/**
 * The finest level a drawing could be at once the view is at this zoom,
 * whichever way it got there (lodFor's margin keeps the level it had a
 * little past each threshold): what to build it at (buildAt) so it never
 * has to be built again for more detail when it gets there.
 */
export function finestLodAt(zoom: number): Lod {
  return lodAt(zoom / (1 - MARGIN));
}

/**
 * Build a drawing at a level: marks the level leaves out whatever their
 * place (text from blocks on; small text from reduced on) are never made,
 * so building a big grid zoomed out doesn't make its 430,000 texts only to
 * leave them out. What depends on where a mark is (a pointer's name, the
 * inside of a box in overview) is still made and left out by atLevel, so
 * atLevel(buildAt(lod, build), lod) is atLevel(build(), lod), mark for
 * mark (lod.test.ts). The drawing is drawn at this level or one with less
 * detail; drawn with more, it must be built again (builtAt).
 */
export function buildAt(lod: Lod, build: () => Mark): Mark {
  const drawing = buildingWithout(omitRules[lod], build);
  built.set(drawing, lod);
  return drawing;
}

/** Say what level a drawing was built at, for one built elsewhere (laid out in the layout worker, render/wire.ts). */
export function markBuiltAt(drawing: Mark, lod: Lod): void {
  if (lod) built.set(drawing, lod);
  else built.delete(drawing);
}

/** The level a drawing was built at (buildAt): 0, full, unless it was built at another. */
export function builtAt(drawing: Mark): Lod {
  return built.get(drawing) ?? 0;
}
const built = new WeakMap<Mark, Lod>();

const omitRules: (OmitRule | null)[] = [
  null,
  (_tag, classes) => hasSmallText(classes),
  (tag, classes) => tag === "text" || hasSmallText(classes),
  (tag, classes) => tag === "text" || hasSmallText(classes) || hasClass(classes, "arrow-tops"),
  (tag, classes) => tag === "text" || hasSmallText(classes) || hasClass(classes, "arrow-tops"),
];
