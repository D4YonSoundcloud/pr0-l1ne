/**
 * The page for the kind of language in the editor (languages.ts, `kind`):
 *
 *   program  Python, JavaScript, TypeScript: memory and loop history,
 *            Complexity and Measure
 *   query    SQL: the tables at each stage of a query, and its stages.
 *            Measure and Complexity count lines and loops, which a query
 *            doesn't have, and the memory window's choices are about
 *            variables and objects: those are hidden (styles.css, by the
 *            page's data-kind).
 */
export type LanguageKind = "program" | "query";

const TITLES: Record<LanguageKind, { memory: string; loop: string; memoryView: string; loopView: string }> = {
  program: { memory: "Memory", loop: "Loop history", memoryView: "Memory", loopView: "Loops" },
  query: { memory: "Tables", loop: "Query steps", memoryView: "Tables", loopView: "Steps" },
};

export function showLanguageKind(kind: LanguageKind, doc: Document = document): void {
  doc.documentElement.dataset.kind = kind;
  const titles = TITLES[kind];
  const set = (selector: string, text: string) => {
    const el = doc.querySelector(selector);
    if (el) el.textContent = text;
  };
  set("#memory-title", titles.memory);
  set("#loop-title", titles.loop);
  // A folded window's bar (app/layout.ts) shows its name too.
  set("#memory-section .window-bar-label", titles.memory);
  set("#loop-section .window-bar-label", titles.loop);
  set('.view-choice[data-view="memory"]', titles.memoryView);
  set('.view-choice[data-view="loop"]', titles.loopView);
}
