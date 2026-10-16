import "./styles.css";
import { escapeHtml } from "./app/html";
import { PlaybackController } from "./app/playbackController";
import { ProgramsController } from "./app/programsController";
import { RunController } from "./app/runController";
import { AppStore } from "./app/state";
import { type Appearance, applyAppearance, parseAppearance } from "./appearance";
import { ComplexityPanel, costLabels } from "./complexityPanel";
import { createEditor } from "./editor";
import { type GrowthSeries, GrowthView } from "./growthView";
import { isLanguageId, LANGUAGES, type LanguageId } from "./languages";
import { MEASURE_LIMITS, MeasurePanel, measureLabels } from "./measurePanel";
import { ProgramStore } from "./programs";
import { prefersReducedMotion } from "./render/animate";
import { renderLoopHistory } from "./render/loopView";
import { applyFocus, type MemoryMode, type Point, renderMemory } from "./render/memory";
import { type AutoFit, Viewport } from "./render/viewport";
import { createSettings, type Setting } from "./settings";
import { StylePanel } from "./stylePanel";
import { estimateComplexity } from "./trace/complexity";
import { diffSteps } from "./trace/diff";
import { findSizes, type GrowthPoint, ladder, pointFrom, staticGrowth } from "./trace/growth";
import {
  ALL_LOOPS,
  availableLoops,
  buildLoopHistory,
  buildNestedHistory,
  type LoopHistory,
  type LoopRow,
  nestedLoopsAt,
} from "./trace/loopHistory";
import { compact, duration, type Measurement } from "./trace/measurement";
import { formatBytes, SIZE_MODELS, type SizeModel, stepSizes } from "./trace/memory";
import { liveFrames, type Step, type Trace } from "./trace/types";

// ---------------------------------------------------------------- settings

/** Everything remembered between visits (see settings.ts). */
const settings = createSettings();

const savedCode = (id: LanguageId) => settings.code(id).get() ?? LANGUAGES[id].examples[0].code;

// Saved programs, and the app's state (the language, the open program...).
const programs = new ProgramStore(settings.programStorage());
const app = new AppStore(settings, programs);
const currentLanguage = () => app.get().language;

// ---------------------------------------------------------------- state

let selectedLoop: string | null = null;
let hideQuiet = true;
/** Loop history: containers one above another instead of side by side. */
let loopVertical = settings.loopVertical.get();

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
  loopVertical: byId<HTMLInputElement>("loop-vertical"),
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
  showOutput: byId<HTMLButtonElement>("show-output"),
  dimOutput: byId<HTMLButtonElement>("dim-output"),
  sizeModel: byId<HTMLSelectElement>("size-model"),
  memoryTotal: byId<HTMLSpanElement>("memory-total"),
  editorPane: byId<HTMLElement>("editor-pane"),
  canvasPane: byId<HTMLElement>("canvas-pane"),
  swap: byId<HTMLButtonElement>("swap"),
  style: byId<HTMLButtonElement>("style"),
  complexity: byId<HTMLButtonElement>("complexity"),
  measure: byId<HTMLButtonElement>("measure"),
  measureResults: byId<HTMLButtonElement>("measure-results"),
  memorySection: byId<HTMLElement>("memory-section"),
  loopSection: byId<HTMLElement>("loop-section"),
};

// ---------------------------------------------------------------- playback

const currentStep = () => app.get().stepIndex;
const currentTrace = () => app.get().trace;

const playback = new PlaybackController({
  app,
  els: {
    play: els.play,
    speed: els.speed,
    first: els.first,
    prev: els.prev,
    next: els.next,
    last: els.last,
    scrubber: els.scrubber,
  },
  stepCount: () => currentTrace()?.steps.length ?? 0,
  show: () => render(),
  ownsKeys: (target) => !!target.closest(".style-panel"),
  reducedMotion: prefersReducedMotion,
});

// ---------------------------------------------------------------- running code

function setBanner(html: string | null): void {
  els.banner.hidden = html === null;
  els.banner.innerHTML = html ?? "";
}

const runs = new RunController({
  app,
  status: els.status,
  editor: {
    setMarks: (marks) => editor.setMarks(marks),
    setHintWarnings: (warnings) => editor.setHintWarnings(warnings),
  },
  setBanner,
  onResult(updateMarks) {
    render(updateMarks);
    updateComplexity();
  },
  busy: () => measuring,
});

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
let memoryMode: MemoryMode = settings.memoryMode.get();

function setMemoryMode(mode: MemoryMode): void {
  memoryMode = mode;
  settings.memoryMode.set(mode);
  els.modeArrows.setAttribute("aria-pressed", String(mode === "arrows"));
  els.modeNested.setAttribute("aria-pressed", String(mode === "nested"));
  renderMemoryView();
}
let draggingNode: string | null = null;

// Memory sizes: on or off, and which model, per language family (Python
// has its own real sizes; JavaScript and TypeScript share theirs).
/** On a step that prints, show the output on the canvas and dim the rest. */
let outputOn = settings.showOutput.get();
/** ...and dim everything else while it's shown (off unless turned on). */
let dimForOutput = settings.dimOutput.get();

const sizeFamily = (id: LanguageId) => (id === "python" ? "python" : "javascript");
let sizesOn = settings.sizes.get();

function sizeModel(): SizeModel {
  const choices = SIZE_MODELS[sizeFamily(currentLanguage())];
  const saved = settings.sizeModel(sizeFamily(currentLanguage())).get();
  return choices.find((c) => c.value === saved)?.value ?? choices[0].value;
}
/** The model to draw sizes with, or null when sizes are off. */
const shownSizes = (): SizeModel | null => (sizesOn ? sizeModel() : null);

function fillSizeModels(): void {
  els.sizeModel.replaceChildren(
    ...SIZE_MODELS[sizeFamily(currentLanguage())].map((c) => {
      const option = new Option(c.label, c.value);
      option.title = c.title;
      return option;
    }),
  );
  els.sizeModel.value = sizeModel();
}

function setSizes(on: boolean): void {
  sizesOn = on;
  settings.sizes.set(on);
  els.sizes.setAttribute("aria-pressed", String(on));
  els.sizeModel.hidden = !on;
  render(false);
}

/** "Program: 1.4 KB" in the memory header, for the step on screen. */
function updateMemoryTotal(): void {
  const model = shownSizes();
  const step = currentTrace()?.steps[currentStep()];
  els.memoryTotal.hidden = !model || !step;
  if (!model || !step) return;
  const sizes = stepSizes(step, model);
  els.memoryTotal.textContent = `Program: ${formatBytes(sizes.program, sizes.approximate)}`;
  els.memoryTotal.title = "Everything the program holds at this step, each object counted once";
}

/** Auto-fit (see Viewport) is remembered per window. */
function storedAutoFit(pane: "memory" | "loop"): AutoFit {
  try {
    const raw = JSON.parse(settings.autoFit(pane).get() ?? "null") as Partial<AutoFit> | null;
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
  onAutoFitChange: (state) => settings.autoFit("memory").set(JSON.stringify(state)),
});
const loopView = new Viewport(els.loop, {
  label: "Loop history",
  onAutoFitChange: (state) => settings.autoFit("loop").set(JSON.stringify(state)),
});
memoryView.setAutoFit(storedAutoFit("memory"), false);
loopView.setAutoFit(storedAutoFit("loop"), false);

// ---------------------------------------------------------------- style

/** How the canvas looks (the Style panel). Applied as CSS variables, live. */
let appearance: Appearance = parseAppearance(settings.appearance.get());
let saveAppearanceTimer = 0;
function setAppearance(next: Appearance): void {
  appearance = next;
  applyAppearance(appearance, { canvas: els.canvas, memory: els.memorySection, loop: els.loopSection }, (pane, size) =>
    (pane === "memory" ? memoryView : loopView).setGridSize(size),
  );
  // Auto-fit glides with each window's step animation.
  memoryView.setZoomAnimation(appearance.memory.duration, appearance.memory.easing);
  loopView.setZoomAnimation(appearance.loop.duration, appearance.loop.easing);
  window.clearTimeout(saveAppearanceTimer);
  saveAppearanceTimer = window.setTimeout(() => settings.appearance.set(JSON.stringify(appearance)), 250);
}
setAppearance(appearance);
const stylePanel = new StylePanel({
  host: els.editorPane,
  button: els.style,
  get: () => appearance,
  set: setAppearance,
  replay: () => playback.replay(),
  onOpen: () => {
    complexityPanel.toggle(false);
    measurePanel.toggle(false);
  },
});

// ---------------------------------------------------------------- complexity

let costLabelsOn = settings.complexityLabels.get();
const complexityPanel = new ComplexityPanel({
  host: els.editorPane,
  button: els.complexity,
  reveal: (line) => editor.revealLine(line),
  labelsShown: () => costLabelsOn,
  setLabelsShown(on) {
    costLabelsOn = on;
    settings.complexityLabels.set(on);
    updateComplexity();
  },
  onOpen: () => {
    stylePanel.toggle(false);
    measurePanel.toggle(false);
  },
});

// ---------------------------------------------------------------- measure

/**
 * Measure: run the whole program at full size with counters instead of a
 * trace (see trace/measurement.ts). Runs only when asked: never on every
 * edit, since a big run can take a while. Live runs wait until it's done.
 */
let measuring = false;
/** The language being measured (the runner to stop, if the person switches away). */
let measuringLanguage: LanguageId = currentLanguage();
let measureLimit = settings.measureLimit.get() || 20_000;
if (!MEASURE_LIMITS.some((l) => l.ms === measureLimit)) measureLimit = 20_000;
let measureLabelsOn = settings.measureLabels.get();
/** The last measurement and the code it was for (labels are hidden once the code changes). */
let measured: { result: Measurement; code: string; language: LanguageId } | null = null;

/** A top-level `name = number` to suggest a `viz: size` hint for: the biggest number. */
function sizeSuggestion(code: string): { name: string; line: number } | null {
  let best: { name: string; line: number; value: number } | null = null;
  code.split("\n").forEach((text, i) => {
    const m =
      /^(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|. ]+?\s*)?=\s*([0-9][0-9_]*)\s*;?\s*(?:(?:#|\/\/).*)?$/.exec(
        text,
      );
    const value = m ? Number(m[2].replace(/_/g, "")) : 0;
    if (m && value >= 8 && (!best || value > best.value)) best = { name: m[1], line: i + 1, value };
  });
  return best ? { name: (best as { name: string }).name, line: (best as { line: number }).line } : null;
}

const growthView = new GrowthView({
  sizes: () => findSizes(editor.getCode()),
  suggestion: () => sizeSuggestion(editor.getCode()),
  addHint(name, line) {
    const lines = editor.getCode().split("\n");
    const comment = currentLanguage() === "python" ? "#" : "//";
    lines.splice(line - 1, 0, `${comment} viz: size ${name}`);
    editor.setCode(lines.join("\n"));
    growthView.render();
  },
  start: (scaled) => measureGrowth(scaled),
  stop: () => runs.runnerFor(measuringLanguage).stopMeasure(),
  kept: () => settings.growthKept(currentLanguage()),
});

const measurePanel = new MeasurePanel({
  growth: growthView.el,
  renderGrowth: () => growthView.render(),
  host: els.editorPane,
  reveal: (line) => editor.revealLine(line),
  labelsShown: () => measureLabelsOn,
  setLabelsShown(on) {
    measureLabelsOn = on;
    settings.measureLabels.set(on);
    updateMeasureLabels();
  },
  limit: () => measureLimit,
  setLimit(ms) {
    measureLimit = ms;
    settings.measureLimit.set(ms);
  },
  measureAgain: () => measureNow(),
  estimate: () => {
    try {
      const { trace, stale } = app.get();
      return trace ? (estimateComplexity(trace, stale ? null : currentMeasurement())?.time ?? null) : null;
    } catch {
      return null;
    }
  },
  onOpen: () => {
    stylePanel.toggle(false);
    complexityPanel.toggle(false);
    els.measureResults.setAttribute("aria-expanded", "true");
  },
});
new MutationObserver(() => els.measureResults.setAttribute("aria-expanded", String(measurePanel.isOpen))).observe(
  measurePanel.el,
  { attributes: true, attributeFilter: ["hidden"] },
);

/** Measure's result, when it's for the code in the editor now. */
function currentMeasurement(): Measurement | null {
  return measured && measured.language === currentLanguage() && measured.code === editor.getCode()
    ? measured.result
    : null;
}

function updateMeasureLabels(): void {
  const current = currentMeasurement();
  editor.setMeasureLabels(measureLabelsOn ? measureLabels(current) : []);
}

function setMeasureButton(on: boolean): void {
  els.measure.textContent = on ? "Stop" : "Measure";
  els.measure.classList.toggle("is-measuring", on);
  els.measure.title = on
    ? "Stop measuring"
    : "Run the whole program at full size, counting how many times each line runs (Ctrl + Shift + ')";
}

/**
 * Growth runs: Measure at n/64, n/16, n/4 and n (the `viz: size` variables
 * in `scaled` grow; others stay at their full size), then fit the counts
 * and compare with the code's estimate.
 */
async function measureGrowth(scaled?: string[]): Promise<void> {
  if (measuring) return;
  const code = editor.getCode();
  const lang = currentLanguage();
  const { vars } = findSizes(code);
  const grow = scaled ?? vars.map((v) => v.name);
  const rungs = ladder(vars, grow);
  measurePanel.toggle(true);
  if (rungs.length < 2) {
    growthView.render();
    return;
  }
  playback.setPlaying(false);
  measuring = true;
  measuringLanguage = lang;
  setMeasureButton(true);
  await runs.whenIdle();
  const x = grow[0];
  const points: GrowthPoint[] = [];
  let stopped: GrowthSeries["stopped"];
  for (const [i, rung] of rungs.entries()) {
    const label = `Measuring ${x} = ${rung.x.toLocaleString()} (${i + 1} of ${rungs.length})…`;
    growthView.setProgress(label);
    const outcome = await runs
      .runnerFor(lang)
      .measure(code, measureLimit, (p) => growthView.setProgress(`${label} ${duration(p.elapsedMs)}`), rung.sizes);
    const full = rungs[rungs.length - 1].x;
    const at = `At ${x} = ${rung.x.toLocaleString()}`;
    if (outcome.kind !== "measured") {
      stopped = {
        x: full,
        why:
          outcome.kind === "stopped" && outcome.reason === "person"
            ? `Stopped at ${x} = ${rung.x.toLocaleString()}.`
            : `${at} the run didn't stop at the time limit.`,
      };
      break;
    }
    const m = outcome.result;
    if (m.status === "error") {
      stopped = {
        x: full,
        why: `${at} the program stopped with ${m.error?.type ?? "an error"}: ${m.error?.message ?? ""}`,
      };
      break;
    }
    if (m.status === "limit") {
      stopped = { x: full, why: `${at} it reached the ${duration(measureLimit)} time limit.` };
      break;
    }
    points.push(pointFrom(rung, m));
  }
  measuring = false;
  setMeasureButton(false);
  runs.refreshStatus();
  // The code's estimate, from the trace of this same code.
  let expected = null;
  try {
    const { trace, stale, tracedCode } = app.get();
    const estimate = trace && !stale && tracedCode === code ? estimateComplexity(trace) : null;
    expected = estimate ? staticGrowth(estimate, vars, grow) : null;
  } catch {
    expected = null;
  }
  if (lang === currentLanguage())
    growthView.setResult({ label: "This version", x, scaled: grow, points, stopped, expected });
  else growthView.setProgress(null);
  runs.resumeQueued();
}

async function measureNow(): Promise<void> {
  if (measuring) {
    runs.runnerFor(measuringLanguage).stopMeasure();
    return;
  }
  playback.setPlaying(false);
  const code = editor.getCode();
  const lang = currentLanguage();
  measuring = true;
  measuringLanguage = lang;
  setMeasureButton(true);
  // A traced run may be finishing: measure right after it.
  await runs.whenIdle();
  const started = performance.now();
  const showProgress = (text: string) => {
    if (lang === currentLanguage()) els.status.textContent = text;
  };
  showProgress("Measuring…");
  const tick = window.setInterval(() => showProgress(`Measuring… ${duration(performance.now() - started)}`), 500);
  const outcome = await runs.runnerFor(lang).measure(code, measureLimit, (p) => {
    const share = p.loop
      ? ` · ${Math.min(99, Math.floor((100 * p.loop.done) / p.loop.total))}% of line ${p.loop.line}'s loop`
      : "";
    showProgress(`Measuring… ${duration(p.elapsedMs)}${share}`);
  });
  window.clearInterval(tick);
  measuring = false;
  setMeasureButton(false);
  runs.refreshStatus();
  if (lang === currentLanguage()) {
    if (outcome.kind === "measured") {
      measured = { result: outcome.result, code, language: lang };
      updateComplexity();
      els.measureResults.hidden = false;
      measurePanel.show(outcome.result, code);
      updateMeasureLabels();
    } else if (outcome.kind === "stopped") {
      setBanner(
        outcome.reason === "person"
          ? "Measuring stopped. Nothing was counted, since the run was cut off from outside."
          : `The program didn't stop at the ${duration(measureLimit)} limit (probably stuck inside one long built-in call), so it was stopped from outside.`,
      );
    } else {
      setBanner(`Measuring failed: <code>${escapeHtml(outcome.message)}</code>`);
    }
  }
  // Edits made while measuring were waiting.
  runs.resumeQueued();
}
els.measure.addEventListener("click", () => measureNow());
els.measureResults.addEventListener("click", () => measurePanel.toggle());

/**
 * The estimate is worked out once per run (it's cached on the trace), after
 * the step is drawn so it never delays the canvas.
 */
let complexityTimer = 0;
function updateComplexity(): void {
  window.clearTimeout(complexityTimer);
  complexityTimer = window.setTimeout(() => {
    const { trace, stale } = app.get();
    let estimate = null;
    try {
      // A trace cut short uses Measure's full counts for the same code, if there are any.
      estimate = trace ? estimateComplexity(trace, stale ? null : currentMeasurement()) : null;
    } catch (error) {
      console.warn("Complexity estimate failed", error);
    }
    complexityPanel.show(estimate, stale);
    // Labels sit on lines; once the code has changed under an error, they'd be on the wrong ones.
    editor.setCostLabels(costLabelsOn && !stale ? costLabels(estimate) : []);
  }, 0);
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
  const trace = currentTrace();
  if (!trace?.steps.length) return;
  const stepIndex = currentStep();
  const diff = diffSteps(trace.steps[stepIndex - 1], trace.steps[stepIndex]);
  const animation = animationFor("memory");
  memoryView.setContent(
    renderMemory(trace, stepIndex, diff, {
      positions,
      raise: draggingNode,
      mode: memoryMode,
      sizes: shownSizes(),
      output: outputOn,
      dimForOutput,
    }),
    "",
    animation.duration,
    animation.easing,
    animation.enter,
  );
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
els.showOutput.addEventListener("click", () => {
  outputOn = !outputOn;
  settings.showOutput.set(outputOn);
  els.showOutput.setAttribute("aria-pressed", String(outputOn));
  els.dimOutput.disabled = !outputOn;
  render(false);
});
els.dimOutput.addEventListener("click", () => {
  dimForOutput = !dimForOutput;
  settings.dimOutput.set(dimForOutput);
  els.dimOutput.setAttribute("aria-pressed", String(dimForOutput));
  render(false);
});
els.sizeModel.addEventListener("change", () => {
  settings.sizeModel(sizeFamily(currentLanguage())).set(els.sizeModel.value);
  render(false);
});

function render(updateMarks = true): void {
  const { trace, stale } = app.get();
  els.canvas.classList.toggle("is-stale", stale);
  const total = trace?.steps.length ?? 0;
  const stepIndex = currentStep();
  playback.updateControls();

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
  const skipped = (step.skipped ?? 0) + (stepIndex === trace.steps.length - 1 ? (step.skippedAfter ?? 0) : 0);
  if (skipped) {
    // Passes in the middle of a long loop ran here without being recorded.
    els.stepLabel.textContent += ` (${compact(skipped)} steps skipped)`;
    els.stepLabel.title += `\n${skipped.toLocaleString()} steps ran ${step.skipped ? "just before this one" : "after this one"} without being recorded: the middle of a long, sampled loop.`;
  }

  renderMemoryView();

  // Loop history and its tabs.
  // Nested loops are drawn together unless one loop is picked (animated
  // mode always shows one: the live state of a single loop).
  const { contexts } = availableLoops(trace, stepIndex);
  const together = loopMode === "stacked" && nestedLoopsAt(trace, stepIndex).length > 0;
  const wantsAll = together && (selectedLoop === null || selectedLoop === ALL_LOOPS);
  const history =
    (wantsAll ? buildNestedHistory(trace, stepIndex) : null) ??
    buildLoopHistory(trace, stepIndex, selectedLoop === ALL_LOOPS ? null : selectedLoop);
  const tab = (text: string, selected: boolean, pick: string, title = "") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "loop-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selected));
    button.textContent = text;
    if (title) button.title = title;
    button.addEventListener("click", () => {
      selectedLoop = pick;
      render();
    });
    return button;
  };
  els.loopTabs.replaceChildren(
    ...(together
      ? [
          tab(
            "All loops",
            !!history?.nested,
            ALL_LOOPS,
            "Every loop in this function, together: each pass of an inner loop under the pass of the loop around it",
          ),
        ]
      : []),
    ...contexts.map((ctx) => {
      const info = trace!.loops.find((loop) => loop.id === ctx.loop);
      return tab(
        `${info?.header ?? ctx.loop}  (line ${info?.line ?? "?"})`,
        !history?.nested && history?.info.id === ctx.loop,
        ctx.loop,
      );
    }),
  );
  if (history?.rows.length) {
    const live = loopMode === "animated" ? liveRows(trace, stepIndex, history) : undefined;
    const animation = animationFor("loop");
    loopView.setContent(
      renderLoopHistory(trace, history, { hideQuiet, live, sizes: shownSizes(), vertical: loopVertical }),
      "",
      live ? animation.duration : 0,
      animation.easing,
      animation.enter,
    );
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
      error:
        atEnd && trace.error
          ? { line: trace.error.line, message: `${trace.error.type}: ${trace.error.message}` }
          : null,
    });
  }
}

// ---------------------------------------------------------------- animation

/**
 * How a window animates the step being drawn: its own easing and duration
 * (from the Style panel), shortened while playing so an animation always
 * ends before the next step starts. Duration 0 means no animation.
 */
function animationFor(pane: "memory" | "loop"): {
  duration: number;
  easing: string;
  enter: { fade: boolean; slide: boolean };
} {
  const { duration, easing, enterFade, enterSlide } = appearance[pane];
  const enter = { fade: enterFade, slide: enterSlide };
  const animation = playback.animation;
  if (!animation) return { duration: 0, easing, enter };
  const cap = animation.playing ? (0.75 * 1000) / app.get().speed : Number.POSITIVE_INFINITY;
  return { duration: Math.round(Math.min(duration, cap)), easing, enter };
}

// Loop history: a row per iteration, or one live row that animates.
let loopMode: "stacked" | "animated" = settings.loopMode.get();

function setLoopMode(mode: "stacked" | "animated"): void {
  loopMode = mode;
  settings.loopMode.set(mode);
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

els.loopStacked.addEventListener("click", () => setLoopMode("stacked"));
els.loopAnimated.addEventListener("click", () => setLoopMode("animated"));
els.loopStacked.setAttribute("aria-pressed", String(loopMode === "stacked"));
els.loopAnimated.setAttribute("aria-pressed", String(loopMode === "animated"));

// ---------------------------------------------------------------- editor

let growthTimer = 0;
const editor = createEditor(
  els.editor,
  { monacoId: LANGUAGES[currentLanguage()].monacoId, code: savedCode(currentLanguage()) },
  {
    onChange(code) {
      playback.setPlaying(false);
      settings.code(currentLanguage()).set(code);
      programsController.updateUI();
      // The growth section reads the code's `viz: size` hints.
      window.clearTimeout(growthTimer);
      if (measurePanel.isOpen && !growthView.running) growthTimer = window.setTimeout(() => growthView.render(), 250);
      if (els.live.checked) runs.scheduleLive(code);
      else runs.cancelLive();
      // A measurement is for the code it ran: once that changes, its counts would sit on the wrong lines.
      if (measured) {
        updateMeasureLabels();
        if (measured.code !== code) measurePanel.markStale();
      }
    },
    // Also available from the command palette (F1) as "AlgoViz: ...".
    commands: {
      run: () => runNow(),
      save: () => programsController.save(),
      saveAs: () => programsController.saveAs(),
      nextStep: () => playback.step(1),
      prevStep: () => playback.step(-1),
      firstStep: () => playback.goTo(playback.firstStep()),
      lastStep: () => playback.goTo(Number.POSITIVE_INFINITY),
      swapPanels: () => setSwapped(!swapped),
      togglePlay: () => playback.togglePlay(),
      playOrRewind: () => playback.playOrRewind(),
      measure: () => measureNow(),
      measureGrowth: () => measureGrowth(),
      toggleNested: () => setMemoryMode(memoryMode === "nested" ? "arrows" : "nested"),
    },
  },
);

function runNow(): void {
  playback.setPlaying(false);
  runs.runNow(editor.getCode());
}

// ---------------------------------------------------------------- saved programs

/** Load code into the editor as a newly opened program, and run it. */
function loadProgram(code: string): void {
  selectedLoop = null;
  clearLayout(); // a different program has different boxes
  memoryView.restartAutoFit();
  loopView.restartAutoFit();
  editor.setCode(code);
  runNow();
}

const programsController = new ProgramsController({
  app,
  programs,
  els: {
    menu: els.programs,
    name: els.programName,
    dirty: els.programDirty,
    dirtyLabel: els.programDirtyLabel,
    save: els.save,
    delete: els.delete,
    dialog: els.saveDialog,
    dialogName: els.saveName,
    dialogHint: els.saveHint,
    announce: els.announce,
  },
  editor: { getCode: () => editor.getCode(), focus: () => editor.editor.focus() },
  load: loadProgram,
  showError: (message) => setBanner(escapeHtml(message)),
});

// ---------------------------------------------------------------- controls

for (const lang of Object.values(LANGUAGES)) els.language.append(new Option(lang.label, lang.id));
els.language.value = currentLanguage();
els.language.addEventListener("change", () => {
  if (!isLanguageId(els.language.value) || els.language.value === currentLanguage()) return;
  runs.cancelLive();
  app.setLanguage(els.language.value); // also reopens that language's program and refills the Open menu
  editor.setLanguage(LANGUAGES[currentLanguage()].monacoId, savedCode(currentLanguage()));
  fillSizeModels();
  programsController.updateUI();
  growthView.reload();
  // A trace from the other language has nothing to do with this code.
  app.clearTrace();
  if (measuring) runs.runnerFor(measuringLanguage).stopMeasure();
  els.measureResults.hidden = !measured || measured.language !== currentLanguage();
  measurePanel.toggle(false);
  updateMeasureLabels();
  updateComplexity();
  memoryView.restartAutoFit();
  loopView.restartAutoFit();
  selectedLoop = null;
  clearLayout();
  setBanner(null);
  render();
  runs.refreshStatus();
  runNow();
});
fillSizeModels();
els.sizes.setAttribute("aria-pressed", String(sizesOn));
els.showOutput.setAttribute("aria-pressed", String(outputOn));
els.dimOutput.setAttribute("aria-pressed", String(dimForOutput));
els.dimOutput.disabled = !outputOn;
els.sizeModel.hidden = !sizesOn;

els.run.addEventListener("click", () => runNow());
els.banner.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "measure") measureNow();
  else if (action === "run") runNow();
});
els.hideQuiet.addEventListener("change", () => {
  hideQuiet = els.hideQuiet.checked;
  render();
});
els.loopVertical.checked = loopVertical;
els.loopVertical.addEventListener("change", () => {
  loopVertical = els.loopVertical.checked;
  settings.loopVertical.set(loopVertical);
  render();
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  // Inside the editor, Monaco handles its own keys (including F10 / Shift+F10).
  if (target.closest(".monaco-editor")) return;

  // Ctrl + ' runs, and Ctrl/Cmd + Enter plays (or goes back to where
  // playing started), from anywhere on the page, not just the editor.
  if (event.ctrlKey && (event.code === "Quote" || event.key === "'" || event.key === '"')) {
    event.preventDefault();
    if (event.shiftKey) measureNow();
    else runNow();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    playback.handleKey(event);
    return;
  }

  // Save works from anywhere, and should never open the browser's "Save page".
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!els.saveDialog.open) {
      if (event.shiftKey) programsController.saveAs();
      else programsController.save();
    }
    return;
  }
  if (els.saveDialog.open) return;

  // Stepping and playing: arrows, Home / End, Space, F10, Ctrl/Cmd + Enter.
  playback.handleKey(event);
});

// ---------------------------------------------------------------- layout

interface DividerOptions {
  axis: "x" | "y";
  /** The element whose size the divider splits. */
  container: HTMLElement;
  min: number;
  max: number;
  initial: number;
  /** Where the position is remembered. */
  saved: Setting<number | null>;
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
  const { axis, container, min, max, initial, saved } = options;
  let value = initial;
  const set = (next: number) => {
    value = Math.round(Math.max(min, Math.min(max, next)));
    options.apply(value);
    divider.setAttribute("aria-valuenow", String(value));
    saved.set(value);
  };
  set(saved.get() || initial);

  divider.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("is-dragging");
    const move = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const percent =
        axis === "x" ? ((e.clientX - rect.left) / rect.width) * 100 : ((e.clientY - rect.top) / rect.height) * 100;
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
let swapped = settings.swapped.get();

makeDivider(els.divider, {
  axis: "x",
  container: els.workspace,
  min: 20,
  max: 75,
  initial: 40,
  saved: settings.split,
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
  saved: settings.canvasSplit,
  apply: (value) => els.canvas.style.setProperty("--canvas-split", `${value}%`),
});

/** Put the canvas on the left (or back on the right). */
function setSwapped(value: boolean): void {
  swapped = value;
  settings.swapped.set(swapped);
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
runs.runNow(editor.getCode());

// Everything is wired up: drop the loading skeleton from index.html.
document.documentElement.classList.remove("is-booting");
