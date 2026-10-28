/**
 * `viz:` hints in the editor (the logic is hintAssist.ts):
 *
 * - Completions as you type a hint: the hints, then the program's own
 *   names (the lists, the whole numbers, the classes and their links), then
 *   graph options. Typing `viz:` (or a space after a hint's name) opens them.
 * - Hovers: what a hint, or a graph option, does.
 * - Notes under names a hint uses that weren't in the last run, and a
 *   misspelled hint, each with a quick fix to the likely name.
 * - On a loop's first line, the lightbulb offers a sliding window hint when
 *   the loop reads a list or string from two ends or slices it, put on its
 *   own line above the loop.
 * - "Add a Hint Above This Line" (the lightbulb, the right-click menu and
 *   the command palette) starts a hint above the cursor's line, with the
 *   list of hints open.
 */
import {
  type Completion,
  commentPrefix,
  completionsAt,
  emptyContext,
  type HintContext,
  type HintLanguage,
  hintLine,
  hintOnLine,
  keywordHover,
  keywordProblem,
  nameProblems,
  OPTION_DOCS,
  suggestionsFor,
} from "./hintAssist";
import type { monaco as Monaco } from "./monaco";
import { KEYWORDS } from "./trace/hints";

type MonacoNS = typeof Monaco;
type Editor = Monaco.editor.IStandaloneCodeEditor;

const LANGUAGES: HintLanguage[] = ["python", "javascript", "typescript"];
const OWNER = "algoviz-hint-names";
export const ADD_HINT_ACTION = "algoviz.addHint";

const isHintLanguage = (id: string): id is HintLanguage => (LANGUAGES as string[]).includes(id);

/** Wire hint help into an editor. Returns how to tell it what the program has (after each run). */
export function installHintAssist(monaco: MonacoNS, editor: Editor): { setContext(ctx: HintContext): void } {
  let ctx = emptyContext();
  const languageOf = (model: Monaco.editor.ITextModel) => {
    const id = model.getLanguageId();
    return isHintLanguage(id) ? id : null;
  };

  const kinds: Record<Completion["kind"], Monaco.languages.CompletionItemKind> = {
    keyword: monaco.languages.CompletionItemKind.Keyword,
    variable: monaco.languages.CompletionItemKind.Variable,
    class: monaco.languages.CompletionItemKind.Class,
    field: monaco.languages.CompletionItemKind.Field,
    option: monaco.languages.CompletionItemKind.EnumMember,
    snippet: monaco.languages.CompletionItemKind.Snippet,
  };

  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [":", " ", ",", "(", "["],
      provideCompletionItems(model, position) {
        const lang = languageOf(model);
        if (!lang) return { suggestions: [] };
        const line = model.getLineContent(position.lineNumber);
        const result = completionsAt(line, position.column - 1, lang, ctx);
        if (!result) return { suggestions: [] };
        const range = new monaco.Range(position.lineNumber, result.from + 1, position.lineNumber, position.column);
        return {
          suggestions: result.items.map((item, i) => ({
            label: item.label,
            kind: kinds[item.kind],
            insertText: item.insert,
            range,
            detail: item.detail,
            documentation: item.docs ? { value: item.docs } : undefined,
            sortText: `${item.preferred ? "0" : "1"}${String(i).padStart(4, "0")}`,
            command: item.retrigger ? { id: "editor.action.triggerSuggest", title: "More" } : undefined,
          })),
        };
      },
    });

    monaco.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        const lang = languageOf(model);
        if (!lang) return null;
        const line = model.getLineContent(position.lineNumber);
        const hint = hintOnLine(line, lang);
        if (!hint || position.column - 1 < hint.start) return null;
        const word = model.getWordAtPosition(position);
        if (!word) return null;
        const text = word.word.toLowerCase();
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const isFirstWord = line.slice(hint.start, word.startColumn - 1).trim() === "";
        if (isFirstWord && (KEYWORDS as readonly string[]).includes(text))
          return { range, contents: [{ value: keywordHover(text as (typeof KEYWORDS)[number]) }] };
        if (/^\s*graph\b/i.test(hint.text) && OPTION_DOCS[text])
          return { range, contents: [{ value: `**${text}**: ${OPTION_DOCS[text]}` }] };
        return null;
      },
    });

    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions(model, range, context) {
        const lang = languageOf(model);
        if (!lang) return { actions: [], dispose() {} };
        const actions: Monaco.languages.CodeAction[] = [];
        const lineNumber = range.startLineNumber;
        const line = model.getLineContent(lineNumber);

        // Quick fixes: a misspelled hint, or a name that isn't in the program.
        const fix = (from: number, to: number, text: string, title: string, marker?: Monaco.editor.IMarkerData) => {
          actions.push({
            title,
            kind: "quickfix",
            isPreferred: true,
            diagnostics: marker ? [marker] : undefined,
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: { range: new monaco.Range(lineNumber, from + 1, lineNumber, to + 1), text },
                },
              ],
            },
          });
        };
        const keyword = keywordProblem(line, lang);
        if (keyword?.suggestion) fix(keyword.from, keyword.to, keyword.suggestion, `Change to "${keyword.suggestion}"`);
        for (const p of nameProblems(line, lang, ctx)) {
          if (!p.suggestion) continue;
          const marker = context.markers.find((m) => m.startLineNumber === lineNumber && m.startColumn === p.from + 1);
          fix(p.from, p.to, p.suggestion, `Change "${p.name}" to "${p.suggestion}"`, marker);
        }

        // Hints worth adding, on their own line above this one.
        for (const s of suggestionsFor(model.getValue(), lineNumber, lang, ctx)) {
          actions.push({
            title: s.title,
            kind: "refactor.rewrite",
            edit: {
              edits: [
                {
                  resource: model.uri,
                  versionId: model.getVersionId(),
                  textEdit: {
                    range: new monaco.Range(s.line, 1, s.line, 1),
                    text: `${hintLine(s.hint, model.getLineContent(s.line), lang)}\n`,
                  },
                },
              ],
            },
          });
        }
        if (!hintOnLine(line, lang))
          actions.push({
            title: "Add a viz: hint above this line",
            kind: "refactor",
            command: { id: ADD_HINT_ACTION, title: "Add a viz: hint above this line", arguments: [lineNumber] },
          });
        return { actions, dispose() {} };
      },
    });
  }

  // Start a hint above the cursor's line (or the line a code action names), and open the list of hints.
  const addHint = (lineNumber?: number) => {
    const model = editor.getModel();
    const lang = model ? languageOf(model) : null;
    if (!model || !lang) return;
    const line = lineNumber ?? editor.getPosition()?.lineNumber ?? 1;
    const indent = /^\s*/.exec(model.getLineContent(line))![0];
    const text = `${indent}${commentPrefix(lang)} viz: `;
    editor.pushUndoStop();
    editor.executeEdits("algoviz-hint", [{ range: new monaco.Range(line, 1, line, 1), text: `${text}\n` }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: line, column: text.length + 1 });
    editor.focus();
    editor.trigger("algoviz-hint", "editor.action.triggerSuggest", {});
  };
  // A command, for the lightbulb; an action, for the right-click menu and the command palette.
  monaco.editor.registerCommand(ADD_HINT_ACTION, (_accessor, line: unknown) =>
    addHint(typeof line === "number" ? line : undefined),
  );
  editor.addAction({
    id: `${ADD_HINT_ACTION}.here`,
    label: "AlgoViz: Add a Hint Above This Line",
    contextMenuGroupId: "1_modification",
    run: () => addHint(),
  });

  // Notes under names that weren't in the last run, kept up to date as hints are typed.
  const check = () => {
    const model = editor.getModel();
    if (!model) return;
    const lang = languageOf(model);
    const markers: Monaco.editor.IMarkerData[] = [];
    if (lang) {
      for (let n = 1; n <= model.getLineCount(); n++) {
        const line = model.getLineContent(n);
        if (!hintOnLine(line, lang)) continue;
        for (const p of nameProblems(line, lang, ctx))
          markers.push({
            severity: monaco.MarkerSeverity.Info,
            message: p.message,
            startLineNumber: n,
            startColumn: p.from + 1,
            endLineNumber: n,
            endColumn: p.to + 1,
          });
      }
    }
    monaco.editor.setModelMarkers(model, OWNER, markers);
  };
  let timer = 0;
  editor.onDidChangeModelContent(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(check, 300);
  });
  editor.onDidChangeModel(() => {
    ctx = emptyContext(); // another language's program: its names come with its next run
    check();
  });

  return {
    setContext(next) {
      ctx = next;
      check();
    },
  };
}
