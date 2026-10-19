/**
 * Which windows a phone shows. On a narrow screen the editor, the memory
 * view and the loop history can't all fit, so a bar under the toolbar picks
 * up to two of them (styles.css, "small screens", does the layout from the
 * workspace's shows-* classes). On a wide screen the classes are there but
 * nothing reads them: every window shows.
 *
 *   Tap a window that's hidden    it shows; if two already did, the one
 *                                 picked longest ago makes room
 *   Tap one of two that show      it hides, and the other fills the screen
 *   Tap the only one showing      nothing: there's always a window
 */
import type { Setting } from "../settings";

export type MobileView = "editor" | "memory" | "loop";

/** When the phone layout applies: keep in step with styles.css, "Phones and narrow windows". */
export const PHONE_QUERY = "(max-width: 820px), (max-height: 500px)";

/** Is the screen phone-width right now? */
export function isPhoneWidth(): boolean {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
}

export const MOBILE_VIEWS: readonly MobileView[] = ["editor", "memory", "loop"];

/** What a phone shows the first time: the code, and memory under it. */
export const DEFAULT_VIEWS: MobileView[] = ["editor", "memory"];

const isView = (value: string): value is MobileView => (MOBILE_VIEWS as readonly string[]).includes(value);

/** Saved as "editor,memory", oldest pick first. Anything else: the default. */
export function parseViews(raw: string | null): MobileView[] {
  const views = [...new Set((raw ?? "").split(",").map((v) => v.trim()))].filter(isView);
  return views.length >= 1 && views.length <= 2 ? views : [...DEFAULT_VIEWS];
}

/** The windows to show after tapping `view` (oldest pick first). */
export function toggleView(shown: readonly MobileView[], view: MobileView): MobileView[] {
  if (shown.includes(view)) return shown.length > 1 ? shown.filter((v) => v !== view) : [...shown];
  const next = [...shown, view];
  return next.length > 2 ? next.slice(-2) : next;
}

export interface MobileViewElements {
  /** The bar's buttons, each with data-view. */
  viewSwitch: HTMLElement;
  /** Gets shows-editor / shows-memory / shows-loop. */
  workspace: HTMLElement;
}

export class MobileViewsController {
  private shown: MobileView[];

  constructor(
    private readonly els: MobileViewElements,
    private readonly saved: Setting<string | null>,
  ) {
    this.shown = parseViews(saved.get());
    for (const button of this.buttons) {
      button.addEventListener("click", () => {
        const view = button.dataset.view;
        if (view && isView(view)) this.show(toggleView(this.shown, view));
      });
    }
    this.apply();
  }

  private get buttons(): HTMLButtonElement[] {
    return [...this.els.viewSwitch.querySelectorAll<HTMLButtonElement>("button[data-view]")];
  }

  /** The windows showing, oldest pick first. */
  get views(): readonly MobileView[] {
    return this.shown;
  }

  /** Show these windows (one or two). */
  show(views: MobileView[]): void {
    this.shown = parseViews(views.join(","));
    this.saved.set(this.shown.join(","));
    this.apply();
  }

  private apply(): void {
    const { workspace } = this.els;
    for (const view of MOBILE_VIEWS) workspace.classList.toggle(`shows-${view}`, this.shown.includes(view));
    for (const button of this.buttons) {
      const on = this.shown.includes(button.dataset.view as MobileView);
      button.setAttribute("aria-pressed", String(on));
    }
  }
}
