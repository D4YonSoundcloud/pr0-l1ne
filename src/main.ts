import "./styles.css";
import { createEditor } from "./editor";
import { LANGUAGES, isLanguageId, type LanguageId } from "./languages";
import { applyHints } from "./trace/hints";
import { ProgramStore, type Program } from "./programs";
import { renderLoopHistory } from "./render/loopView";
import { prefersReducedMotion } from "./render/animate";
import { applyFocus, renderMemory, type MemoryMode, type Point } from "./render/memory";
import { Viewport, type AutoFit } from "./render/viewport";
import { SIZE_MODELS, formatBytes, stepSizes, type SizeModel } from "./trace/memory";
import { APPEARANCE_KEY, applyAppearance, parseAppearance, type Appearance } from "./appearance";
import { StylePanel } from "./stylePanel";
import { ComplexityPanel, costLabels } from "./complexityPanel";
import { estimateComplexity } from "./trace/complexity";
import { diffSteps } from "./trace/diff";
import { availableLoops, buildLoopHistory, type LoopHistory, type LoopRow } from "./trace/loopHistory";
import { liveFrames, type Step, type Trace } from "./trace/types";
import { Runner, type RunOutcome, type RunnerStatus } from "./worker/runner";

const MAX_STEPS = 3000;
const LIVE_DELAY_MS = 600;
const LANGUAGE_KEY = "algoviz:language";
const codeKey = (id: LanguageId) => `algoviz:code:${id}`;

// ---------------------------------------------------------------- storage

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage can be unavailable (privacy modes, sandboxes)
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// Code saved before JavaScript support existed was always Python.
const legacyCode = stored("algoviz:code");
if (legacyCode !== null && stored(codeKey("python")) === null) store(codeKey("python"), legacyCode);

const savedCode = (id: LanguageId) => stored(codeKey(id)) ?? LANGUAGES[id].examples[0].code;

// Saved programs. `openKey` remembers which saved program (if any) is open in
// each language, so a reload comes back to the same one.
const programs = new ProgramStore((() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})());
const openKey = (id: LanguageId) => `algoviz:open:${id}`;
const openProgramFor = (id: LanguageId) => programs.get(stored(openKey(id))) ?? null;

// ---------------------------------------------------------------- state

const savedLanguage = stored(LANGUAGE_KEY);
let language: LanguageId = isLanguageId(savedLanguage) ? savedLanguage : "python";
let currentProgram: Program | null = openProgramFor(language);
let trace: Trace | null = null;
let stepIndex = 0;
let selectedLoop: string | null = null;
let hideQuiet = true;
let stale = false;

// ---------------------------------------------------------------- elements

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  language: byId<HTMLSelectElement>("language"),
  programs: byId<HTMLSelectElement>("programs"),
  programName: byId<HTMLSpanElement>("program-name"),
  programDirty: byId<HTMLSpanElement>("program-dirty"),
  programDirtyLabel: byId<HTMLSpanElement>("program-dirty-label"),
  save: byId<HTMLButtonElement>("save"),
  delete: byId<HTMLButtonElement>("delete"),
  saveDialog: byId<HTMLDialogElement>("save-dialog"),
  saveForm: byId<HTMLFormElement>("save-form"),
  saveName: byId<HTMLInputElement>("save-name"),
  saveHint: byId<HTMLParagraphElement>("save-hint"),
  announce: byId<HTMLDivElement>("announce"),
  run: byId<HTMLButtonElement>("run"),
  live: byId<HTMLInputElement>("live"),
  status: byId<HTMLSpanElement>("status"),
  editor: byId<HTMLDivElement>("editor"),
  output: byId<HTMLPreElement>("output"),
  banner: byId<HTMLDivElement>("banner"),
  canvas: byId<HTMLDivElement>("canvas"),
  memory: byId<HTMLDivElement>("memory"),
  loop: byId<HTMLDivElement>("loop"),
  loopTabs: byId<HTMLDivElement>("loop-tabs"),
  hideQuiet: byId<HTMLInputElement>("hide-quiet"),
  first: byId<HTMLButtonElement>("first"),
  prev: byId<HTMLButtonElement>("prev"),
  next: byId<HTMLButtonElement>("next"),
  last: byId<HTMLButtonElement>("last"),
  scrubber: byId<HTMLInputElement>("scrubber"),
  stepLabel: byId<HTMLSpanElement>("step-label"),
  workspace: byId<HTMLElement>("workspace"),
  divider: byId<HTMLDivElement>("divider"),
  canvasDivider: byId<HTMLDivElement>("canvas-divider"),
  modeArrows: byId<HTMLButtonElement>("mode-arrows"),
  loopStacked: byId<HTMLButtonElement>("loop-stacked"),
  loopAnimated: byId<HTMLButtonElement>("loop-animated"),
  play: byId<HTMLButtonElement>("play"),
  speed: byId<HTMLSelectElement>("speed"),
  modeNested: byId<HTMLButtonElement>("mode-nested"),
  sizes: byId<HTMLButtonElement>("sizes"),
  sizeModel: byId<HTMLSelectElement>("size-model"),
  memoryTotal: byId<HTMLSpanElement>("memory-total"),
  editorPane: byId<HTMLElement>("editor-pane"),
  canvasPane: byId<HTMLElement>("canvas-pane"),
  swap: byId<HTMLButtonElement>("swap"),
  style: byId<HTMLButtonElement>("style"),
  complexity: byId<HTMLButtonElement>("complexity"),
  memorySection: byId<HTMLElement>("memory-section"),
  loopSection: byId<HTMLElement>("loop-section"),
};

// ---------------------------------------------------------------- running code

function showStatus(status: RunnerStatus): void {
  els.status.classList.toggle("is-error", status.kind === "failed");
  switch (status.kind) {
    case "loading": els.status.textContent = `Loading ${LANGUAGES[language].label}…`; break;
    case "running": els.status.textContent = "Running…"; break;
    case "ready": els.status.textContent = status.label; break;
    case "failed": els.status.textContent = status.message; break;
  }
}

// One runner per language, started the first time it's needed, so people
// writing JavaScript never download Python.
const runners = new Map<LanguageId, Runner>();
function runnerFor(id: LanguageId): Runner {
  let runner = runners.get(id);
  if (!runner) {
    runner = new Runner(LANGUAGES[id].createWorker, (status) => {
      if (id === language) showStatus(status);
    });
    runners.set(id, runner);
  }
  return runner;
}

let inFlight = false;
let queued: { code: string; language: LanguageId } | null = null;

async function run(code: string, lang: LanguageId = language): Promise<void> {
  if (inFlight) {
    queued = { code, language: lang }; // only the newest edit matters
    return;
  }
  inFlight = true;
  const outcome = await runnerFor(lang).run(code, MAX_STEPS);
  inFlight = false;
  // Ignore results for a language the person has switched away from.
  if (lang === language) applyOutcome(outcome);
  if (queued !== null) {
    const next = queued;
    queued = null;
    run(next.code, next.language);
  }
}

function setBanner(html: string | null): void {
  els.banner.hidden = html === null;
  els.banner.innerHTML = html ?? "";
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function applyOutcome(outcome: RunOutcome): void {
  if (outcome.kind === "timeout") {
    stale = true;
    setBanner(`Your code ran for more than ${outcome.seconds} seconds and was stopped. Check for a loop that never ends.`);
    render();
    updateComplexity();
    return;
  }
  if (outcome.kind === "crash") {
    stale = true;
    setBanner(`The tracer failed: <code>${escapeHtml(outcome.message)}</code>`);
    render();
    updateComplexity();
    return;
  }

  const next = outcome.trace;
  if (next.error && next.steps.length === 0) {
    // Couldn't even start (usually a syntax error mid-typing). Keep the last
    // good picture on screen, dimmed, and point at the problem.
    stale = true;
    const where = next.error.line ? ` on line ${next.error.line}` : "";
    setBanner(`<strong>${escapeHtml(next.error.type)}</strong>${where}: ${escapeHtml(next.error.message)}. Showing the last version that ran.`);
    editor.setMarks({ next: null, prev: null, error: { line: next.error.line, message: `${next.error.type}: ${next.error.message}` } });
    render(false);
    updateComplexity();
    return;
  }

  // Stay on the last step if we were there, so live edits show the result.
  const wasAtEnd = !trace || stepIndex >= trace.steps.length - 1;
  trace = applyHints(next);
  const warnings = trace.viz?.warnings ?? [];
  editor.setHintWarnings(warnings);
  stale = false;
  stepIndex = wasAtEnd ? trace.steps.length - 1 : Math.max(firstStep(), Math.min(stepIndex, trace.steps.length - 1));

  if (trace.truncated) {
    setBanner(`Stopped after ${MAX_STEPS.toLocaleString()} steps. If that's unexpected, look for a loop that never ends.`);
  } else if (trace.error) {
    const where = trace.error.line ? ` on line ${trace.error.line}` : "";
    setBanner(`<strong>${escapeHtml(trace.error.type)}</strong>${where}: ${escapeHtml(trace.error.message)}`);
  } else if (warnings.length) {
    const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more, underlined in the editor)` : "";
    setBanner(`<strong>Hint on line ${warnings[0].line}</strong>: ${escapeHtml(warnings[0].message)}${more}`);
  } else {
    setBanner(null);
  }
  render();
  updateComplexity();
}

// ---------------------------------------------------------------- rendering

function describe(step: Step, prev: Step | undefined): string {
  const frame = step.stack[step.stack.length - 1];
  const func = frame?.func ?? "Global";
  switch (step.event) {
    case "call":
      return func === "Global" ? "Program starts" : `Called ${func}()`;
    case "line":
      // Matches the editor: yellow is the line that ran, blue is next.
      return prev && prev.line >= 1 && prev.event === "line"
        ? `Ran line ${prev.line}, next is line ${step.line}`
        : `Next is line ${step.line}`;
    case "return": {
      if (func === "Global") return "Program finished";
      const value = step.returnValue;
      const shown = value?.kind === "prim" ? value.repr : "an object";
      return `${func}() returns ${shown}`;
    }
    case "exception":
      return `${step.exception?.type ?? "Error"} raised on line ${step.line}`;
    case "yield": {
      const value = step.returnValue;
      if (!value) return `${func}() hands over to another generator`;
      return `${func}() yields ${value.kind === "prim" ? value.repr : "an object"} and pauses`;
    }
    case "await":
      return `${func}() waits at line ${step.line} and pauses`;
    case "resume":
      return `${func}() resumes at line ${step.line}`;
  }
}

// ---------------------------------------------------------------- canvas

/** Where the person has dragged boxes in the memory view, by node key. */
const positions = new Map<string, Point>();

// Arrows, or objects drawn inside the thing that refers to them.
const MODE_KEY = "algoviz:memory-mode";
let memoryMode: MemoryMode = stored(MODE_KEY) === "nested" ? "nested" : "arrows";

function setMemoryMode(mode: MemoryMode): void {
  memoryMode = mode;
  store(MODE_KEY, mode);
  els.modeArrows.setAttribute("aria-pressed", String(mode === "arrows"));
  els.modeNested.setAttribute("aria-pressed", String(mode === "nested"));
  renderMemoryView();
}
let draggingNode: string | null = null;

// Memory sizes: on or off, and which model, per language family (Python
// has its own real sizes; JavaScript and TypeScript share theirs).
const SIZES_KEY = "algoviz:sizes";
const sizeFamily = (id: LanguageId) => (id === "python" ? "python" : "javascript");
const sizeModelKey = (id: LanguageId) => `algoviz:size-model:${sizeFamily(id)}`;
let sizesOn = stored(SIZES_KEY) === "on";

function sizeModel(): SizeModel {
  const choices = SIZE_MODELS[sizeFamily(language)];
  const saved = stored(sizeModelKey(language));
  return choices.find((c) => c.value === saved)?.value ?? choices[0].value;
}
/** The model to draw sizes with, or null when sizes are off. */
const shownSizes = (): SizeModel | null => (sizesOn ? sizeModel() : null);

function fillSizeModels(): void {
  els.sizeModel.replaceChildren(...SIZE_MODELS[sizeFamily(language)].map((c) => {
    const option = new Option(c.label, c.value);
    option.title = c.title;
    return option;
  }));
  els.sizeModel.value = sizeModel();
}

function setSizes(on: boolean): void {
  sizesOn = on;
  store(SIZES_KEY, on ? "on" : "off");
  els.sizes.setAttribute("aria-pressed", String(on));
  els.sizeModel.hidden = !on;
  render(false);
}

/** "Program: 1.4 KB" in the memory header, for the step on screen. */
function updateMemoryTotal(): void {
  const model = shownSizes();
  const step = trace?.steps[stepIndex];
  els.memoryTotal.hidden = !model || !step;
  if (!model || !step) return;
  const sizes = stepSizes(step, model);
  els.memoryTotal.textContent = `Program: ${formatBytes(sizes.program, sizes.approximate)}`;
  els.memoryTotal.title = "Everything the program holds at this step, each object counted once";
}

/** Auto-fit (see Viewport) is remembered per window. */
const autoFitKey = (pane: "memory" | "loop") => `algoviz:auto-fit:${pane}`;
function storedAutoFit(pane: "memory" | "loop"): AutoFit {
  try {
    const raw = JSON.parse(stored(autoFitKey(pane)) ?? "null") as Partial<AutoFit> | null;
    return { on: raw?.on === true, mode: raw?.mode === "both" ? "both" : "out" };
  } catch {
    return { on: false, mode: "out" };
  }
}

const memoryView = new Viewport(els.memory, {
  label: "Memory diagram",
  onNodeMove(key, position, done) {
    positions.set(key, position);
    draggingNode = done ? null : key;
    renderMemoryView();
    updateResetLayout();
  },
  onAutoFitChange: (state) => store(autoFitKey("memory"), JSON.stringify(state)),
});
const loopView = new Viewport(els.loop, {
  label: "Loop history",
  onAutoFitChange: (state) => store(autoFitKey("loop"), JSON.stringify(state)),
});
memoryView.setAutoFit(storedAutoFit("memory"), false);
loopView.setAutoFit(storedAutoFit("loop"), false);

// ---------------------------------------------------------------- style

/** How the canvas looks (the Style panel). Applied as CSS variables, live. */
let appearance: Appearance = parseAppearance(stored(APPEARANCE_KEY));
let saveAppearanceTimer = 0;
function setAppearance(next: Appearance): void {
  appearance = next;
  applyAppearance(appearance, { canvas: els.canvas, memory: els.memorySection, loop: els.loopSection },
    (pane, size) => (pane === "memory" ? memoryView : loopView).setGridSize(size));
  // Auto-fit glides with each window's step animation.
  memoryView.setZoomAnimation(appearance.memory.duration, appearance.memory.easing);
  loopView.setZoomAnimation(appearance.loop.duration, appearance.loop.easing);
  window.clearTimeout(saveAppearanceTimer);
  saveAppearanceTimer = window.setTimeout(() => store(APPEARANCE_KEY, JSON.stringify(appearance)), 250);
}
setAppearance(appearance);
const stylePanel = new StylePanel({
  host: els.editorPane,
  button: els.style,
  get: () => appearance,
  set: setAppearance,
  replay: () => replayStep(),
  onOpen: () => complexityPanel.toggle(false),
});

// ---------------------------------------------------------------- complexity

const COST_LABELS_KEY = "algoviz:complexity-labels";
let costLabelsOn = stored(COST_LABELS_KEY) !== "off";
const complexityPanel = new ComplexityPanel({
  host: els.editorPane,
  button: els.complexity,
  reveal: (line) => editor.revealLine(line),
  labelsShown: () => costLabelsOn,
  setLabelsShown(on) {
    costLabelsOn = on;
    store(COST_LABELS_KEY, on ? "on" : "off");
    updateComplexity();
  },
  onOpen: () => stylePanel.toggle(false),
});

/**
 * The estimate is worked out once per run (it's cached on the trace), after
 * the step is drawn so it never delays the canvas.
 */
let complexityTimer = 0;
function updateComplexity(): void {
  window.clearTimeout(complexityTimer);
  complexityTimer = window.setTimeout(() => {
    let estimate = null;
    try {
      estimate = trace ? estimateComplexity(trace) : null;
    } catch (error) {
      console.warn("Complexity estimate failed", error);
    }
    complexityPanel.show(estimate, stale);
    // Labels sit on lines; once the code has changed under an error, they'd be on the wrong ones.
    editor.setCostLabels(costLabelsOn && !stale ? costLabels(estimate) : []);
  }, 0);
}

/** Draw the step before this one, then animate into this one (previews easing). */
function replayStep(): void {
  if (!trace) return;
  const target = stepIndex;
  const from = target > firstStep() ? target - 1 : target + 1;
  if (from >= trace.steps.length) return;
  stepIndex = from;
  render(false);
  goTo(target);
}

const resetLayoutButton = memoryView.addControl("Reset layout", "Put every box back in its automatic position", () => {
  positions.clear();
  renderMemoryView();
  updateResetLayout();
});

function updateResetLayout(): void {
  resetLayoutButton.hidden = positions.size === 0;
}

/** Forget dragged positions, e.g. when a different program is opened. */
function clearLayout(): void {
  positions.clear();
  updateResetLayout();
}
updateResetLayout();

function renderMemoryView(): void {
  if (!trace || !trace.steps.length) return;
  const diff = diffSteps(trace.steps[stepIndex - 1], trace.steps[stepIndex]);
  const animation = animationFor("memory");
  memoryView.setContent(renderMemory(trace, stepIndex, diff, { positions, raise: draggingNode, mode: memoryMode, sizes: shownSizes() }), "", animation.duration, animation.easing);
  updateMemoryTotal();
  refreshFocus();
}

// Hovering a box (or dragging it) highlights its arrows and the boxes they
// connect to. The SVG is redrawn on every step, so the focus is re-applied.
let hoveredNode: string | null = null;
function refreshFocus(): void {
  applyFocus(els.memory.querySelector<SVGSVGElement>(".memory-svg"), draggingNode ?? hoveredNode);
}
els.memory.addEventListener("pointerover", (event) => {
  const key = (event.target as Element).closest<SVGGElement>(".node")?.dataset.nodeKey ?? null;
  if (key === hoveredNode) return;
  hoveredNode = key;
  refreshFocus();
});
els.memory.addEventListener("pointerleave", () => {
  hoveredNode = null;
  refreshFocus();
});

els.modeArrows.addEventListener("click", () => setMemoryMode("arrows"));
els.modeNested.addEventListener("click", () => setMemoryMode("nested"));
setMemoryMode(memoryMode);
els.sizes.addEventListener("click", () => setSizes(!sizesOn));
els.sizeModel.addEventListener("change", () => {
  store(sizeModelKey(language), els.sizeModel.value);
  render(false);
});

/**
 * The first step worth showing. Every trace starts with "called Global" and
 * "next is line 1", which both show an empty program, so the timeline starts
 * at the third step: the state after line 1 ran.
 */
const SKIPPED_STEPS = 2;
function firstStep(): number {
  return trace ? Math.max(0, Math.min(SKIPPED_STEPS, trace.steps.length - 1)) : 0;
}

function render(updateMarks = true): void {
  els.canvas.classList.toggle("is-stale", stale);
  const total = trace?.steps.length ?? 0;
  const first = firstStep();

  els.scrubber.min = String(first);
  els.scrubber.max = String(Math.max(first, total - 1));
  els.scrubber.value = String(stepIndex);
  els.scrubber.disabled = total - first <= 1;
  els.play.disabled = total - first <= 1;
  els.first.disabled = els.prev.disabled = stepIndex <= first;
  els.next.disabled = els.last.disabled = stepIndex >= total - 1;

  if (!trace || !total) {
    memoryView.setContent(null, "Write some code and press Run. Variables, objects and scopes appear here.");
    loopView.setContent(null);
    els.loopTabs.replaceChildren();
    els.stepLabel.textContent = "";
    els.stepLabel.title = "";
    els.output.textContent = "";
    updateMemoryTotal();
    if (updateMarks) editor.setMarks({ next: null, prev: null, error: null });
    return;
  }

  const step = trace.steps[stepIndex];
  const prev = trace.steps[stepIndex - 1];
  // The label has a fixed width (so the scrubber never resizes); the full
  // text is in its tooltip when it doesn't fit.
  els.stepLabel.textContent = `Step ${stepIndex + 1} of ${total}: ${describe(step, prev)}`;
  els.stepLabel.title = els.stepLabel.textContent;

  renderMemoryView();

  // Loop history and its tabs.
  const { contexts } = availableLoops(trace, stepIndex);
  const history = buildLoopHistory(trace, stepIndex, selectedLoop);
  els.loopTabs.replaceChildren(...contexts.map((ctx) => {
    const info = trace!.loops.find((loop) => loop.id === ctx.loop);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "loop-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(history?.info.id === ctx.loop));
    button.textContent = `${info?.header ?? ctx.loop}  (line ${info?.line ?? "?"})`;
    button.addEventListener("click", () => { selectedLoop = ctx.loop; render(); });
    return button;
  }));
  if (history && history.rows.length) {
    const live = loopMode === "animated" ? liveRows(trace, stepIndex, history) : undefined;
    const animation = animationFor("loop");
    loopView.setContent(renderLoopHistory(trace, history, { hideQuiet, live, sizes: shownSizes() }), "", live ? animation.duration : 0, animation.easing);
    // As you step, keep the iteration that's running in view.
    const current = els.loop.querySelector(".loop-row.is-current");
    if (current) loopView.reveal(Number(current.getAttribute("data-top")), Number(current.getAttribute("data-bottom")));
  } else {
    loopView.setContent(null, "When your code enters a loop, each iteration is stacked here so you can compare them.");
  }

  // Output printed so far, plus the error once we reach the end.
  els.output.textContent = trace.stdout.slice(0, step.stdoutLength);
  const atEnd = stepIndex === total - 1;
  if (atEnd && trace.error) {
    const span = document.createElement("span");
    span.className = "error";
    span.textContent = `${trace.error.type}: ${trace.error.message}\n`;
    els.output.append(span);
  }

  if (updateMarks) {
    const nextLine = step.event === "call" && step.line < 1 ? null : step.line;
    editor.setMarks({
      next: nextLine,
      prev: prev && prev.line >= 1 ? prev.line : null,
      error: atEnd && trace.error ? { line: trace.error.line, message: `${trace.error.type}: ${trace.error.message}` } : null,
    });
  }
}

/**
 * Move to a step. A single step forward or back animates (from the previous
 * drawing to the new one); jumps don't. Any navigation that isn't playback
 * pauses playback.
 */
function goTo(index: number, how: { playing?: boolean } = {}): void {
  if (!trace) return;
  if (!how.playing) setPlaying(false);
  const next = Math.max(firstStep(), Math.min(trace.steps.length - 1, index));
  const single = Math.abs(next - stepIndex) === 1;
  pendingAnimation = single && !prefersReducedMotion() ? { playing: !!how.playing } : null;
  stepIndex = next;
  try {
    render();
  } finally {
    pendingAnimation = null;
  }
}

// ---------------------------------------------------------------- animation

/** Set by goTo while it draws a single step, so that render animates. */
let pendingAnimation: { playing: boolean } | null = null;

/**
 * How a window animates the step being drawn: its own easing and duration
 * (from the Style panel), shortened while playing so an animation always
 * ends before the next step starts. Duration 0 means no animation.
 */
function animationFor(pane: "memory" | "loop"): { duration: number; easing: string } {
  const { duration, easing } = appearance[pane];
  if (!pendingAnimation) return { duration: 0, easing };
  const cap = pendingAnimation.playing ? (0.75 * 1000) / speed : Infinity;
  return { duration: Math.round(Math.min(duration, cap)), easing };
}

// Loop history: a row per iteration, or one live row that animates.
const LOOP_MODE_KEY = "algoviz:loop-mode";
let loopMode: "stacked" | "animated" = stored(LOOP_MODE_KEY) === "animated" ? "animated" : "stacked";

function setLoopMode(mode: "stacked" | "animated"): void {
  loopMode = mode;
  store(LOOP_MODE_KEY, mode);
  els.loopStacked.setAttribute("aria-pressed", String(mode === "stacked"));
  els.loopAnimated.setAttribute("aria-pressed", String(mode === "animated"));
  render(false);
}

/** The loop's live state at a step, and at the step before, for animated mode. */
function liveRows(t: Trace, index: number, history: LoopHistory): { prev: LoopRow; current: LoopRow } {
  const { frame: frameId, loop, instance } = history.context;
  const at = (i: number): LoopRow | null => {
    const step = t.steps[i];
    const context = step?.loops.find((c) => c.frame === frameId && c.loop === loop && c.instance === instance);
    const frame = step && liveFrames(step).find((f) => f.id === frameId);
    return context && frame ? { iteration: context.iteration, stepIndex: i, frame, heap: step.heap } : null;
  };
  const current = at(index) ?? history.rows[history.rows.length - 1];
  return { prev: at(index - 1) ?? current, current };
}

// Playback: step forward on a timer.
const SPEEDS = [0.5, 1, 2, 4, 8, 16];
const SPEED_KEY = "algoviz:speed";
let speed = SPEEDS.includes(Number(stored(SPEED_KEY))) ? Number(stored(SPEED_KEY)) : 2;
let playing = false;
let playTimer = 0;

function setPlaying(on: boolean): void {
  window.clearTimeout(playTimer);
  if (on === playing) {
    if (on) scheduleTick();
    return;
  }
  playing = on;
  els.play.textContent = on ? "Pause" : "Play";
  els.play.setAttribute("aria-pressed", String(on));
  if (!on || !trace) return;
  if (stepIndex >= trace.steps.length - 1) goTo(firstStep(), { playing: true }); // play again from the start
  playOrigin = stepIndex;
  scheduleTick();
}

/** The step the current (or last) playback started from. */
let playOrigin: number | null = null;

/**
 * Ctrl/Cmd + Enter: play from the current step. Pressed again while playing,
 * it stops and goes back to the step playing started from, so you can watch
 * the same stretch again.
 */
function playOrRewind(): void {
  if (!trace) return;
  if (playing && playOrigin !== null) {
    goTo(playOrigin); // goTo pauses
    return;
  }
  setPlaying(true);
}

function scheduleTick(): void {
  playTimer = window.setTimeout(() => {
    if (!playing) return;
    if (!trace || stepIndex >= trace.steps.length - 1) {
      setPlaying(false);
      return;
    }
    goTo(stepIndex + 1, { playing: true });
    scheduleTick();
  }, 1000 / speed);
}

for (const value of SPEEDS) {
  els.speed.append(new Option(`${value} ${value === 1 ? "step" : "steps"}/s`, String(value), false, value === speed));
}
els.speed.addEventListener("change", () => {
  speed = Number(els.speed.value);
  store(SPEED_KEY, String(speed));
  if (playing) setPlaying(true); // restart the timer at the new speed
});
els.play.addEventListener("click", () => setPlaying(!playing));
els.loopStacked.addEventListener("click", () => setLoopMode("stacked"));
els.loopAnimated.addEventListener("click", () => setLoopMode("animated"));
els.loopStacked.setAttribute("aria-pressed", String(loopMode === "stacked"));
els.loopAnimated.setAttribute("aria-pressed", String(loopMode === "animated"));

// ---------------------------------------------------------------- editor

let liveTimer = 0;
const editor = createEditor(els.editor, { monacoId: LANGUAGES[language].monacoId, code: savedCode(language) }, {
  onChange(code) {
    setPlaying(false);
    store(codeKey(language), code);
    updateProgramUI();
    window.clearTimeout(liveTimer);
    if (els.live.checked) liveTimer = window.setTimeout(() => run(code), LIVE_DELAY_MS);
  },
  // Also available from the command palette (F1) as "AlgoViz: ...".
  commands: {
    run: () => runNow(),
    save: () => save(),
    saveAs: () => saveAs(),
    nextStep: () => goTo(stepIndex + 1),
    prevStep: () => goTo(stepIndex - 1),
    firstStep: () => goTo(firstStep()),
    lastStep: () => goTo(Infinity),
    swapPanels: () => setSwapped(!swapped),
    togglePlay: () => setPlaying(!playing),
    playOrRewind: () => playOrRewind(),
    toggleNested: () => setMemoryMode(memoryMode === "nested" ? "arrows" : "nested"),
  },
});

function runNow(): void {
  setPlaying(false);
  window.clearTimeout(liveTimer); // don't run the same code twice
  run(editor.getCode());
}

// ---------------------------------------------------------------- saved programs

function setOpenProgram(program: Program | null): void {
  currentProgram = program;
  store(openKey(language), program?.id ?? "");
}

/** Unsaved work: edits to a saved program, or code that's neither saved nor an example. */
function hasUnsavedChanges(): boolean {
  const code = editor.getCode();
  if (currentProgram) return code !== currentProgram.code;
  return code.trim() !== "" && !LANGUAGES[language].examples.some((example) => example.code === code);
}

function updateProgramUI(): void {
  els.programName.textContent = currentProgram?.name ?? "Untitled";
  els.programName.title = currentProgram?.name ?? "Not saved yet";
  els.programName.classList.toggle("is-untitled", !currentProgram);
  const dirty = hasUnsavedChanges();
  els.programDirty.hidden = !dirty;
  els.programDirtyLabel.textContent = dirty ? "Unsaved changes" : "";
  els.delete.hidden = !currentProgram;
}

/** The "Open…" menu: your saved programs, then the examples. */
function fillProgramMenu(): void {
  els.programs.replaceChildren(new Option("Open…", "", true, true));
  const saved = programs.list(language);
  if (saved.length) {
    const group = document.createElement("optgroup");
    group.label = "Your programs";
    for (const program of saved) group.append(new Option(program.name, `saved:${program.id}`));
    els.programs.append(group);
  }
  // Examples, one group per topic, in the order the topics first appear.
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const [index, example] of LANGUAGES[language].examples.entries()) {
    const topic = example.group ?? "More";
    let group = groups.get(topic);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = `Examples: ${topic}`;
      groups.set(topic, group);
      els.programs.append(group);
    }
    group.append(new Option(example.name, `example:${index}`));
  }
}

function announce(message: string): void {
  els.announce.textContent = message;
}

let savedTimer = 0;
function showSaved(program: Program): void {
  announce(`Saved "${program.name}"`);
  els.save.textContent = "Saved";
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => { els.save.textContent = "Save"; }, 1200);
}

function writeProgram(name: string, id?: string): void {
  try {
    const program = programs.save({ id, name, language, code: editor.getCode() });
    setOpenProgram(program);
    fillProgramMenu();
    updateProgramUI();
    showSaved(program);
  } catch (error) {
    setBanner(escapeHtml(error instanceof Error ? error.message : String(error)));
  }
}

/** Ctrl/Cmd + S: save over the open program, or ask for a name the first time. */
function save(): void {
  if (currentProgram) writeProgram(currentProgram.name, currentProgram.id);
  else saveAs();
}

/** Ctrl/Cmd + Shift + S: always ask for a name. */
function saveAs(): void {
  if (els.saveDialog.open) return;
  els.saveName.value = currentProgram?.name ?? "";
  updateSaveHint();
  els.saveDialog.returnValue = "";
  els.saveDialog.showModal();
  els.saveName.select();
}

function updateSaveHint(): void {
  const existing = programs.findByName(language, els.saveName.value);
  const replacing = !!existing && existing.id !== currentProgram?.id;
  els.saveHint.textContent = replacing
    ? `A ${LANGUAGES[language].label} program with this name already exists. Saving replaces it.`
    : "Saved programs stay in this browser.";
  els.saveHint.classList.toggle("is-warning", replacing);
}

els.saveName.addEventListener("input", updateSaveHint);
els.saveDialog.querySelector<HTMLButtonElement>('button[value="cancel"]')!.addEventListener("click", (event) => {
  event.preventDefault();
  els.saveDialog.close("cancel");
});
els.saveDialog.addEventListener("close", () => {
  if (els.saveDialog.returnValue !== "save") return;
  const name = els.saveName.value.trim();
  if (!name) return;
  // Saving under an existing name replaces that program (the hint warned).
  writeProgram(name, programs.findByName(language, name)?.id);
  editor.editor.focus();
});

els.save.addEventListener("click", () => save());

els.delete.addEventListener("click", () => {
  if (!currentProgram) return;
  if (!window.confirm(`Delete "${currentProgram.name}"? This can't be undone.`)) return;
  const name = currentProgram.name;
  programs.remove(currentProgram.id);
  // The code stays in the editor, now as an unsaved program.
  setOpenProgram(null);
  fillProgramMenu();
  updateProgramUI();
  announce(`Deleted "${name}"`);
});

els.programs.addEventListener("change", () => {
  const [kind, key] = els.programs.value.split(/:(.*)/s);
  els.programs.value = "";
  const program = kind === "saved" ? programs.get(key) : undefined;
  const example = kind === "example" ? LANGUAGES[language].examples[Number(key)] : undefined;
  if (!program && !example) return;
  if (program && program.id === currentProgram?.id && !hasUnsavedChanges()) return;

  if (hasUnsavedChanges()) {
    const what = currentProgram ? `your changes to "${currentProgram.name}"` : "your unsaved program";
    if (!window.confirm(`Discard ${what}?`)) return;
  }
  selectedLoop = null;
  clearLayout(); // a different program has different boxes
  memoryView.restartAutoFit();
  loopView.restartAutoFit();
  setOpenProgram(program ?? null); // before setCode, so the dirty dot is right
  editor.setCode(program?.code ?? example!.code);
  updateProgramUI();
  runNow();
});

// ---------------------------------------------------------------- controls

for (const lang of Object.values(LANGUAGES)) els.language.append(new Option(lang.label, lang.id));
els.language.value = language;
els.language.addEventListener("change", () => {
  if (!isLanguageId(els.language.value) || els.language.value === language) return;
  window.clearTimeout(liveTimer);
  language = els.language.value;
  store(LANGUAGE_KEY, language);
  currentProgram = openProgramFor(language);
  editor.setLanguage(LANGUAGES[language].monacoId, savedCode(language));
  fillProgramMenu();
  fillSizeModels();
  updateProgramUI();
  // A trace from the other language has nothing to do with this code.
  trace = null;
  updateComplexity();
  memoryView.restartAutoFit();
  loopView.restartAutoFit();
  stepIndex = 0;
  selectedLoop = null;
  clearLayout();
  stale = false;
  setBanner(null);
  render();
  showStatus(runnerFor(language).status);
  runNow();
});
fillProgramMenu();
fillSizeModels();
els.sizes.setAttribute("aria-pressed", String(sizesOn));
els.sizeModel.hidden = !sizesOn;
updateProgramUI();

els.run.addEventListener("click", () => runNow());
els.hideQuiet.addEventListener("change", () => { hideQuiet = els.hideQuiet.checked; render(); });
els.first.addEventListener("click", () => goTo(firstStep()));
els.prev.addEventListener("click", () => goTo(stepIndex - 1));
els.next.addEventListener("click", () => goTo(stepIndex + 1));
els.last.addEventListener("click", () => goTo(Infinity));
els.scrubber.addEventListener("input", () => goTo(Number(els.scrubber.value)));

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  // Inside the editor, Monaco handles its own keys (including F10 / Shift+F10).
  if (target.closest(".monaco-editor")) return;

  // Ctrl + ' runs, and Ctrl/Cmd + Enter plays (or goes back to where
  // playing started), from anywhere on the page, not just the editor.
  if (event.ctrlKey && (event.code === "Quote" || event.key === "'")) {
    event.preventDefault();
    runNow();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    playOrRewind();
    return;
  }

  // Save works from anywhere, and should never open the browser's "Save page".
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!els.saveDialog.open) {
      if (event.shiftKey) saveAs();
      else save();
    }
    return;
  }
  if (els.saveDialog.open) return;

  // VS Code's debugger keys work everywhere else too.
  if (event.key === "F10") {
    event.preventDefault();
    goTo(stepIndex + (event.shiftKey ? -1 : 1));
    return;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  // Keys inside the Style panel belong to its controls.
  if (target.closest(".style-panel")) return;
  // Space plays and pauses, except where it already means something.
  if (event.key === " " && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    setPlaying(!playing);
    return;
  }
  const moves: Record<string, () => void> = {
    ArrowLeft: () => goTo(stepIndex - 1),
    ArrowRight: () => goTo(stepIndex + 1),
    Home: () => goTo(firstStep()),
    End: () => goTo(Infinity),
  };
  const move = moves[event.key];
  if (move) { event.preventDefault(); move(); }
});

// ---------------------------------------------------------------- layout

interface DividerOptions {
  axis: "x" | "y";
  /** The element whose size the divider splits. */
  container: HTMLElement;
  min: number;
  max: number;
  initial: number;
  storageKey: string;
  /** Apply a value (a percentage). */
  apply(value: number): void;
  /**
   * Turn a pointer position (percent along the container) into a value, and
   * say which way arrow keys move it. Defaults suit a value measured from
   * the left or top edge.
   */
  fromPointer?(percent: number): number;
  keyDirection?(): 1 | -1;
}

/** A draggable, keyboard-operable divider whose position is remembered. */
function makeDivider(divider: HTMLElement, options: DividerOptions): (value: number) => void {
  const { axis, container, min, max, initial, storageKey } = options;
  let value = initial;
  const set = (next: number) => {
    value = Math.round(Math.max(min, Math.min(max, next)));
    options.apply(value);
    divider.setAttribute("aria-valuenow", String(value));
    store(storageKey, String(value));
  };
  set(Number(stored(storageKey)) || initial);

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("is-dragging");
    const move = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const percent = axis === "x"
        ? ((e.clientX - rect.left) / rect.width) * 100
        : ((e.clientY - rect.top) / rect.height) * 100;
      set(options.fromPointer ? options.fromPointer(percent) : percent);
    };
    const stop = () => {
      divider.classList.remove("is-dragging");
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
      divider.removeEventListener("pointercancel", stop);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
    divider.addEventListener("pointercancel", stop);
  });

  divider.addEventListener("dblclick", () => set(initial));

  divider.addEventListener("keydown", (event) => {
    const [back, forward] = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const direction = event.key === back ? -1 : event.key === forward ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation(); // arrow keys elsewhere step through the program
    set(value + direction * 3 * (options.keyDirection?.() ?? 1));
  });

  return set;
}

// The editor/canvas split. The value is always the editor's share of the
// width, whichever side it's on.
const LAYOUT_KEY = "algoviz:layout";
let swapped = stored(LAYOUT_KEY) === "swapped";

makeDivider(els.divider, {
  axis: "x",
  container: els.workspace,
  min: 20,
  max: 75,
  initial: 40,
  storageKey: "algoviz:split",
  apply: (value) => els.workspace.style.setProperty("--split", `${value}%`),
  // Dragging or pressing arrows moves the divider itself, so which way the
  // editor grows depends on which side it's on.
  fromPointer: (percent) => (swapped ? 100 - percent : percent),
  keyDirection: () => (swapped ? -1 : 1),
});

// The memory / loop history split inside the canvas. The value is the
// memory section's share of the height.
makeDivider(els.canvasDivider, {
  axis: "y",
  container: els.canvas,
  min: 15,
  max: 85,
  initial: 55,
  storageKey: "algoviz:canvas-split",
  apply: (value) => els.canvas.style.setProperty("--canvas-split", `${value}%`),
});

/** Put the canvas on the left (or back on the right). */
function setSwapped(value: boolean): void {
  swapped = value;
  store(LAYOUT_KEY, swapped ? "swapped" : "normal");
  // Reorder the DOM, not just the visual order, so Tab moves through the
  // panes in the order they appear.
  const order = swapped ? [els.canvasPane, els.divider, els.editorPane] : [els.editorPane, els.divider, els.canvasPane];
  if (els.workspace.firstElementChild !== order[0]) els.workspace.append(...order);
  els.workspace.classList.toggle("is-swapped", swapped);
  els.swap.setAttribute("aria-pressed", String(swapped));
}

setSwapped(swapped);
els.swap.addEventListener("click", () => setSwapped(!swapped));

render();
run(editor.getCode());
