/**
 * The app's entry point: creates the state, the editor and the controllers
 * (src/app/), and connects them. Each controller owns one part of the page
 * and reacts to the state itself; see docs/development.md, "How the app is
 * put together".
 */

import { prefersReducedMotion } from "./appearance";
import { SVG_RENDERERS } from "./render/svgRenderers";
import "./styles.css";
import { Banner, type BannerTone } from "./app/banner";
import { ComplexityController } from "./app/complexityController";
import { findElements } from "./app/elements";
import { escapeHtml } from "./app/html";
import { LayoutController } from "./app/layout";
import { LoopController } from "./app/loopController";
import { MeasureController } from "./app/measureController";
import { MemoryController } from "./app/memoryController";
import { PlaybackController } from "./app/playbackController";
import { ProgramsController } from "./app/programsController";
import { RendererSwitch } from "./app/rendererSwitch";
import { RunController } from "./app/runController";
import { addSaveSvg, svgFileName } from "./app/saveSvg";
import { installShortcuts } from "./app/shortcuts";
import { AppStore } from "./app/state";
import { StepView } from "./app/stepView";
import { StyleController } from "./app/styleController";
import { createEditor } from "./editor";
import { isLanguageId, LANGUAGES, type LanguageId } from "./languages";
import { ProgramStore } from "./programs";
import { createSettings, type RendererKind } from "./settings";

/** Everything remembered between visits (see settings.ts). */
const settings = createSettings();
const savedCode = (id: LanguageId) => settings.code(id).get() ?? LANGUAGES[id].examples[0].code;

// Saved programs, and the app's state (the language, the open program, the trace...).
const programs = new ProgramStore(settings.programStorage());
const app = new AppStore(settings, programs);
const currentLanguage = () => app.get().language;
const els = findElements();
// What draws the two windows (see scene/renderer.ts): SVG, or Canvas 2D
// (PixiJS), which is only downloaded when someone picks it. Windows start
// with SVG, which is ready at once, and switch once the canvas is.
const rendererSwitch = new RendererSwitch(
  {
    svg: () => SVG_RENDERERS,
    canvas: () => import("./render/canvas/canvasRenderers").then((m) => m.CANVAS_RENDERERS),
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

const banner = new Banner(els.banner, {
  run: () => runNow(),
  measure: () => void measure.measure(),
  reload: () => window.location.reload(),
});
const setBanner = (html: string | null, tone?: BannerTone) => banner.show(html, tone);

// ---------------------------------------------------------------- the editor

const editor = createEditor(
  els.editor,
  { monacoId: LANGUAGES[currentLanguage()].monacoId, code: savedCode(currentLanguage()) },
  {
    onChange(code) {
      playback.setPlaying(false);
      settings.code(currentLanguage()).set(code);
      programsController.updateUI();
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
      measure: () => measure.measure(),
      measureGrowth: () => measure.measureGrowth(),
      toggleNested: () => memory.toggleNested(),
    },
  },
);

// ---------------------------------------------------------------- stepping, running and drawing

const playback = new PlaybackController({
  app,
  els,
  stepCount: () => app.get().trace?.steps.length ?? 0,
  show: () => view.render(),
  ownsKeys: (target) => !!target.closest(".style-panel"),
  reducedMotion: prefersReducedMotion,
});

const runs = new RunController({
  app,
  status: els.status,
  editor,
  setBanner,
  onResult: (updateMarks) => view.render(updateMarks),
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
});
const loop: LoopController = new LoopController({
  app,
  renderers,
  settings,
  els,
  sizes: () => memory.sizes(),
  animation: () => style.animationFor("loop"),
  redraw: (updateMarks) => view.render(updateMarks),
});
const view = new StepView({ app, els, memory, loop, editor, updateControls: () => playback.updateControls() });
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
  onOpen: () => closePanelsBut("style"),
  rendering: { get: () => settings.renderer.get(), set: useRenderer },
});
const complexity = new ComplexityController({
  app,
  settings,
  els,
  editor,
  measurement: () => measure.current(),
  onOpen: () => closePanelsBut("complexity"),
});
const measure = new MeasureController({
  app,
  settings,
  runs,
  els,
  editor,
  setBanner,
  pause: () => playback.setPlaying(false),
  onMeasured: () => complexity.update(),
  onOpen: () => closePanelsBut("measure"),
});

function closePanelsBut(open: "style" | "complexity" | "measure"): void {
  for (const [name, panel] of Object.entries({ style, complexity, measure })) if (name !== open) panel.close();
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
  // The controllers catch up themselves (app.watch): the trace, Measure, the canvas, the Open menu...
  app.setLanguage(els.language.value);
  editor.setLanguage(LANGUAGES[currentLanguage()].monacoId, savedCode(currentLanguage()));
  programsController.updateUI(); // the unsaved-changes dot, for this language's code
  setBanner(null);
  view.render();
  runNow();
});

// ---------------------------------------------------------------- the rest of the page

els.run.addEventListener("click", () => runNow());
installShortcuts({
  run: runNow,
  measure: () => void measure.measure(),
  save: () => programsController.save(),
  saveAs: () => programsController.saveAs(),
  dialogOpen: () => els.saveDialog.open,
  step: (event) => playback.handleKey(event),
});
const layout = new LayoutController(els, settings);

view.render();
runNow();
// Canvas 2D last time: switch to it once it has loaded (SVG draws until then).
if (settings.renderer.get() === "canvas") {
  useRenderer("canvas").catch((error: unknown) => {
    console.warn("The canvas renderer couldn't start; drawing with SVG.", error);
  });
}

// Everything is wired up: drop the loading skeleton from index.html.
document.documentElement.classList.remove("is-booting");
