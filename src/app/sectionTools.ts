/**
 * A window header's tools (index.html, .section-tools) stay on one row, so
 * the header (and the window under it) never changes height. Whatever
 * doesn't fit goes into a menu: the header's ⋯ button opens it under the
 * header, with the tools that didn't fit in their usual order. Tools move
 * from the end of the row first, and come back as the window gets wider.
 *
 * The tools are moved, not copied, so every button keeps its id, its
 * listeners and its state, wherever it is.
 */
export interface ToolsMenu {
  /** Fit the row to the header again (it does this itself when the header resizes or the tools change). */
  arrange(): void;
  /** The ⋯ button. */
  readonly button: HTMLButtonElement;
  /** The menu the tools that don't fit go into. */
  readonly menu: HTMLElement;
  open(open?: boolean): void;
}

let uid = 0;

export function toolsMenu(row: HTMLElement, label = "More tools"): ToolsMenu {
  const doc = row.ownerDocument;
  const head = row.parentElement!;
  const section = head.parentElement!;
  const id = `tools-menu-${++uid}`;

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "tools-more";
  button.hidden = true;
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", id);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = "⋯";
  row.after(button);

  const menu = doc.createElement("div");
  menu.className = "tools-menu";
  menu.id = id;
  menu.hidden = true;
  menu.setAttribute("role", "group");
  menu.setAttribute("aria-label", label);
  section.append(menu);

  /** Every tool, in its order on the row. */
  const items = [...row.children] as HTMLElement[];

  const open = (on = menu.hidden) => {
    const show = on && !button.hidden;
    menu.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
    button.classList.toggle("is-open", show);
  };
  button.addEventListener("click", () => open());
  // Clicking outside closes it; clicking the tools in it doesn't (you may want to set several).
  doc.addEventListener("pointerdown", (event) => {
    if (menu.hidden) return;
    const target = event.target as Node;
    if (!menu.contains(target) && !button.contains(target)) open(false);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    open(false);
    button.focus();
  });

  const overflows = () => row.scrollWidth > row.clientWidth + 1;
  /** Hidden tools (the size model before Sizes is on; everything for SQL) don't need room. */
  const shows = (el: HTMLElement) => !el.hidden && doc.defaultView?.getComputedStyle(el).display !== "none";

  let observer: MutationObserver | null = null;
  const arrange = () => {
    observer?.disconnect();
    // A tool that moves keeps the keyboard focus it had.
    const focused =
      doc.activeElement instanceof HTMLElement && section.contains(doc.activeElement) ? doc.activeElement : null;
    // Everything back on the row, in order, then out again from the end until the rest fits.
    row.append(...items);
    button.hidden = true;
    if (overflows()) {
      button.hidden = false;
      for (let i = items.length - 1; i >= 0 && overflows(); i--) menu.prepend(items[i]);
    }
    // Nothing in the menu that shows: no button.
    const inMenu = items.filter((el) => menu.contains(el));
    if (!inMenu.some(shows)) {
      row.append(...inMenu);
      button.hidden = true;
    }
    if (button.hidden) open(false);
    if (focused && doc.activeElement !== focused && !menu.hidden === menu.contains(focused)) focused.focus();
    observe();
  };
  const observe = () => {
    if (typeof MutationObserver !== "function") return;
    observer ??= new MutationObserver(() => arrange());
    // Tabs, labels and counts come and go (a loop's tabs, the memory total).
    for (const target of [row, menu])
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(() => arrange()).observe(head);
  arrange();
  return { arrange, button, menu, open };
}
