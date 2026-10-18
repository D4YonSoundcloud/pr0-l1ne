/**
 * Switching renderers while the app runs (the Style panel's "Rendering"
 * choice: SVG or Canvas 2D).
 *
 * The controllers each make their window's renderer once, from a factory
 * (scene/renderer.ts). The factory here hands them a stand-in for each
 * window that passes every call on to the real renderer, and remembers what
 * it needs to make another one look the same: the Style panel's settings,
 * Auto-fit, where the view is, the toolbar buttons, dragged boxes, the
 * loop layout, and the last thing drawn. `use()` swaps the real renderers
 * underneath, so nothing else in the app has to know.
 */
import type { LoopScene } from "../scene/loopScene";
import type { MemoryScene } from "../scene/memoryScene";
import type {
  AutoFit,
  Hit,
  LoopRenderer,
  MemoryRenderer,
  MemoryRendererEvents,
  Point,
  Renderer,
  RendererEvents,
  RendererFactory,
  RendererStyle,
  StepStyle,
  ViewportChange,
} from "../scene/renderer";
import type { RendererKind } from "../settings";

const STILL: StepStyle = { duration: 0, easing: "linear", enter: { fade: false, slide: false } };

interface Control {
  label: string;
  title: string;
  onClick: () => void;
  /** The button the app holds on to (it hides and shows it): moved into each new renderer. */
  button: HTMLButtonElement;
}

/** One window's renderer, which can be replaced by one of another kind. */
abstract class Switching<S, R extends Renderer<S>, E extends RendererEvents> implements Renderer<S> {
  protected inner: R;
  private readonly controls: Control[] = [];
  private style: RendererStyle = {};
  private autoFit: AutoFit | null = null;
  private last: { scene: S } | { message: string } | null = null;
  private readonly events: E;

  constructor(
    protected readonly el: HTMLElement,
    events: E,
    make: (el: HTMLElement, events: E) => R,
  ) {
    // Auto-fit changes in the window are remembered, to carry over.
    this.events = {
      ...events,
      onAutoFitChange: (state: AutoFit) => {
        this.autoFit = state;
        events.onAutoFitChange?.(state);
      },
    };
    this.inner = make(el, this.events);
  }

  get ready(): Promise<void> | undefined {
    return this.inner.ready;
  }

  render(scene: S, previous: S | null): void {
    this.last = { scene };
    this.inner.render(scene, previous);
  }

  showMessage(text: string): void {
    this.last = { message: text };
    this.inner.showMessage(text);
  }

  setViewport(change: ViewportChange): void {
    if (change.autoFit) this.autoFit = change.autoFit;
    this.inner.setViewport(change);
  }

  get viewport(): { pan: Point; zoom: number } {
    return this.inner.viewport;
  }

  hitTest(x: number, y: number): Hit | null {
    return this.inner.hitTest(x, y);
  }

  setAppearance(style: RendererStyle): void {
    this.style = { ...this.style, ...style };
    this.inner.setAppearance(style);
  }

  addControl(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = this.inner.addControl(label, title, onClick);
    this.controls.push({ label, title, onClick, button });
    return button;
  }

  toSVG(): string | null {
    return this.inner.toSVG();
  }

  dispose(): void {
    this.inner.dispose();
  }

  /** What only this kind of window has (dragged boxes, the loop layout), to carry over. */
  protected abstract carry(from: R, to: R): void;

  /** Replace the renderer with one from `make`, looking just as it did. */
  swap(make: (el: HTMLElement, events: E) => R): R {
    const old = this.inner;
    const view = old.viewport;
    old.dispose();
    const next = make(this.el, this.events);
    this.inner = next;
    next.setAppearance(this.style);
    if (this.autoFit) next.setViewport({ autoFit: this.autoFit });
    if (!this.autoFit?.on) next.setViewport({ pan: view.pan, zoom: view.zoom });
    // The same buttons, in the same order (each new one goes first, as before).
    for (const control of this.controls) {
      next.addControl(control.label, control.title, control.onClick).replaceWith(control.button);
    }
    this.carry(old, next);
    // Draw what was there, without animating it in.
    const last = this.last;
    if (last && "scene" in last) {
      next.setAppearance({ step: STILL });
      next.render(last.scene, null);
      next.setAppearance({ step: this.style.step ?? STILL });
    } else if (last) next.showMessage(last.message);
    return next;
  }
}

class SwitchingMemory extends Switching<MemoryScene, MemoryRenderer, MemoryRendererEvents> implements MemoryRenderer {
  resetLayout(): void {
    this.inner.resetLayout();
  }

  get hasMovedBoxes(): boolean {
    return this.inner.hasMovedBoxes;
  }

  get movedBoxes(): ReadonlyMap<string, Point> {
    return this.inner.movedBoxes;
  }

  moveBoxes(positions: ReadonlyMap<string, Point>): void {
    this.inner.moveBoxes(positions);
  }

  protected carry(from: MemoryRenderer, to: MemoryRenderer): void {
    to.moveBoxes(from.movedBoxes);
  }
}

class SwitchingLoop extends Switching<LoopScene, LoopRenderer, RendererEvents> implements LoopRenderer {
  private layout = { vertical: false };

  setLayout(layout: { vertical: boolean }): void {
    this.layout = { ...layout };
    this.inner.setLayout(layout);
  }

  protected carry(_from: LoopRenderer, to: LoopRenderer): void {
    to.setLayout(this.layout);
  }
}

/** Where each kind of renderer comes from: Canvas 2D is loaded the first time it's picked. */
export type RendererSources = Record<RendererKind, () => RendererFactory | Promise<RendererFactory>>;

export class RendererSwitch {
  private current: RendererFactory;
  private kind: RendererKind;
  private readonly memories: SwitchingMemory[] = [];
  private readonly loops: SwitchingLoop[] = [];
  /** The latest use() call, so a quick second pick wins over a slow first one. */
  private pending = 0;

  /** The factory the controllers make their renderers from. */
  readonly factory: RendererFactory;

  /** Start with a renderer that's ready at once (SVG); use() then switches. */
  constructor(
    private readonly sources: RendererSources,
    initial: { kind: RendererKind; factory: RendererFactory },
  ) {
    this.current = initial.factory;
    this.kind = initial.kind;
    this.factory = {
      memory: (el, events) => {
        const w = new SwitchingMemory(el, events, (e, ev) => this.current.memory(e, ev));
        this.memories.push(w);
        return w;
      },
      loop: (el, events) => {
        const w = new SwitchingLoop(el, events, (e, ev) => this.current.loop(e, ev));
        this.loops.push(w);
        return w;
      },
    };
  }

  /** The kind drawing the windows now. */
  get active(): RendererKind {
    return this.kind;
  }

  /**
   * Draw every window with this kind of renderer. Resolves once they can
   * draw; if they can't (the canvas renderer failed to load or start),
   * switches back to what was there and rejects with the reason.
   */
  async use(kind: RendererKind): Promise<void> {
    // Every pick takes a ticket, even one for what's already there: it
    // makes a slower pick still loading out of date.
    const ticket = ++this.pending;
    if (kind === this.kind) return;
    const factory = await this.sources[kind]();
    if (ticket !== this.pending) return; // picked again while loading: that pick decides
    const before = { kind: this.kind, factory: this.current };
    this.switchTo(kind, factory);
    try {
      await Promise.all([...this.memories, ...this.loops].map((w) => w.ready));
    } catch (error) {
      if (ticket === this.pending) this.switchTo(before.kind, before.factory);
      throw error;
    }
  }

  private switchTo(kind: RendererKind, factory: RendererFactory): void {
    this.kind = kind;
    this.current = factory;
    for (const w of this.memories) w.swap((el, events) => factory.memory(el, events));
    for (const w of this.loops) w.swap((el, events) => factory.loop(el, events));
  }
}
