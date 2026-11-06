/**
 * A stand-in for the parts of PixiJS the canvas renderer uses, for tests in
 * jsdom (which has no 2D canvas). Objects record what they're asked to draw,
 * so tests can check the scene that was built without drawing any pixels.
 *
 *   vi.mock("pixi.js", () => import("../../testing/fakePixi"));
 */

export class Container {
  children: Container[] = [];
  parent: Container | null = null;
  x = 0;
  y = 0;
  alpha = 1;
  visible = true;
  destroyed = false;
  readonly position = {
    set: (x: number, y: number) => {
      this.x = x;
      this.y = y;
    },
  };
  readonly scale = {
    x: 1,
    y: 1,
    set: (x: number, y = x) => {
      this.scale.x = x;
      this.scale.y = y;
    },
  };

  /** Painted once as a bitmap (cacheAsTexture), and the resolution asked for: what the tests check. */
  cachedAs: { resolution?: number; antialias?: boolean } | null = null;
  get isCachedAsTexture(): boolean {
    return this.cachedAs !== null;
  }
  cacheAsTexture(options: boolean | { resolution?: number; antialias?: boolean }): void {
    this.cachedAs = options === false ? null : options === true ? {} : options;
  }

  addChild<T extends Container>(child: T): T {
    // As in PixiJS: a child added elsewhere moves.
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addChildAt<T extends Container>(child: T, index: number): T {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild<T extends Container>(child: T): T {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
    return child;
  }

  removeChildren(): Container[] {
    const removed = this.children;
    for (const c of removed) c.parent = null;
    this.children = [];
    return removed;
  }

  destroy(options?: { children?: boolean }): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (options?.children) for (const c of this.children) c.destroy(options);
    for (const listener of this.listeners.get("destroyed") ?? []) listener(this);
    this.listeners.clear();
  }

  private readonly listeners = new Map<string, ((target: Container) => void)[]>();
  once(event: string, listener: (target: Container) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
}

export type DrawCall = [string, ...unknown[]];

/** What a Graphics draws: here, the calls made to draw it. Graphics drawing the same share one. */
export class GraphicsContext {
  static made = 0;
  readonly calls: DrawCall[] = [];
  destroyed = false;
  constructor() {
    GraphicsContext.made++;
  }
  private record(name: string, ...args: unknown[]): this {
    this.calls.push([name, ...args]);
    return this;
  }
  rect(...a: number[]) {
    return this.record("rect", ...a);
  }
  roundRect(...a: number[]) {
    return this.record("roundRect", ...a);
  }
  circle(...a: number[]) {
    return this.record("circle", ...a);
  }
  moveTo(...a: number[]) {
    return this.record("moveTo", ...a);
  }
  lineTo(...a: number[]) {
    return this.record("lineTo", ...a);
  }
  quadraticCurveTo(...a: number[]) {
    return this.record("quadraticCurveTo", ...a);
  }
  bezierCurveTo(...a: number[]) {
    return this.record("bezierCurveTo", ...a);
  }
  closePath() {
    return this.record("closePath");
  }
  fill(style: unknown) {
    return this.record("fill", style);
  }
  stroke(style: unknown) {
    return this.record("stroke", style);
  }
  destroy() {
    this.destroyed = true;
  }
  autoGarbageCollect = true;
  /** Who listens to it, by event (Graphics listen for changes, as in PixiJS). */
  readonly listening = new Map<string, unknown[]>();
  on(event: string, _fn: unknown, context?: unknown): this {
    this.listening.set(event, [...(this.listening.get(event) ?? []), context]);
    return this;
  }
  off(event: string, _fn?: unknown, context?: unknown): this {
    this.listening.set(
      event,
      (this.listening.get(event) ?? []).filter((c) => c !== context),
    );
    return this;
  }
}

export class Graphics extends Container {
  readonly context: GraphicsContext;
  constructor(context?: GraphicsContext) {
    super();
    this.context = context ?? new GraphicsContext();
    // As in PixiJS: a Graphics listens to its context for changes, and for its GPU data being let go.
    this.context.on("update", null, this);
    this.context.on("unload", null, this);
  }
  override destroy(options?: { children?: boolean }): void {
    this.context.off("update", null, this);
    this.context.off("unload", null, this);
    super.destroy(options);
  }
  /** The calls drawing it (its context's: shared with every Graphics drawing the same). */
  get calls(): DrawCall[] {
    return this.context.calls;
  }
  private record(name: string, ...args: unknown[]): this {
    this.context.calls.push([name, ...args]);
    return this;
  }
  rect(...a: number[]) {
    return this.record("rect", ...a);
  }
  roundRect(...a: number[]) {
    return this.record("roundRect", ...a);
  }
  circle(...a: number[]) {
    return this.record("circle", ...a);
  }
  moveTo(...a: number[]) {
    return this.record("moveTo", ...a);
  }
  lineTo(...a: number[]) {
    return this.record("lineTo", ...a);
  }
  quadraticCurveTo(...a: number[]) {
    return this.record("quadraticCurveTo", ...a);
  }
  bezierCurveTo(...a: number[]) {
    return this.record("bezierCurveTo", ...a);
  }
  closePath() {
    return this.record("closePath");
  }
  fill(style: unknown) {
    return this.record("fill", style);
  }
  stroke(style: unknown) {
    return this.record("stroke", style);
  }
  /** The names of the calls, in order. */
  get ops(): string[] {
    return this.calls.map((c) => c[0]);
  }
}

export class TextStyle {
  listeners = 1;
  constructor(readonly options: Record<string, unknown>) {}
  removeAllListeners() {
    this.listeners = 0;
  }
  get fontSize(): number {
    return this.options.fontSize as number;
  }
  get fontFamily(): string {
    return this.options.fontFamily as string;
  }
}

export class Text extends Container {
  readonly text: string;
  readonly style: TextStyle;
  readonly resolution: number;
  readonly roundPixels: boolean;
  constructor(options: { text: string; style: TextStyle; resolution: number; roundPixels?: boolean }) {
    super();
    this.text = options.text;
    this.style = options.style;
    this.resolution = options.resolution;
    this.roundPixels = !!options.roundPixels;
  }
}

export const fontStringFromTextStyle = (style: TextStyle) => `${style.fontSize}px ${style.fontFamily}`;

// The parts of a mesh drawn with a shader of its own (render/canvas/cellMesh.ts): what it was given.

export class Rectangle {
  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly width = 0,
    readonly height = 0,
  ) {}
  get right(): number {
    return this.x + this.width;
  }
  get bottom(): number {
    return this.y + this.height;
  }
}

export class Bounds {
  constructor(
    readonly minX = 0,
    readonly minY = 0,
    readonly maxX = 0,
    readonly maxY = 0,
  ) {}
}

export const BufferUsage = { VERTEX: 32, COPY_DST: 8 };

export class Buffer {
  readonly data: ArrayLike<number>;
  /** How many times it was uploaded again. */
  updates = 0;
  destroyed = false;
  constructor(options: { data: ArrayLike<number> }) {
    this.data = options.data;
  }
  update(): void {
    this.updates++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export class Geometry {
  readonly attributes: Record<string, { buffer: Buffer; format: string }> = {};
  readonly instanceCount: number;
  destroyed = false;
  constructor(options: {
    attributes: Record<string, { buffer: Buffer | ArrayLike<number>; format: string }>;
    instanceCount?: number;
  }) {
    for (const [name, a] of Object.entries(options.attributes))
      this.attributes[name] = { ...a, buffer: a.buffer instanceof Buffer ? a.buffer : new Buffer({ data: a.buffer }) };
    this.instanceCount = options.instanceCount ?? 1;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export const GlProgram = { from: (options: { vertex: string; fragment: string }) => ({ ...options }) };

export class Shader {
  constructor(readonly options: unknown) {}
}

export class Mesh<G extends Geometry = Geometry, S = Shader> extends Container {
  readonly geometry: G;
  readonly shader: S;
  boundsArea: Rectangle | null = null;
  constructor(options: { geometry: G; shader: S }) {
    super();
    this.geometry = options.geometry;
    this.shader = options.shader;
  }
}

/** Monospace-ish: 0.6em a character; an ascent of 0.75em. */
export const CanvasTextMetrics = {
  cleared: 0,
  measureText: (text: string, style: TextStyle) => ({ width: text.length * style.fontSize * 0.6 }),
  measureFont: (font: string) => {
    const size = Number.parseFloat(font) || 13;
    return { ascent: size * 0.75, descent: size * 0.25, fontSize: size };
  },
  clearMetrics: () => {
    CanvasTextMetrics.cleared++;
  },
};

export class FakeRenderer {
  width: number;
  height: number;
  resolution: number;
  renders = 0;
  destroyed = false;
  lastStage: Container | null = null;
  /** "webgl" or "canvas": the first backend asked for, as if it started. */
  readonly name: string;
  constructor(readonly options: Record<string, number | string | unknown>) {
    const preference = options.preference;
    this.name = Array.isArray(preference) ? String(preference[0]) : String(preference ?? "canvas");
    this.width = options.width as number;
    this.height = options.height as number;
    this.resolution = options.resolution as number;
  }
  resize(w: number, h: number, resolution: number) {
    this.width = w;
    this.height = h;
    this.resolution = resolution;
  }
  render(options: { container: Container }) {
    this.renders++;
    this.lastStage = options.container;
  }
  destroy() {
    this.destroyed = true;
  }
}

/** Every renderer made, newest last; set `fail` to make the next start fail. */
export const pixi = { renderers: [] as FakeRenderer[], fail: null as Error | null };

export async function autoDetectRenderer(options: Record<string, unknown>): Promise<FakeRenderer> {
  if (pixi.fail) {
    const error = pixi.fail;
    pixi.fail = null;
    throw error;
  }
  const r = new FakeRenderer(options);
  pixi.renderers.push(r);
  return r;
}
