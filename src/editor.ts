/**
 * The code editor: Monaco (the editor inside VS Code) with syntax
 * highlighting, VS Code keybindings, and markers for "about to run",
 * "just ran" and "error".
 *
 * Each language gets its own Monaco model (like a separate open file in VS
 * Code), so switching languages keeps each one's text and undo history.
 */
import type { HintContext } from "./hintAssist";
import { installHintAssist } from "./hintEditor";
import { monaco } from "./monaco";

export interface LineMarks {
  next: number | null;
  prev: number | null;
  error: { line: number | null; message: string } | null;
}

/** Things the editor can trigger from keybindings and the command palette (F1). */
export interface EditorCommands {
  run(): void;
  save(): void;
  saveAs(): void;
  nextStep(): void;
  prevStep(): void;
  firstStep(): void;
  lastStep(): void;
  swapPanels(): void;
  toggleNested(): void;
  togglePlay(): void;
  playOrRewind(): void;
  measure(): void;
  measureGrowth(): void;
  /** Go to the next step at the cursor's line (`back`: the step before this one that's at it). */
  runToCursor(back: boolean): void;
}

export interface EditorHandle {
  editor: monaco.editor.IStandaloneCodeEditor;
  getCode(): string;
  /** Replace the whole document as one undoable edit. */
  setCode(code: string): void;
  /** Warn about `viz:` hints that couldn't be understood (squiggles). */
  setHintWarnings(warnings: { line: number; message: string }[]): void;
  /** What the last run's program has, for hint completions and notes (hintEditor.ts). */
  setHintContext(ctx: HintContext): void;
  /** Switch to the model for a language, creating it with `code` the first time. */
  setLanguage(monacoId: string, code: string): void;
  setMarks(marks: LineMarks): void;
  /** Complexity labels after loop headers and function definitions (empty to clear). */
  setCostLabels(labels: { line: number; text: string; hover: string; kind: "loop" | "function" }[]): void;
  /** Move the cursor to a line and show it. */
  revealLine(line: number): void;
  /** Measure's heat map: a tint and a count on each line that ran (empty to clear). */
  setMeasureLabels(labels: { line: number; text: string; hover: string; heat: number }[]): void;
  /**
   * Run to a line (app/seekController.ts): on, the gutter beside each line
   * has room for ◀ and ▶, shown on the line the pointer's over when a step
   * is at it; off, the gutter is as narrow as before.
   */
  setRunToLine(on: boolean): void;
  /**
   * The lines a step can be run to, each with whether there's a step at it
   * before this one (◀) and after (▶), and how many steps are at it. Null
   * when there are none (no trace, or the code changed since it ran).
   */
  setRunnable(lines: Map<number, RunnableLine> | null): void;
  /** Called when a line's ◀ (`back`) or ▶ is clicked. */
  onGutterClick(handler: (line: number, back: boolean) => void): void;
  /** A short message at a line, as VS Code says "Cannot edit in read-only editor". */
  showMessage(line: number, text: string): void;
  /**
   * Inputs run with another value (app/inputController.ts): the value as
   * written is dimmed (lines `from` to `to`), and a note after its first
   * line says what's run instead. Empty to clear.
   */
  setInputNotes(notes: { from: number; to: number; text: string; hover: string }[]): void;
}

/** A line a step can be run to: is there a step at it before this one, and after; how many steps are at it. */
export interface RunnableLine {
  back: boolean;
  next: boolean;
  steps: number;
}

/**
 * The gutter column beside the line numbers (Monaco's line decorations),
 * in pixels: the execution bars, then, with Run to line on, ◀ and ▶
 * (styles.css .run-to). Folding's arrows come after it.
 */
const DECORATIONS_WIDTH = 10;
const RUN_TO_WIDTH = 22;
/** Where ◀ and ▶ are clickable in that column. */
const BACK_ARROW = [8, 15];
const NEXT_ARROW = [15, 22];

const MARKER_OWNER = "algoviz";
const HINT_OWNER = "algoviz-hints";

monaco.editor.defineTheme("algoviz", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "9fb4ff" },
    { token: "type", foreground: "7fd1c2" },
    { token: "string", foreground: "e6a3d9" },
    { token: "string.escape", foreground: "f2c46d" },
    { token: "number", foreground: "f29e74" },
    { token: "comment", foreground: "6c7792", fontStyle: "italic" },
    { token: "delimiter", foreground: "a8b2c8" },
    { token: "tag", foreground: "f2c46d" }, // decorators
    { token: "type.identifier", foreground: "7fd1c2" }, // JavaScript class names
    { token: "regexp", foreground: "f2c46d" },
    { token: "identifier", foreground: "dde3ee" },
  ],
  colors: {
    "editor.background": "#1f2537",
    "editor.foreground": "#dde3ee",
    "editorGutter.background": "#1f2537",
    "editorLineNumber.foreground": "#5d6884",
    "editorLineNumber.activeForeground": "#c9d2e3",
    "editor.lineHighlightBackground": "#ffffff09",
    "editor.lineHighlightBorder": "#00000000",
    "editorCursor.foreground": "#f6d743",
    "editor.selectionBackground": "#7896dc55",
    "editor.inactiveSelectionBackground": "#7896dc30",
    "editorIndentGuide.background1": "#2c344b",
    "editorIndentGuide.activeBackground1": "#46506c",
    "editorWidget.background": "#232a3f",
    "editorWidget.border": "#343c55",
    "editorSuggestWidget.background": "#232a3f",
    "editorStickyScroll.background": "#1f2537",
    "scrollbarSlider.background": "#ffffff18",
    "scrollbarSlider.hoverBackground": "#ffffff28",
    focusBorder: "#f6d74380",
  },
});

/** A string as a CSS string literal. */
const cssString = (text: string) => `"${text.replace(/["\\]/g, "\\$&").replace(/\n/g, " ")}"`;

const FONT_FAMILY = `"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;

export function createEditor(
  parent: HTMLElement,
  initial: { monacoId: string; code: string },
  callbacks: { onChange(code: string): void; commands: EditorCommands },
): EditorHandle {
  const models = new Map<string, monaco.editor.ITextModel>();
  const modelFor = (monacoId: string, code: string) => {
    let model = models.get(monacoId);
    if (!model) {
      model = monaco.editor.createModel(code, monacoId);
      model.updateOptions({ tabSize: monacoId === "python" ? 4 : 2, insertSpaces: true });
      models.set(monacoId, model);
    }
    return model;
  };

  const editor = monaco.editor.create(parent, {
    model: modelFor(initial.monacoId, initial.code),
    theme: "algoviz",
    automaticLayout: true, // follow the resizable split
    fontFamily: FONT_FAMILY,
    fontSize: 14,
    lineHeight: 22,
    detectIndentation: false, // keep each model's tab size (Python 4, JavaScript 2)
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
    lineDecorationsWidth: DECORATIONS_WIDTH, // room for the execution bars (and ◀ ▶ with Run to line on)
    renderLineHighlight: "line",
    fixedOverflowWidgets: true, // let hovers and suggestions escape the pane
  });

  // Monaco measures character widths at startup. If the web font arrives
  // later, re-measure so the cursor lines up with the text.
  document.fonts?.ready.then(() => monaco.editor.remeasureFonts());

  const { KeyMod, KeyCode } = monaco;
  // Ctrl + ' means the Control key everywhere. In Monaco, CtrlCmd is Cmd on
  // a Mac, and WinCtrl is Control there (but the Windows key elsewhere).
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const CTRL = IS_MAC ? KeyMod.WinCtrl : KeyMod.CtrlCmd;
  const actions: [string, string, number[], () => void][] = [
    ["algoviz.run", "AlgoViz: Run", [CTRL | KeyCode.Quote], callbacks.commands.run],
    [
      "algoviz.measure",
      "AlgoViz: Measure at Full Size",
      [CTRL | KeyMod.Shift | KeyCode.Quote],
      callbacks.commands.measure,
    ],
    ["algoviz.measureGrowth", "AlgoViz: Measure Growth (at n/64, n/16, n/4, n)", [], callbacks.commands.measureGrowth],
    [
      "algoviz.playOrRewind",
      "AlgoViz: Play From Here / Back to Where Play Started",
      [KeyMod.CtrlCmd | KeyCode.Enter],
      callbacks.commands.playOrRewind,
    ],
    ["algoviz.save", "AlgoViz: Save Program", [KeyMod.CtrlCmd | KeyCode.KeyS], callbacks.commands.save],
    [
      "algoviz.saveAs",
      "AlgoViz: Save Program As…",
      [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS],
      callbacks.commands.saveAs,
    ],
    ["algoviz.nextStep", "AlgoViz: Next Step", [KeyCode.F10], callbacks.commands.nextStep],
    ["algoviz.prevStep", "AlgoViz: Previous Step", [KeyMod.Shift | KeyCode.F10], callbacks.commands.prevStep],
    ["algoviz.firstStep", "AlgoViz: First Step", [], callbacks.commands.firstStep],
    ["algoviz.lastStep", "AlgoViz: Last Step", [], callbacks.commands.lastStep],
    ["algoviz.swapPanels", "AlgoViz: Swap Editor and Canvas", [], callbacks.commands.swapPanels],
    ["algoviz.toggleNested", "AlgoViz: Toggle Nested Memory View", [], callbacks.commands.toggleNested],
    ["algoviz.togglePlay", "AlgoViz: Play / Pause", [], callbacks.commands.togglePlay],
    // As VS Code's Run to Cursor (Ctrl + F10), and back again.
    [
      "algoviz.runToCursor",
      "AlgoViz: Run to the Cursor's Line (the Next Step There)",
      [KeyMod.CtrlCmd | KeyCode.F10],
      () => callbacks.commands.runToCursor(false),
    ],
    [
      "algoviz.runBackToCursor",
      "AlgoViz: Back to the Cursor's Line (the Step Before This One There)",
      [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F10],
      () => callbacks.commands.runToCursor(true),
    ],
  ];
  for (const [id, label, keybindings, run] of actions) {
    editor.addAction({ id, label, keybindings, run: () => run() });
  }

  editor.onDidChangeModelContent(() => callbacks.onChange(editor.getValue()));
  // Help writing `viz:` hints: completions, hovers, quick fixes and suggestions.
  const hints = installHintAssist(monaco, editor);

  const decorations = editor.createDecorationsCollection();
  const costDecorations = editor.createDecorationsCollection();
  const costStyle = document.createElement("style");
  document.head.append(costStyle);
  const measureDecorations = editor.createDecorationsCollection();
  const inputDecorations = editor.createDecorationsCollection();
  const inputStyle = document.createElement("style");
  document.head.append(inputStyle);
  // Run to a line: ◀ ▶ beside the line the pointer's over, in the gutter's decorations column.
  const runToDecoration = editor.createDecorationsCollection();
  const gutterHandlers: ((line: number, back: boolean) => void)[] = [];
  let runToOn = false;
  let runnable: Map<number, RunnableLine> | null = null;
  let hoveredLine: number | null = null;
  /** Where a mouse event is in the gutter's decorations column, in pixels from its left, if it's there. */
  const inDecorations = (target: monaco.editor.IMouseTarget): number | null => {
    if (target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return null;
    const detail = target.detail as { offsetX?: number } | undefined;
    if (detail?.offsetX === undefined) return null;
    return detail.offsetX - editor.getLayoutInfo().decorationsLeft;
  };
  const showArrows = () => {
    const line = hoveredLine;
    const at = line !== null ? runnable?.get(line) : undefined;
    if (!runToOn || line === null || !at) {
      runToDecoration.clear();
      return;
    }
    runToDecoration.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: ["run-to", at.back && "has-back", at.next && "has-next"].filter(Boolean).join(" "),
          linesDecorationsTooltip: `◀ the step before this one at line ${line} · ▶ the next step at it (${at.steps.toLocaleString()} recorded ${at.steps === 1 ? "step is" : "steps are"} at this line)`,
        },
      },
    ]);
  };
  editor.onMouseMove((event) => {
    const line = event.target.position?.lineNumber ?? null;
    const inGutter =
      event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ||
      event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
    const next = runToOn && inGutter ? line : null;
    if (next === hoveredLine) return;
    hoveredLine = next;
    showArrows();
  });
  editor.onMouseLeave(() => {
    hoveredLine = null;
    showArrows();
  });
  // Only a click on ◀ or ▶ itself: not elsewhere in the gutter (folding's arrows, the line numbers).
  editor.onMouseDown((event) => {
    const x = inDecorations(event.target);
    const line = event.target.position?.lineNumber;
    if (!runToOn || x === null || !line || !event.event.leftButton) return;
    const at = runnable?.get(line);
    const back = x >= BACK_ARROW[0] && x < BACK_ARROW[1];
    const next = x >= NEXT_ARROW[0] && x < NEXT_ARROW[1];
    if (!at || !(back || next)) return;
    event.event.preventDefault();
    if (back ? !at.back : !at.next) return;
    for (const handler of gutterHandlers) handler(line, back);
  });
  const measureStyle = document.createElement("style");
  document.head.append(measureStyle);

  const lineDecoration = (line: number, kind: "next" | "prev" | "error", rulerColor: string) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: `exec-line-${kind}`,
      linesDecorationsClassName: `exec-bar-${kind}`,
      overviewRuler: { color: rulerColor, position: monaco.editor.OverviewRulerLane.Left },
    },
  });

  return {
    editor,
    getCode: () => editor.getValue(),
    setCode(code) {
      const model = editor.getModel();
      if (!model) return;
      editor.pushUndoStop();
      editor.executeEdits("algoviz", [{ range: model.getFullModelRange(), text: code }]);
      editor.pushUndoStop();
      editor.setPosition({ lineNumber: 1, column: 1 });
    },
    setLanguage(monacoId, code) {
      const previous = editor.getModel();
      const next = modelFor(monacoId, code);
      if (previous === next) return;
      if (previous) {
        monaco.editor.setModelMarkers(previous, MARKER_OWNER, []);
        monaco.editor.setModelMarkers(previous, HINT_OWNER, []);
      }
      editor.setModel(next); // also clears the execution decorations
    },
    setHintWarnings(warnings) {
      const model = editor.getModel();
      if (!model) return;
      monaco.editor.setModelMarkers(
        model,
        HINT_OWNER,
        warnings
          .filter((w) => w.line >= 1 && w.line <= model.getLineCount())
          .map((w) => ({
            severity: monaco.MarkerSeverity.Warning,
            message: w.message,
            startLineNumber: w.line,
            startColumn: model.getLineFirstNonWhitespaceColumn(w.line) || 1,
            endLineNumber: w.line,
            endColumn: model.getLineMaxColumn(w.line),
          })),
      );
    },
    setHintContext(ctx) {
      hints.setContext(ctx);
    },
    setCostLabels(labels) {
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getLineCount();
      // Each label is an ::after with its own class, its text set in a
      // stylesheet. (Monaco's injected text would be simpler, but this
      // trimmed-down build doesn't draw it.)
      const shown = labels.filter((l) => l.line >= 1 && l.line <= lines);
      costStyle.textContent = shown
        .map((l, i) => `.monaco-editor .cost-label-${i}::after { content: ${cssString(`  ${l.text}`)}; }`)
        .join("\n");
      costDecorations.set(
        shown.map((l, i) => {
          const end = model.getLineMaxColumn(l.line);
          return {
            range: new monaco.Range(l.line, Math.max(1, end - 1), l.line, end),
            options: {
              afterContentClassName: `cost-label cost-label-${l.kind} cost-label-${i}`,
              hoverMessage: { value: l.hover },
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          };
        }),
      );
    },
    setInputNotes(notes) {
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getLineCount();
      const shown = notes.filter((n) => n.from >= 1 && n.to <= lines && n.from <= n.to);
      inputStyle.textContent = shown
        .map((n, i) => `.monaco-editor .input-note-${i}::after { content: ${cssString(`  ${n.text}`)}; }`)
        .join("\n");
      inputDecorations.set(
        shown.flatMap((n, i) => {
          const end = model.getLineMaxColumn(n.from);
          return [
            {
              range: new monaco.Range(n.from, 1, n.to, model.getLineMaxColumn(n.to)),
              options: { className: "input-replaced", isWholeLine: true, hoverMessage: { value: n.hover } },
            },
            {
              range: new monaco.Range(n.from, Math.max(1, end - 1), n.from, end),
              options: {
                afterContentClassName: `input-note input-note-${i}`,
                hoverMessage: { value: n.hover },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            },
          ];
        }),
      );
    },
    setMeasureLabels(labels) {
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getLineCount();
      const shown = labels.filter((l) => l.line >= 1 && l.line <= lines);
      measureStyle.textContent = shown
        .map((l, i) => `.monaco-editor .measure-label-${i}::after { content: ${cssString(`  ${l.text}`)}; }`)
        .join("\n");
      measureDecorations.set(
        shown.flatMap((l, i) => {
          const end = model.getLineMaxColumn(l.line);
          return [
            {
              range: new monaco.Range(l.line, 1, l.line, 1),
              options: { isWholeLine: true, className: `heat-line heat-${l.heat}` },
            },
            {
              range: new monaco.Range(l.line, Math.max(1, end - 1), l.line, end),
              options: {
                afterContentClassName: `measure-label measure-label-${i}`,
                hoverMessage: { value: l.hover },
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            },
          ];
        }),
      );
    },
    setRunToLine(on) {
      runToOn = on;
      editor.updateOptions({ lineDecorationsWidth: on ? RUN_TO_WIDTH : DECORATIONS_WIDTH });
      showArrows();
    },
    setRunnable(lines) {
      runnable = lines;
      showArrows();
    },
    onGutterClick(handler) {
      gutterHandlers.push(handler);
    },
    showMessage(line, text) {
      const model = editor.getModel();
      if (!model || line < 1 || line > model.getLineCount()) return;
      const position = { lineNumber: line, column: model.getLineFirstNonWhitespaceColumn(line) || 1 };
      // Monaco's own inline message (MessageController), as for a read-only editor.
      const messages = editor.getContribution("editor.contrib.messageController") as {
        showMessage(message: string, position: { lineNumber: number; column: number }): void;
      } | null;
      if (messages) messages.showMessage(text, position);
    },
    revealLine(line) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: editor.getModel()?.getLineFirstNonWhitespaceColumn(line) || 1 });
      editor.focus();
    },
    setMarks({ next, prev, error }) {
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getLineCount();
      const valid = (line: number | null): line is number => line !== null && line >= 1 && line <= lines;

      const list: monaco.editor.IModelDeltaDecoration[] = [];
      // Yellow: the line that just ran (what the canvas is showing).
      // Blue: the line that runs next. When they're the same line (a loop
      // around a single statement), yellow wins.
      if (valid(next) && next !== prev) list.push(lineDecoration(next, "next", "#6f8fc9"));
      if (valid(prev)) list.push(lineDecoration(prev, "prev", "#f6d743"));
      if (error && valid(error.line)) list.push(lineDecoration(error.line, "error", "#ff6b61"));
      decorations.set(list);

      // Errors also become a real diagnostic: a squiggle with a hover message,
      // reachable with F8 like any VS Code problem.
      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        error && valid(error.line)
          ? [
              {
                severity: monaco.MarkerSeverity.Error,
                message: error.message,
                startLineNumber: error.line,
                startColumn: model.getLineFirstNonWhitespaceColumn(error.line) || 1,
                endLineNumber: error.line,
                endColumn: model.getLineMaxColumn(error.line),
              },
            ]
          : [],
      );

      // Follow execution, but don't move the view while someone is typing.
      const follow = valid(prev) ? prev : next;
      if (valid(follow) && !editor.hasTextFocus()) editor.revealLineInCenterIfOutsideViewport(follow);
    },
  };
}
