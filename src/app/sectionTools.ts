/**
 * A window header's tools (index.html, .section-tools): one row that never
 * wraps, so the header (and the window under it) never changes height. What
 * doesn't fit scrolls sideways: a mouse wheel scrolls it too, and a fade
 * marks the side with more (styles.css: more-left, more-right).
 */
export function scrollableTools(row: HTMLElement): () => void {
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle("more-left", row.scrollLeft > 1);
    row.classList.toggle("more-right", row.scrollLeft < max - 1);
  };
  row.addEventListener("scroll", update, { passive: true });
  // An up-and-down wheel scrolls the row sideways (a trackpad's sideways swipe already does).
  row.addEventListener(
    "wheel",
    (event) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
      update();
    },
    { passive: false },
  );
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(row);
  // Tabs and buttons come and go (a loop's tabs): check again when they do.
  if (typeof MutationObserver === "function")
    new MutationObserver(update).observe(row, { childList: true, subtree: true, attributes: true });
  update();
  return update;
}
