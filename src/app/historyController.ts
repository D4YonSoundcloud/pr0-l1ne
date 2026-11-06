/**
 * A value's history, from the memory window: hover a variable or a cell
 * and a card shows its values over the whole run (a sparkline when they're
 * numbers, a list when they're not), where it is now, and the changes
 * before and after this step; click a point to go to that step. Clicking
 * the variable or cell itself goes to the next step where it changes
 * (Shift: the change before). The Changes list's names open the same card,
 * from the keyboard too. Its head has ◀ ▶ (the change before and after),
 * a pin and ×; dragged by its head, it moves and is pinned there. Pinned
 * cards stay as the steps go by, and through a new run that still has
 * their value, until they're closed; several can be pinned at once. What's
 * pressed on a card never reaches what's under it. The history is worked out where the trace is (the
 * layout worker, trace/history.ts), once per value per run.
 */
import type { LayoutService } from "../layout/service";
import { type HistoryPoint, targetKey, type ValueHistory, type ValueTarget } from "../trace/history";
import type { AppStore } from "./state";

export interface HistoryOptions {
  app: AppStore;
  layout: Pick<LayoutService, "history">;
  /** Go to a step (PlaybackController.goTo). */
  goTo(step: number): void;
  /** The timeline's first step (PlaybackController.firstStep). */
  firstStep(): number;
  /** Where the card goes (the page's body). */
  host: HTMLElement;
  /** How long the pointer rests on a value before its card shows, in ms (tests pass 0). */
  hoverDelay?: number;
}

/** The sparkline's size, in pixels. */
const WIDTH = 248;
const HEIGHT = 56;
const PAD = 6;
/** Up to this many changes, each is drawn as a dot (more: the line alone). */
const DOTS = 60;
/** The list shows this many changes around the step on screen. */
const LIST_ROWS = 9;

/** An open card: the value it follows, its history, and whether it's pinned (stays put, across steps). */
interface Card {
  el: HTMLElement;
  target: ValueTarget;
  history: ValueHistory;
  pinned: boolean;
}

/** A card moves this far before a press on its head counts as a drag. */
const DRAG_FROM = 3;
/** A key press on a card's head moves it by this much. */
const KEY_STEP = 16;

export class HistoryController {
  /** Histories asked for in this run, by value. */
  private readonly histories = new Map<string, Promise<ValueHistory>>();
  /** The card that follows the pointer: shown on hover, gone when it leaves. */
  private hovered: Card | null = null;
  /** Cards pinned in place: they stay, across steps and runs, until closed. */
  private readonly pinned: Card[] = [];
  private hoverTimer = 0;
  private closeTimer = 0;
  /** The value the pointer's resting on (for the hover delay). */
  private resting: string | null = null;
  /** Requests made, to show only the last one's card. */
  private asked = 0;

  constructor(private readonly options: HistoryOptions) {
    const { app } = options;
    // A new run: every value's history is another one. Pinned cards follow theirs into it, if it's there.
    app.watch(
      (s) => s.trace,
      (trace) => {
        this.histories.clear();
        this.close();
        if (trace) void this.refreshPinned();
        else for (const card of [...this.pinned]) this.closeCard(card);
      },
    );
    // Another step: where it is now, on each card.
    app.watch(
      (s) => s.stepIndex,
      () => this.renderAll(),
    );
    // A smaller window: pinned cards kept inside it.
    window.addEventListener("resize", () => {
      for (const card of this.pinned) this.moveTo(card, card.el.offsetLeft, card.el.offsetTop);
    });
  }

  /** The value's history (asked of the layout once per run). */
  history(target: ValueTarget): Promise<ValueHistory> {
    const key = targetKey(target);
    let found = this.histories.get(key);
    if (!found) {
      found = this.options.layout.history(target, this.options.app.get().stepIndex);
      this.histories.set(key, found);
    }
    return found;
  }

  /** The pointer is over a value (or none): its card shows once it rests there. */
  hover(target: ValueTarget | null, clientX: number, clientY: number): void {
    const key = target ? targetKey(target) : null;
    if (key === this.resting) {
      if (key) window.clearTimeout(this.closeTimer);
      return;
    }
    this.resting = key;
    window.clearTimeout(this.hoverTimer);
    if (!target) {
      this.closeSoon();
      return;
    }
    window.clearTimeout(this.closeTimer);
    if (this.hovered && targetKey(this.hovered.target) === key) return;
    if (this.pinnedFor(target)) return; // its card's already on screen
    this.hoverTimer = window.setTimeout(
      () => void this.show(target, { x: clientX, y: clientY }),
      this.options.hoverDelay ?? 350,
    );
  }

  /** Go to the next step where a value changes (`back`: the change before this step); nothing when there's none that way. */
  async jump(target: ValueTarget, back: boolean): Promise<void> {
    const { points } = await this.history(target);
    const step = changeFrom(points, this.options.app.get().stepIndex, back, this.options.firstStep());
    if (step !== null) this.options.goTo(step);
  }

  /** Open a value's card at a point, or beside an element (the Changes list's name). A pinned one's is pointed out instead. */
  async show(target: ValueTarget, at: { x: number; y: number } | HTMLElement): Promise<void> {
    const asked = ++this.asked;
    const history = await this.history(target);
    if (asked !== this.asked || !this.options.app.get().trace) return;
    const pinned = this.pinnedFor(target);
    if (pinned) {
      this.closeHovered();
      pinned.el.classList.remove("is-pointed-out");
      void pinned.el.offsetWidth; // restart its flash
      pinned.el.classList.add("is-pointed-out");
      return;
    }
    const card = this.hovered ?? this.newCard(target, history);
    card.target = target;
    card.history = history;
    this.hovered = card;
    this.render(card);
    card.el.hidden = false;
    this.place(card.el, at);
  }

  /** Is a card open (pinned or not)? */
  get isOpen(): boolean {
    return this.hovered !== null || this.pinned.length > 0;
  }

  /** How many cards are pinned. */
  get pinnedCount(): number {
    return this.pinned.length;
  }

  /** Close the card that follows the pointer; pinned cards stay. */
  close(): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.closeTimer);
    this.resting = null;
    this.closeHovered();
  }

  /** Pin a card where it is (or unpin it: then it goes once the pointer leaves it). */
  setPinned(card: Card, pinned: boolean): void {
    if (card.pinned === pinned) return;
    card.pinned = pinned;
    if (pinned) {
      if (this.hovered === card) this.hovered = null;
      this.pinned.push(card);
    } else {
      this.pinned.splice(this.pinned.indexOf(card), 1);
      this.closeHovered();
      this.hovered = card;
    }
    this.render(card);
  }

  private pinnedFor(target: ValueTarget): Card | undefined {
    const key = targetKey(target);
    return this.pinned.find((c) => targetKey(c.target) === key);
  }

  private closeHovered(): void {
    const card = this.hovered;
    if (!card) return;
    this.hovered = null;
    card.el.remove();
  }

  private closeCard(card: Card): void {
    if (card === this.hovered) {
      this.close();
      return;
    }
    const at = this.pinned.indexOf(card);
    if (at >= 0) this.pinned.splice(at, 1);
    card.el.remove();
  }

  /** After a new run: each pinned card's value again, or the card goes when the run hasn't got it. */
  private async refreshPinned(): Promise<void> {
    for (const card of [...this.pinned]) {
      const history = await this.history(card.target);
      if (!this.pinned.includes(card)) continue;
      if (!history.points.length) this.closeCard(card);
      else {
        card.history = history;
        this.render(card);
      }
    }
  }

  /** The pointer left the value: close unless it comes to the card (or back) soon. */
  private closeSoon(): void {
    window.clearTimeout(this.closeTimer);
    if (this.hovered) this.closeTimer = window.setTimeout(() => this.close(), 300);
  }

  private newCard(target: ValueTarget, history: ValueHistory): Card {
    const el = document.createElement("div");
    el.className = "history-card";
    el.setAttribute("role", "dialog");
    el.hidden = true;
    const card: Card = { el, target, history, pinned: false };
    el.addEventListener("pointerenter", () => {
      if (card === this.hovered) window.clearTimeout(this.closeTimer);
    });
    el.addEventListener("pointerleave", () => {
      if (card !== this.hovered) return;
      this.resting = null;
      this.closeSoon();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.closeCard(card);
      }
    });
    // What's pressed on the card is the card's: never the window, the canvas or its buttons under it.
    for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel", "contextmenu"])
      el.addEventListener(type, (event) => event.stopPropagation());
    el.addEventListener("animationend", () => el.classList.remove("is-pointed-out"));
    this.dragByHead(card);
    this.options.host.append(el);
    return card;
  }

  /** Drag a card by its head (not its buttons) to move it; moving it pins it there. Arrow keys on the head move it too. */
  private dragByHead(card: Card): void {
    const el = card.el;
    let drag: { pointer: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    el.addEventListener("pointerdown", (event) => {
      const head = (event.target as Element).closest(".history-head");
      if (!head || (event.target as Element).closest("button") || event.button !== 0) return;
      event.preventDefault();
      // The card holds the pointer, not its head: the head's drawn again when it's pinned.
      el.setPointerCapture?.(event.pointerId);
      drag = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: el.offsetLeft,
        top: el.offsetTop,
        moved: false,
      };
    });
    el.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add("is-dragging");
        this.setPinned(card, true);
      }
      this.moveTo(card, drag.left + dx, drag.top + dy);
    });
    const end = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      drag = null;
      el.classList.remove("is-dragging");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("keydown", (event) => {
      if (!(event.target as Element).classList?.contains("history-head")) return;
      const by: Record<string, [number, number]> = {
        ArrowLeft: [-KEY_STEP, 0],
        ArrowRight: [KEY_STEP, 0],
        ArrowUp: [0, -KEY_STEP],
        ArrowDown: [0, KEY_STEP],
      };
      const move = by[event.key];
      if (!move) return;
      event.preventDefault();
      this.setPinned(card, true);
      this.moveTo(card, el.offsetLeft + move[0], el.offsetTop + move[1]);
    });
  }

  /** Put a card at a place on the page, kept inside the window. */
  private moveTo(card: Card, left: number, top: number): void {
    const w = card.el.offsetWidth || WIDTH + 24;
    const h = card.el.offsetHeight || 160;
    card.el.style.left = `${Math.round(Math.max(0, Math.min(left, window.innerWidth - w)))}px`;
    card.el.style.top = `${Math.round(Math.max(0, Math.min(top, window.innerHeight - h)))}px`;
  }

  /**
   * Beside where it was asked for, inside the window, and off the windows'
   * own buttons (zoom, minimize, maximize) and pinned cards when there's a place that is:
   * below and right of the point first, then above, then to its left.
   */
  private place(card: HTMLElement, at: { x: number; y: number } | HTMLElement): void {
    const r = at instanceof HTMLElement ? at.getBoundingClientRect() : null;
    const px = r ? r.left : (at as { x: number }).x;
    const py = r ? r.bottom : (at as { y: number }).y;
    const top0 = r ? r.top : py;
    const w = card.offsetWidth || WIDTH + 24;
    const h = card.offsetHeight || 160;
    const gap = r ? 4 : 14;
    const within = (left: number, top: number) => ({
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    });
    const tries = [
      within(r ? px : px + gap, py + gap),
      within(r ? px : px + gap, top0 - h - gap),
      within(px - w - gap, py + gap),
      within(px - w - gap, top0 - h - gap),
    ];
    const avoid = [
      ...document.querySelectorAll<HTMLElement>(
        ".viewport-controls, .window-button, .auto-fit-menu, .history-card.is-pinned",
      ),
    ]
      .filter((e) => !e.hidden)
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0);
    const clear = (p: { left: number; top: number }) =>
      avoid.every((b) => p.left + w <= b.left || p.left >= b.right || p.top + h <= b.top || p.top >= b.bottom);
    const below = py + gap + h <= window.innerHeight - 8;
    const order = below ? tries : [tries[1], tries[0], tries[3], tries[2]];
    const pick = order.find(clear) ?? order[0];
    card.style.left = `${Math.round(pick.left)}px`;
    card.style.top = `${Math.round(pick.top)}px`;
  }

  private renderAll(): void {
    if (this.hovered) this.render(this.hovered);
    for (const card of this.pinned) this.render(card);
  }

  /** Draw a card for the step on screen. */
  private render(card: Card): void {
    const { history, target, el: cardEl } = card;
    const { stepIndex, trace } = this.options.app.get();
    const total = trace?.steps ?? 0;
    const first = this.options.firstStep();
    const points = history.points;
    const changes = points.length;
    const el = (tag: string, className: string, text?: string) => {
      const e = document.createElement(tag);
      e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const keepFocus = cardEl.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.focusKey
      : undefined;

    // The head: what it is, how often it changes, and ◀ ▶ to its changes, out of the way of anything under the card's foot.
    const head = el("div", "history-head");
    head.tabIndex = 0;
    head.dataset.focusKey = "head";
    head.title = "Drag to move it (and pin it there); arrow keys move it too";
    const title = el("div", "history-title");
    title.append(
      el("code", "history-name", history.name),
      el(
        "span",
        "history-count",
        changes <= 1
          ? "never changes"
          : `${(changes - 1).toLocaleString()}${history.truncated ? "+" : ""} ${changes === 2 ? "change" : "changes"}`,
      ),
    );
    const prev = changeFrom(points, stepIndex, true, first);
    const next = changeFrom(points, stepIndex, false, first);
    const tools = el("div", "history-tools");
    const button = (className: string, text: string, label: string, onClick: () => void) => {
      const b = el("button", `history-tool ${className}`, text) as HTMLButtonElement;
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.dataset.focusKey = className.split(" ").at(-1);
      b.addEventListener("click", onClick);
      tools.append(b);
      return b;
    };
    for (const [className, text, label, step] of [
      ["history-prev", "◀", "The change before this step (Shift + click the value)", prev],
      ["history-next", "▶", "The next change (click the value)", next],
    ] as const) {
      const b = button(`history-go ${className}`, text, label, () => {
        if (step !== null) this.options.goTo(step);
      });
      b.disabled = step === null;
    }
    const pin = button(
      "history-pin",
      "",
      card.pinned ? "Unpin: it goes when the pointer leaves it" : "Pin it here: it stays as you step, until closed",
      () => this.setPinned(card, !card.pinned),
    );
    pin.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2h4l-.6 4 2.6 2.4V10H8.7L8 14l-.7-4H4V8.4L6.6 6z"/></svg>';
    pin.setAttribute("aria-pressed", String(card.pinned));
    button("history-close", "×", "Close", () => this.closeCard(card));
    head.append(title, tools);
    cardEl.setAttribute("aria-label", `History of ${history.name}`);
    cardEl.classList.toggle("is-pinned", card.pinned);

    const now = currentPoint(points, stepIndex);
    const body = numeric(points) ? this.sparkline(points, first, total, stepIndex) : this.list(points, now);
    const value = el("div", "history-now");
    value.textContent = now ? (now.gone ? "Now: gone" : `Now: ${now.value}`) : "Not set yet";
    cardEl.replaceChildren(head, value, body);
    cardEl.dataset.target = targetKey(target);
    if (keepFocus) cardEl.querySelector<HTMLElement>(`[data-focus-key="${keepFocus}"]`)?.focus();
  }

  /** Numbers over the run: a step line, a dot at each change (a few), where the step on screen is. */
  private sparkline(points: HistoryPoint[], first: number, total: number, at: number): HTMLElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "history-spark");
    svg.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
    svg.setAttribute("width", String(WIDTH));
    svg.setAttribute("height", String(HEIGHT));
    svg.setAttribute("role", "img");
    const nums = points.filter((p) => p.num !== null).map((p) => p.num as number);
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    const span = Math.max(1, total - 1 - first);
    const x = (step: number) => PAD + ((Math.max(first, step) - first) / span) * (WIDTH - 2 * PAD);
    const y = (v: number) => (hi === lo ? HEIGHT / 2 : HEIGHT - PAD - ((v - lo) / (hi - lo)) * (HEIGHT - 2 * PAD));
    svg.setAttribute(
      "aria-label",
      `From ${lo.toLocaleString()} to ${hi.toLocaleString()} over the run. Click to go to a change.`,
    );
    // The value holds until it next changes: a step line.
    let d = "";
    points.forEach((p, i) => {
      if (p.num === null) return;
      const end = i + 1 < points.length ? points[i + 1].step : total - 1;
      d += `M${x(p.step).toFixed(1)},${y(p.num).toFixed(1)}H${x(end).toFixed(1)}`;
      const nextP = points[i + 1];
      if (nextP && nextP.num !== null) d += `V${y(nextP.num).toFixed(1)}`;
    });
    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", d);
    line.setAttribute("class", "history-line");
    const marker = document.createElementNS(ns, "line");
    marker.setAttribute("class", "history-at");
    marker.setAttribute("x1", String(x(at)));
    marker.setAttribute("x2", String(x(at)));
    marker.setAttribute("y1", "0");
    marker.setAttribute("y2", String(HEIGHT));
    svg.append(line, marker);
    if (points.length <= DOTS)
      for (const p of points) {
        if (p.num === null) continue;
        const dot = document.createElementNS(ns, "circle");
        dot.setAttribute("class", p.step === currentPoint(points, at)?.step ? "history-dot is-now" : "history-dot");
        dot.setAttribute("cx", x(p.step).toFixed(1));
        dot.setAttribute("cy", y(p.num).toFixed(1));
        dot.setAttribute("r", "2.5");
        const title = document.createElementNS(ns, "title");
        title.textContent = `Step ${p.step + 1}: ${p.value}`;
        dot.append(title);
        svg.append(dot);
      }
    // A click anywhere goes to the change it's on (the last one at or before that point).
    svg.addEventListener("click", (event) => {
      const box = svg.getBoundingClientRect();
      const along = ((event.clientX - box.left) / (box.width || WIDTH)) * WIDTH;
      const step = first + ((along - PAD) / (WIDTH - 2 * PAD)) * span;
      const point = currentPoint(points, step) ?? points[0];
      if (point) this.options.goTo(Math.max(first, point.step));
    });
    const wrap = document.createElement("div");
    wrap.className = "history-body";
    const range = document.createElement("div");
    range.className = "history-range";
    range.textContent = `${lo.toLocaleString()} – ${hi.toLocaleString()}`;
    wrap.append(svg, range);
    return wrap;
  }

  /** Values that aren't numbers: the changes around the step on screen, each a button to its step. */
  private list(points: HistoryPoint[], now: HistoryPoint | null): HTMLElement {
    const ol = document.createElement("ol");
    ol.className = "history-list";
    const at = now ? points.indexOf(now) : 0;
    const start = Math.max(0, Math.min(at - Math.floor(LIST_ROWS / 2), points.length - LIST_ROWS));
    const shown = points.slice(start, start + LIST_ROWS);
    const more = (n: number, where: string) => {
      const li = document.createElement("li");
      li.className = "history-more";
      li.textContent = `… ${n.toLocaleString()} ${where}`;
      return li;
    };
    if (start > 0) ol.append(more(start, "earlier"));
    for (const p of shown) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = p === now ? "history-row is-now" : "history-row";
      const step = document.createElement("span");
      step.className = "history-step";
      step.textContent = `step ${(p.step + 1).toLocaleString()}`;
      const value = document.createElement("span");
      value.className = "history-value";
      value.textContent = p.gone ? "gone" : p.value;
      b.append(step, value);
      b.addEventListener("click", () => this.options.goTo(Math.max(this.options.firstStep(), p.step)));
      li.append(b);
      ol.append(li);
    }
    const after = points.length - start - shown.length;
    if (after > 0) ol.append(more(after, "later"));
    return ol;
  }
}

/** All its values are numbers (or it went), and there are at least two: a sparkline. */
function numeric(points: HistoryPoint[]): boolean {
  const values = points.filter((p) => !p.gone);
  return values.length >= 2 && values.every((p) => p.num !== null && Number.isFinite(p.num));
}

/** The change in effect at a step: the last one at or before it. */
export function currentPoint(points: HistoryPoint[], step: number): HistoryPoint | null {
  let found: HistoryPoint | null = null;
  for (const p of points) {
    if (p.step > step) break;
    found = p;
  }
  return found;
}

/**
 * The next step after `at` where the value changes (`back`: the latest
 * change before `at`), no earlier than `first`; null when there's none.
 */
export function changeFrom(points: HistoryPoint[], at: number, back: boolean, first: number): number | null {
  if (back) {
    for (let i = points.length - 1; i >= 0; i--)
      if (points[i].step < at && points[i].step >= first) return points[i].step;
    return null;
  }
  for (const p of points) if (p.step > at && p.step >= first) return p.step;
  return null;
}
