/**
 * atLevel as it was before its results were kept (lod.ts): the whole
 * drawing copied every time, leaving out what the level hides. The tests
 * hold the kept, built-at-a-level version to it.
 */
import { Mark } from "../render/drawing";
import { type Lod, leftOut } from "../render/lod";

export function atLevelReference(drawing: Mark, lod: Lod): Mark {
  if (lod === 0) return drawing;
  const copy = (m: Mark): Mark => {
    const out = m.shallowCopy();
    const node = m.localName === "g" && (m.getAttribute("class") ?? "").split(" ").includes("node");
    for (const child of m.childNodes) {
      if (child instanceof Mark) {
        if (!leftOut(child, lod, node, m)) out.append(copy(child));
      } else out.append(child.textContent);
    }
    return out;
  };
  return copy(drawing);
}
