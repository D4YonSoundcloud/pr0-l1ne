/**
 * "Save SVG" in each window's toolbar: the drawing on screen as a vector
 * file (render/export.ts), whichever renderer is drawing it.
 */
import { download } from "../render/export";
import type { Renderer } from "../scene/renderer";

/** "Bubble sort" + "memory" + step index 11 -> "bubble-sort-memory-step-12.svg" (steps are counted from 1 on screen). */
export function svgFileName(program: string | null, pane: "memory" | "loop", step: number): string {
  const slug = (program ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // é -> e
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const what = pane === "memory" ? "memory" : "loop-history";
  return `${slug || "pr0l1ne"}-${what}-step-${step + 1}.svg`;
}

/** Add the button to a window. `name` gives the file name at the moment it's clicked. */
export function addSaveSvg(
  renderer: Pick<Renderer<unknown>, "addControl" | "toSVG">,
  name: () => string,
  save: (name: string, text: string) => void = download,
): HTMLButtonElement {
  return renderer.addControl(
    "Save SVG",
    "Save this diagram as an SVG file: a vector picture that stays sharp at any size and opens in drawing apps",
    () => {
      const svg = renderer.toSVG();
      if (svg) save(name(), svg);
    },
  );
}
