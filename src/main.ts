/**
 * The app's entry point: creates the state, the editor and the controllers
 * (src/app/), and connects them. Each controller owns one part of the page
 * and reacts to the state itself; see docs/development.md, "How the app is
 * put together".
 */

import { prefersReducedMotion } from "./appearance";
import { perf } from "./perf";
import { SVG_RENDERERS } from "./render/svgRenderers";
import "./styles.css";
import { isTall } from "./app/autoFit";
import { Banner, type BannerTone } from "./app/banner";
import { ChangesView } from "./app/changesView";
import { ComplexityController } from "./app/complexityController";
import { ConsoleSize } from "./app/consoleSize";
import { CsvImportController } from "./app/csvImport";
import { WindowDocking } from "./app/docking";
import { findElements } from "./app/elements";
import { FindController } from "./app/findController";
import { HistoryController } from "./app/historyController";
import { escapeHtml } from "./app/html";
import { InputController } from "./app/inputController";
import { showLanguageKind } from "./app/languageKind";
import { LayoutController } from "./app/layout";
import { LoadingCard } from "./app/loadingCard";
import { LoopController } from "./app/loopController";
import { MeasureController } from "./app/measureController";
import { MemoryController } from "./app/memoryController";
import { MobileViewsController } from "./app/mobileViews";
import { PlaybackController } from "./app/playbackController";
import { ProgramsController } from "./app/programsController";
import { RendererSwitch } from "./app/rendererSwitch";
import { resizeRedraw } from "./app/resizeRedraw";
import { LanguageRoutes, languageFromPath } from "./app/routing";
import { RunController } from "./app/runController";
import { RunProgressView } from "./app/runProgress";
import { addSaveSvg, svgFileName } from "./app/saveSvg";
import { toolsMenu } from "./app/sectionTools";
import { SeekController } from "./app/seekController";
import { ShareController } from "./app/shareController";
import { installShortcuts } from "./app/shortcuts";
import { SpacingController } from "./app/spacingController";
import { AppStore } from "./app/state";
import { StepView } from "./app/stepView";
import { StyleController } from "./app/styleController";
import { createEditor } from "./editor";
import { isLanguageId, LANGUAGES, type LanguageId } from "./languages";
import { WorkerLayout } from "./layout/client";
import { type LayoutService, LocalLayout } from "./layout/service";
import { ProgramStore } from "./programs";
import { createSettings, type RendererKind } from "./settings";

// ?perf: time each stage of drawing a step, for the browser benchmark (src/perf.ts, bench/README.md).
const query = new URLSearchParams(window.location.search);
// ?nolod: everything drawn in full at every zoom, to measure what levels of detail save.
perf.noLod = query.has("nolod");
// ?noshare: no geometry shared between Graphics (canvas/pixiScene.ts), to measure what sharing saves.
perf.noShare = query.has("noshare");
perf.noCells = query.has("nocells");
perf.noGroups = query.has("nogroups");
perf.noFreeze = query.has("nofreeze");
if (query.has("perf")) {
  perf.on = true;
  (window as unknown as { __pr0l1nePerf: typeof perf }).__pr0l1nePerf = perf;
}

/** Everything remembered between visits (see settings.ts). */
const settings = createSettings();
// A language's own page (/python...): that language, which is then the one
// used last (so pr0l1ne.com opens it next time; see app/routing.ts).
const routed = languageFromPath(window.location.pathname);
if (routed) settings.language.set(routed);
const savedCode = (id: LanguageId) => settings.code(id).get() ?? LANGUAGES[id].examples[0].code;

// Saved programs, and the app's state (the language, the open program, the trace...).
const programs = new ProgramStore(settings.programStorage());
const app = new AppStore(settings, programs);
const currentLanguage = () => app.get().language;
/** Measure (and Complexity) are for programs, not SQL queries. */
const measurable = () => LANGUAGES[currentLanguage()].kind === "program";
const els = findElements();
showLanguageKind(LANGUAGES[currentLanguage()].kind);
// What draws the two windows (see scene/renderer.ts): SVG, or the canvas
// (PixiJS) on WebGL (the one offered, falling back to Canvas 2D) or Canvas 2D,
// which is only downloaded when someone picks it. Windows start with SVG,
// which is ready at once, and switch once the canvas is.
const rendererSwitch = new RendererSwitch(
  {
    svg: () => SVG_RENDERERS,
    canvas: () => import("./render/canvas/canvasRenderers").then((m) => m.CANVAS_RENDERERS),
    webgl: () => import("./render/canvas/canvasRenderers").then((m) => m.WEBGL_RENDERERS),
  },
  { kind: "svg", factory: SVG_RENDERERS },
);
const renderers = rendererSwitch.factory;

/** Draw with this renderer from now on (the Style panel's Rendering choice). */
function useRenderer(kind: RendererKind): Promise<void> {
  settings.renderer.set(kind);
  return rendererSwitch.use(kind).catch((error: unknown) => {
    // It couldn't start here: the windows are back on SVG, and stay there.
    settings.renderer.set(rendererSwitch.active);
    throw error;
  });
}

const loadingCard = new LoadingCard(els.loadingCard);
const banner = new Banner(els.banner, {
  run: () => runNow(),
  measure: () => {
    if (measurable()) void measure.measure();
  },
  reload: () => window.location.reload(),
  "save-shared": () => programsController.saveAs(),
});
const setBanner = (html: string | null, tone?: BannerTone) => banner.show(html, tone);

// ---------------------------------------------------------------- the editor

const editor = createEditor(
  els.editor,
  { monacoId: LANGUAGES[currentLanguage()].monacoId, code: savedCode(currentLanguage()) },
  {
    onChange(code) {
      playback.setPlaying(false);
      // A program from a share link, just put there: nothing to remember or run until it's edited.
      if (shares.isUnedited(code)) {
        programsController.updateUI();
        return;
      }
      settings.code(currentLanguage()).set(code);
      programsController.updateUI();
      inputs.codeChanged();
      if (els.live.checked) runs.scheduleLive(code);
      else runs.cancelLive();
      measure.codeChanged(code);
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
      swapPanels: () => layout.toggleSwapped(),
      togglePlay: () => playback.togglePlay(),
      playOrRewind: () => playback.playOrRewind(),
      measure: () => {
        if (measurable()) void measure.measure();
      },
      measureGrowth: () => {
        if (measurable()) void measure.measureGrowth();
      },
      toggleNested: () => memory.toggleNested(),
      runToCursor: (back) => seek.runToCursor(back),
    },
  },
);

// ---------------------------------------------------------------- stepping, running and drawing

const playback = new PlaybackController({
  app,
  els,
  stepCount: () => app.get().trace?.steps ?? 0,
  show: () => view.render(),
  ownsKeys: (target) => !!target.closest(".style-panel"),
  reducedMotion: prefersReducedMotion,
});

// How a run is going, while it goes: the toolbar's line, and for Run a card over the canvas, each with Stop.
const runProgress = new RunProgressView(
  {
    line: els.runProgress,
    card: els.runCard,
    canvas: els.canvas,
    announce: (text) => {
      els.announce.textContent = text;
    },
  },
  () => runs.stop(),
);
// The trace's preparation and every window's layout, off the page's thread (src/layout/): in the layout
// worker, or on the page where a worker can't start.
const drawings: LayoutService = (() => {
  try {
    return new WorkerLayout();
  } catch (error) {
    console.error("The layout worker couldn't start; laying out on the page:", error);
    return new LocalLayout();
  }
})();

const runs = new RunController({
  app,
  status: els.status,
  editor,
  setBanner,
  progress: runProgress,
  layout: drawings,
  drawn: () => Promise.all([memory.drawn(), loop.drawn()]).then(() => {}),
  onResult: (updateMarks) => view.render(updateMarks),
  onStatus: (status, download) => loadingCard.show(status, download),
  prepare: (code, language) => inputs.prepare(code, language),
});

// Inputs you can switch between (`viz: input`): the code window's Input menu, and the code that's run.
const inputs: InputController = new InputController({
  app,
  els,
  editor,
  run: () => runNow(),
  changed: () => measure.codeChanged(editor.getCode()),
});

function runNow(): void {
  playback.setPlaying(false);
  runs.runNow(editor.getCode());
}

const memory: MemoryController = new MemoryController({
  app,
  renderers,
  settings,
  els,
  animation: () => style.animationFor("memory"),
  redraw: () => view.render(false),
  layout: drawings,
  history: {
    hover: (target, x, y) => valueHistory.hover(target, x, y),
    jump: (target, back) => void valueHistory.jump(target, back),
  },
});
const loop: LoopController = new LoopController({
  app,
  renderers,
  settings,
  els,
  sizes: () => memory.sizes(),
  animation: () => style.animationFor("loop"),
  redraw: (updateMarks) => view.render(updateMarks),
  layout: drawings,
});
perf.whenDrawn = () => Promise.all([memory.drawn(), loop.drawn()]).then(() => {});
// A value's history: hover a variable or a cell (or a change's name in the Changes list); click one for its next change.
const valueHistory: HistoryController = new HistoryController({
  app,
  layout: drawings,
  goTo: (step) => playback.goTo(step),
  firstStep: () => playback.firstStep(),
  host: document.body,
});
// Under the code: what was printed, or what changed at the step, as tall as it's dragged; and finding a step.
const changes = new ChangesView({
  app,
  settings,
  layout: drawings,
  els,
  history: { show: (target, at) => void valueHistory.show(target, at) },
});
new FindController({
  app,
  layout: drawings,
  els,
  goTo: (step) => playback.goTo(step),
  firstStep: () => playback.firstStep(),
});
new ConsoleSize({ settings, els });
const view = new StepView({
  app,
  els,
  memory,
  loop,
  editor,
  changes,
  updateControls: () => playback.updateControls(),
});
// Run to a line: the gutter beside it, or Ctrl + F10 at the cursor.
const seek: SeekController = new SeekController({
  app,
  settings,
  toggle: els.runToToggle,
  editor: {
    setRunToLine: (on) => editor.setRunToLine(on),
    setRunnable: (lines) => editor.setRunnable(lines),
    onGutterClick: (handler) => editor.onGutterClick(handler),
    showMessage: (line, text) => editor.showMessage(line, text),
    cursorLine: () => editor.editor.getPosition()?.lineNumber ?? null,
  },
  goTo: (step) => playback.goTo(step),
  firstStep: () => playback.firstStep(),
});
for (const [pane, renderer] of [
  ["memory", memory.renderer],
  ["loop", loop.renderer],
] as const) {
  addSaveSvg(renderer, () => svgFileName(app.get().program?.name ?? null, pane, app.get().stepIndex));
}

// ---------------------------------------------------------------- the panels (one open at a time)

const style: StyleController = new StyleController({
  app,
  settings,
  els,
  views: { memory: memory.renderer, loop: loop.renderer },
  animation: () => playback.animation,
  replay: () => playback.replay(),
  redraw: () => view.render(false),
  onOpen: () => closePanelsBut("style"),
  rendering: {
    get: () => settings.renderer.get(),
    set: useRenderer,
    drawnWith: () => els.memory.dataset.backend ?? null,
  },
});
// The Layout panel: the memory and loop views' spacing, redrawn as it changes.
const spacing = new SpacingController({
  settings,
  els,
  redraw: () => view.render(false),
  onOpen: () => closePanelsBut("spacing"),
});
const complexity: ComplexityController = new ComplexityController({
  app,
  settings,
  els,
  editor,
  measurement: () => measure.current(),
  estimate: (measurement) => drawings.estimate(measurement),
  onOpen: () => closePanelsBut("complexity"),
});
const measure: MeasureController = new MeasureController({
  app,
  settings,
  runs,
  els,
  editor,
  setBanner,
  pause: () => playback.setPlaying(false),
  onMeasured: () => complexity.update(),
  estimate: () => complexity.latest,
  onOpen: () => closePanelsBut("measure"),
  prepare: (code, language) => inputs.prepare(code, language).code,
});

function closePanelsBut(open: "style" | "spacing" | "complexity" | "measure"): void {
  for (const [name, panel] of Object.entries({ style, spacing, complexity, measure })) if (name !== open) panel.close();
}

// ---------------------------------------------------------------- saved programs and the language

const programsController = new ProgramsController({
  app,
  programs,
  els,
  editor: { getCode: () => editor.getCode(), focus: () => editor.editor.focus() },
  // A newly opened program has different boxes and loops: start its picture afresh.
  load(code) {
    memory.reset();
    loop.reset();
    editor.setCode(code);
    runNow();
  },
  showError: (message) => setBanner(escapeHtml(message)),
});

for (const lang of Object.values(LANGUAGES)) els.language.append(new Option(lang.label, lang.id));
els.language.value = currentLanguage();
els.language.addEventListener("change", () => {
  if (!isLanguageId(els.language.value) || els.language.value === currentLanguage()) return;
  switchLanguage(els.language.value);
  routes.show(currentLanguage());
});

/** Switch the editor to another language (the language menu, or Back to another language's page). */
function switchLanguage(language: LanguageId): void {
  // The controllers catch up themselves (app.watch): the trace, Measure, the canvas, the Open menu...
  app.setLanguage(language);
  els.language.value = language;
  showLanguageKind(LANGUAGES[currentLanguage()].kind);
  editor.setLanguage(LANGUAGES[currentLanguage()].monacoId, savedCode(currentLanguage()));
  inputs.codeChanged(); // the new language's code (a model switch isn't an edit)
  programsController.updateUI(); // the unsaved-changes dot, for this language's code
  setBanner(null);
  view.render();
  runNow();
}

// Each language has its own page, /python and so on: the address follows the language, and Back and Forward switch it.
const routes = new LanguageRoutes({
  current: currentLanguage,
  switchTo: (language) => switchLanguage(language),
});

// ---------------------------------------------------------------- the rest of the page

// ---------------------------------------------------------------- share links

const shares = new ShareController({
  app,
  els,
  editor,
  setBanner,
  isLanguage: isLanguageId,
  languageLabel: (id) => (isLanguageId(id) ? LANGUAGES[id].label : id),
  hasUnsavedChanges: () => programsController.hasUnsavedChanges(),
  open(program) {
    if (!isLanguageId(program.language)) return;
    playback.setPlaying(false);
    // A different program: start its picture afresh.
    memory.reset();
    loop.reset();
    if (program.language !== currentLanguage()) {
      app.setLanguage(program.language);
      showLanguageKind(LANGUAGES[program.language].kind);
      els.language.value = program.language;
      app.openShared(); // before the code changes, so the editor's change is seen as the link's
      editor.setLanguage(LANGUAGES[program.language].monacoId, program.code);
    } else {
      app.openShared();
      editor.setCode(program.code);
    }
    programsController.updateUI();
    routes.show(program.language, { replace: true });
    view.render();
  },
});

// SQL: Import CSV, a CSV file's table added to the program at the cursor.
new CsvImportController({
  button: els.importCsv,
  input: els.csvFile,
  setBanner,
  insert(sql) {
    const monacoEditor = editor.editor;
    const at = monacoEditor.getSelection();
    const model = monacoEditor.getModel();
    if (!at || !model) {
      editor.setCode(`${sql}\n${editor.getCode()}`);
      return;
    }
    // On lines of its own: after the cursor's line, or at the very top on line 1 with nothing before it.
    const line = at.startLineNumber;
    const lineText = model.getLineContent(line);
    const start = lineText.trim() ? { lineNumber: line, column: lineText.length + 1 } : { lineNumber: line, column: 1 };
    const text = lineText.trim() ? `\n\n${sql}` : sql;
    monacoEditor.executeEdits("import-csv", [
      {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: start.lineNumber,
          endColumn: start.column,
        },
        text,
      },
    ]);
    monacoEditor.focus();
  },
});

els.run.addEventListener("click", () => runNow());
installShortcuts({
  run: runNow,
  measure: () => {
    if (measurable()) void measure.measure();
  },
  save: () => programsController.save(),
  saveAs: () => programsController.saveAs(),
  dialogOpen: () => els.saveDialog.open,
  step: (event) => playback.handleKey(event),
});
// Where the windows go (stacked, side by side, or wherever they were dragged), the dividers, and windows folded to bars.
// Redrawn when the windows change shape: a very wide graph is drawn left to right in a tall window.
// Only once resizing pauses, and only for a new shape (see app/resizeRedraw.ts).
const layout = new LayoutController(
  els,
  settings,
  resizeRedraw({
    shape: () => `${isTall(els.memory)}|${isTall(els.loop)}`,
    redraw: () => {
      if (app.get().trace) view.render(false);
    },
  }),
);
// Windows moved by dragging their headers anywhere on the page (a wide screen only).
new WindowDocking({
  layout,
  announce: (text) => {
    els.announce.textContent = text;
  },
  reducedMotion: prefersReducedMotion,
  wide: () => matchMedia("(min-width: 821px) and (min-height: 501px)").matches,
});
// The windows' headers: one row each, with a ⋯ menu for the tools that don't fit.
toolsMenu(els.memoryTools, "More memory view tools");
toolsMenu(els.loopTools, "More loop history tools");
// On a phone: which one or two windows show (styles.css lays them out).
new MobileViewsController(els, settings.mobileViews);

view.render();
// pr0l1ne.com shows the address of the language it opened (pr0l1ne.com/python).
routes.start();
// Opened with a share link: show its program, and run nothing until asked. Otherwise run what's in the editor.
void shares.openFromLocation().then((opened) => {
  if (!opened) runNow();
});
// Canvas 2D or WebGL last time: switch to it once it has loaded (SVG draws until then).
const lastRenderer = settings.renderer.get();
if (lastRenderer !== "svg") {
  useRenderer(lastRenderer).catch((error: unknown) => {
    console.warn(`The ${lastRenderer} renderer couldn't start; drawing with SVG.`, error);
  });
}

// Everything is wired up: drop the loading skeleton from index.html.
document.documentElement.classList.remove("is-booting");
