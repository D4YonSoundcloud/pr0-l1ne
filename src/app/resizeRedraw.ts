/**
 * Redrawing when the windows change size, without redrawing on every
 * pixel of a drag. Dragging a divider (or a window) resizes the windows
 * many times a second, and a redraw is a whole step's scene, layout and
 * drawing: with a big program that's tens or hundreds of milliseconds each
 * time, and the drawings thrown away pile up faster than they're collected.
 *
 * Only the shape of the windows changes what's drawn (a window taller than
 * wide draws very wide graphs top to bottom, see autoFit.ts's isTall);
 * everything else about a new size is the viewport's job, which just moves
 * the drawing. So this waits until the resizing pauses, then redraws only
 * if that shape is different from the one last drawn.
 */
export interface ResizeRedrawOptions {
  /** What about the windows' sizes changes the drawing, as a string ("tall|wide"). */
  shape(): string;
  redraw(): void;
  /** How long resizing must pause before a redraw, in ms. */
  wait?: number;
  setTimeout?(callback: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}

/** Call the returned function on every resize; it redraws at most once per pause, and only for a new shape. */
export function resizeRedraw(options: ResizeRedrawOptions): () => void {
  const wait = options.wait ?? 150;
  const set = options.setTimeout ?? ((callback, ms) => window.setTimeout(callback, ms));
  const clear = options.clearTimeout ?? ((id) => window.clearTimeout(id));
  let drawn = options.shape();
  let timer: number | null = null;
  return () => {
    if (timer !== null) clear(timer);
    timer = set(() => {
      timer = null;
      const now = options.shape();
      if (now === drawn) return;
      drawn = now;
      options.redraw();
    }, wait);
  };
}
