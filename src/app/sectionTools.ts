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

  /** Each tool's width when it was last on the row, to know whether it fits back. */
  const widths = new Map<HTMLElement, number>();
  const measure = () => {
    for (const el of items) if (row.contains(el)) widths.set(el, el.getBoundingClientRect().width);
  };
  /** The row's room left after its last tool. */
  const room = () => {
    const last = [...row.children].at(-1) as HTMLElement | undefined;
    const used = last ? last.getBoundingClientRect().right - row.getBoundingClientRect().left : 0;
    return row.clientWidth - used;
  };
  const GAP = 8;

  let observer: MutationObserver | null = null;
  /**
   * Fit the row, moving only the tools that have to move. A tool moved in
   * the page loses a click in progress (the press and the release have to
   * land on an element that stayed put), and this runs whenever the row's
   * text changes, which is every step while playing: so a tool already in
   * the right place is never touched.
   */
  const arrange = (again = true) => {
    observer?.disconnect();
    // A tool that moves keeps the keyboard focus it had.
    const focused =
      doc.activeElement instanceof HTMLElement && section.contains(doc.activeElement) ? doc.activeElement : null;
    measure();
    if (overflows()) {
      // Too wide: tools go into the menu from the end of the row until the rest fits.
      const onRow = items.filter((el) => row.contains(el));
      for (let i = onRow.length - 1; i >= 0 && overflows(); i--) menu.prepend(onRow[i]);
    } else {
      // Room again: tools come back from the start of the menu while each fits.
      for (;;) {
        const next = items.find((el) => menu.contains(el));
        if (!next) break;
        const width = shows(next) ? (widths.get(next) ?? Number.POSITIVE_INFINITY) : 0;
        if (width + GAP > room()) break;
        row.append(next);
        if (overflows()) {
          menu.prepend(next);
          break;
        }
      }
    }
    // Nothing in the menu that shows: everything back on the row, and no button.
    const inMenu = items.filter((el) => menu.contains(el));
    if (inMenu.length && !inMenu.some(shows)) row.append(...inMenu);
    const wasHidden = button.hidden;
    button.hidden = !items.some((el) => menu.contains(el));
    if (button.hidden) open(false);
    // The ⋯ button came or went: the row's room changed, so fit once more.
    if (again && wasHidden !== button.hidden) {
      arrange(false);
      return;
    }
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
