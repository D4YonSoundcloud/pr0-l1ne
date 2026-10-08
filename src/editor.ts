/**
 * The code editor: Monaco (the editor inside VS Code) with syntax
 * highlighting, VS Code keybindings, and markers for "about to run",
 * "just ran" and "error".
 *
 * Each language gets its own Monaco model (like a separate open file in VS
 * Code), so switching languages keeps each one's text and undo history.
 */
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
}

export interface EditorHandle {
  editor: monaco.editor.IStandaloneCodeEditor;
  getCode(): string;
  /** Replace the whole document as one undoable edit. */
  setCode(code: string): void;
  /** Warn about `viz:` hints that couldn't be understood (squiggles). */
  setHintWarnings(warnings: { line: number; message: string }[]): void;
  /** Switch to the model for a language, creating it with `code` the first time. */
  setLanguage(monacoId: string, code: string): void;
  setMarks(marks: LineMarks): void;
  /** Complexity labels after loop headers and function definitions (empty to clear). */
  setCostLabels(labels: { line: number; text: string; hover: string; kind: "loop" | "function" }[]): void;
  /** Move the cursor to a line and show it. */
  revealLine(line: number): void;
}

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
    "focusBorder": "#f6d74380",
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
    lineDecorationsWidth: 10, // room for the execution bars
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
    ["algoviz.playOrRewind", "AlgoViz: Play From Here / Back to Where Play Started", [KeyMod.CtrlCmd | KeyCode.Enter], callbacks.commands.playOrRewind],
    ["algoviz.save", "AlgoViz: Save Program", [KeyMod.CtrlCmd | KeyCode.KeyS], callbacks.commands.save],
    ["algoviz.saveAs", "AlgoViz: Save Program As…", [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS], callbacks.commands.saveAs],
    ["algoviz.nextStep", "AlgoViz: Next Step", [KeyCode.F10], callbacks.commands.nextStep],
    ["algoviz.prevStep", "AlgoViz: Previous Step", [KeyMod.Shift | KeyCode.F10], callbacks.commands.prevStep],
    ["algoviz.firstStep", "AlgoViz: First Step", [], callbacks.commands.firstStep],
    ["algoviz.lastStep", "AlgoViz: Last Step", [], callbacks.commands.lastStep],
    ["algoviz.swapPanels", "AlgoViz: Swap Editor and Canvas", [], callbacks.commands.swapPanels],
    ["algoviz.toggleNested", "AlgoViz: Toggle Nested Memory View", [], callbacks.commands.toggleNested],
    ["algoviz.togglePlay", "AlgoViz: Play / Pause", [], callbacks.commands.togglePlay],
  ];
  for (const [id, label, keybindings, run] of actions) {
    editor.addAction({ id, label, keybindings, run: () => run() });
  }

  editor.onDidChangeModelContent(() => callbacks.onChange(editor.getValue()));

  const decorations = editor.createDecorationsCollection();
  const costDecorations = editor.createDecorationsCollection();
  const costStyle = document.createElement("style");
  document.head.append(costStyle);

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
      monaco.editor.setModelMarkers(model, HINT_OWNER, warnings
        .filter((w) => w.line >= 1 && w.line <= model.getLineCount())
        .map((w) => ({
          severity: monaco.MarkerSeverity.Warning,
          message: w.message,
          startLineNumber: w.line,
          startColumn: model.getLineFirstNonWhitespaceColumn(w.line) || 1,
          endLineNumber: w.line,
          endColumn: model.getLineMaxColumn(w.line),
        })));
    },
    setCostLabels(labels) {
      const model = editor.getModel();
      if (!model) return;
      const lines = model.getLineCount();
      // Each label is an ::after with its own class, its text set in a
      // stylesheet. (Monaco's injected text would be simpler, but this
      // trimmed-down build doesn't draw it.)
      const shown = labels.filter((l) => l.line >= 1 && l.line <= lines);
      costStyle.textContent = shown.map((l, i) => `.monaco-editor .cost-label-${i}::after { content: ${cssString(`  ${l.text}`)}; }`).join("\n");
      costDecorations.set(shown.map((l, i) => {
        const end = model.getLineMaxColumn(l.line);
        return {
          range: new monaco.Range(l.line, Math.max(1, end - 1), l.line, end),
          options: {
            afterContentClassName: `cost-label cost-label-${l.kind} cost-label-${i}`,
            hoverMessage: { value: l.hover },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        };
      }));
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
      monaco.editor.setModelMarkers(model, MARKER_OWNER, error && valid(error.line) ? [{
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: error.line,
        startColumn: model.getLineFirstNonWhitespaceColumn(error.line) || 1,
        endLineNumber: error.line,
        endColumn: model.getLineMaxColumn(error.line),
      }] : []);

      // Follow execution, but don't move the view while someone is typing.
      const follow = valid(prev) ? prev : next;
      if (valid(follow) && !editor.hasTextFocus()) editor.revealLineInCenterIfOutsideViewport(follow);
    },
  };
}
